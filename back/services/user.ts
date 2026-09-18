import { Service, Inject } from 'typedi';
import winston from 'winston';
import { createRandomString } from '../config/util';
import config from '../config';
import jwt from 'jsonwebtoken';
import { authenticator } from '@otplib/preset-default';
import {
  AuthDataType,
  SystemInfo,
  SystemModel,
  SystemModelInfo,
  LoginStatus,
  AuthInfo,
  TokenInfo,
} from '../data/system';
import { NotificationInfo } from '../data/notify';
import NotificationService from './notify';
import { Request } from 'express';
import ScheduleService from './schedule';
import SockService from './sock';
import dayjs from 'dayjs';
import IP2Region from 'ip2region';
import uniq from 'lodash/uniq';
import pickBy from 'lodash/pickBy';
import isNil from 'lodash/isNil';
import { shareStore } from '../shared/store';
import { t, tf } from '../shared/i18n';
import { getClientIp, normalizeClientIp } from '../shared/clientIp';
import { isDefaultAuthInfo } from '../shared/auth';
import {
  hashPassword,
  isPasswordHash,
  verifyPassword,
} from '../shared/password';
import { serializeAuthMutation } from '../shared/authMutation';

@Service()
export default class UserService {
  @Inject((type) => NotificationService)
  private notificationService!: NotificationService;

  constructor(
    @Inject('logger') private logger: winston.Logger,
    private scheduleService: ScheduleService,
    private sockService: SockService,
  ) {}

  @serializeAuthMutation
  public async login(
    payloads: { username: string; password: string },
    req: Request,
  ): Promise<any> {
    return this.authenticate(payloads, req);
  }

  private async authenticate(
    payloads: {
      username: string;
      password: string;
    },
    req: Request,
    needTwoFactor = true,
  ): Promise<any> {
    let { username, password } = payloads;
    const content = await this.getAuthInfo();
    if (isDefaultAuthInfo(content)) {
      return { code: 450, message: t('请先初始化') };
    }
    const timestamp = Date.now();
    const ip = getClientIp(req);
    const query = new IP2Region();
    const ipAddress = query.search(ip);
    let address = '';
    if (ipAddress) {
      const { country, province, city, isp } = ipAddress;
      address = uniq([country, province, city, isp]).filter(Boolean).join(' ');
    }
    let {
      username: cUsername,
      password: cPassword,
      retries = 0,
      lastlogon,
      lastip,
      lastaddr,
      twoFactorActivated,
      tokens = {},
      platform,
      blockedIps = [],
    } = content;

    if (
      ip &&
      blockedIps.some((blockedIp) => normalizeClientIp(blockedIp) === ip)
    ) {
      await this.insertDb({
        type: AuthDataType.loginLog,
        info: {
          timestamp,
          address,
          ip,
          platform: req.platform,
          status: LoginStatus.fail,
        },
      });
      this.getLoginLog();
      return { code: 403, message: t('该 IP 已被列入黑名单') };
    }

    const retriesTime = Math.pow(3, retries) * 1000;
    if (retries > 2 && timestamp - lastlogon < retriesTime) {
      const waitTime = Math.ceil(
        (retriesTime - (timestamp - lastlogon)) / 1000,
      );
      return {
        code: 410,
        message: tf('失败次数过多，请%s秒后重试', waitTime),
        data: waitTime,
      };
    }

    const passwordMatches =
      username === cUsername && (await verifyPassword(password, cPassword));

    if (passwordMatches && twoFactorActivated && needTwoFactor) {
      await this.updateAuthInfo(content, {
        isTwoFactorChecking: true,
        twoFactorExpiresAt: timestamp + 5 * 60 * 1000,
      });
      return {
        code: 420,
        message: '',
      };
    }

    if (passwordMatches) {
      const data = createRandomString(50, 100);
      const expiration = twoFactorActivated ? '60d' : '20d';
      let token = jwt.sign({ data }, config.jwt.secret, {
        expiresIn: config.jwt.expiresIn || expiration,
        algorithm: 'HS384',
      });

      const tokenInfo: TokenInfo = {
        value: token,
        timestamp,
        ip,
        address,
        platform: req.platform,
      };

      const updatedTokens = this.addTokenToList(
        tokens,
        req.platform,
        tokenInfo,
      );

      await this.updateAuthInfo(content, {
        password: isPasswordHash(cPassword)
          ? cPassword
          : await hashPassword(password),
        token,
        tokens: updatedTokens,
        lastlogon: timestamp,
        retries: 0,
        lastip: ip,
        lastaddr: address,
        platform: req.platform,
        isTwoFactorChecking: false,
        twoFactorExpiresAt: 0,
      });
      this.notificationService.notify(
        t('登录通知'),
        t('你于') +
          dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss') +
          t('在') +
          address +
          ' ' +
          req.platform +
          t('端') +
          ' ' +
          t('登录成功') +
          t('，ip地址') +
          ' ' +
          ip,
      );
      await this.insertDb({
        type: AuthDataType.loginLog,
        info: {
          timestamp,
          address,
          ip,
          platform: req.platform,
          status: LoginStatus.success,
        },
      });
      this.getLoginLog();
      return {
        code: 200,
        data: {
          token,
          lastip,
          lastaddr,
          lastlogon,
          retries,
          platform,
        },
      };
    } else {
      await this.updateAuthInfo(content, {
        retries: retries + 1,
        lastlogon: timestamp,
        lastip: ip,
        lastaddr: address,
        platform: req.platform,
      });
      this.notificationService.notify(
        t('登录通知'),
        t('你于') +
          dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss') +
          t('在') +
          address +
          ' ' +
          req.platform +
          t('端') +
          ' ' +
          t('登录失败') +
          t('，ip地址') +
          ' ' +
          ip,
      );
      await this.insertDb({
        type: AuthDataType.loginLog,
        info: {
          timestamp,
          address,
          ip,
          platform: req.platform,
          status: LoginStatus.fail,
        },
      });
      this.getLoginLog();
      if (retries > 2) {
        const waitTime = Math.round(Math.pow(3, retries + 1));
        return {
          code: 410,
          message: tf('失败次数过多，请%s秒后重试', waitTime),
          data: waitTime,
        };
      } else {
        return { code: 400, message: t('错误的用户名密码，请重试') };
      }
    }
  }

  @serializeAuthMutation
  public async logout(platform: string, tokenValue: string): Promise<any> {
    if (!platform || !tokenValue) {
      this.logger.warn('Invalid logout parameters - empty platform or token');
      return;
    }

    const authInfo = await this.getAuthInfo();

    // Verify the token exists before attempting to remove it
    const tokenExists = this.findTokenInList(
      authInfo.tokens,
      platform,
      tokenValue,
    );
    if (!tokenExists && authInfo.token !== tokenValue) {
      // Token not found, but don't throw error - user may have already logged out
      this.logger.info(
        `Logout attempted for non-existent token on platform: ${platform}`,
      );
      return;
    }

    const updatedTokens = this.removeTokenFromList(
      authInfo.tokens,
      platform,
      tokenValue,
    );

    await this.updateAuthInfo(authInfo, {
      token: authInfo.token === tokenValue ? '' : authInfo.token,
      tokens: updatedTokens,
    });
  }

  public async getLoginLog(): Promise<Array<SystemModelInfo | undefined>> {
    const docs = await SystemModel.findAll({
      where: { type: AuthDataType.loginLog },
    });
    if (docs && docs.length > 0) {
      const result = docs.sort(
        (a, b) => b.info!.timestamp! - a.info!.timestamp!,
      );
      if (result.length > 100) {
        const ids = result.slice(100).map((x) => x.id!);
        await SystemModel.destroy({
          where: { id: ids },
        });
      }
      return result.map((x) => x.info);
    }
    return [];
  }

  public async getIpBlacklist(): Promise<string[]> {
    const authInfo = await this.getAuthInfo();
    return uniq((authInfo.blockedIps || []).map(normalizeClientIp)).filter(
      Boolean,
    );
  }

  @serializeAuthMutation
  public async blockIp(ip: string): Promise<string[]> {
    const authInfo = await this.getAuthInfo();
    const blockedIps = uniq([
      ...(authInfo.blockedIps || []).map(normalizeClientIp),
      normalizeClientIp(ip),
    ]).filter(Boolean);
    await this.updateAuthInfo(authInfo, { blockedIps });
    return blockedIps;
  }

  @serializeAuthMutation
  public async unblockIp(ip: string): Promise<string[]> {
    const authInfo = await this.getAuthInfo();
    const normalizedIp = normalizeClientIp(ip);
    const blockedIps = (authInfo.blockedIps || [])
      .map(normalizeClientIp)
      .filter((blockedIp) => blockedIp && blockedIp !== normalizedIp);
    await this.updateAuthInfo(authInfo, { blockedIps });
    return blockedIps;
  }

  private async insertDb(payload: SystemInfo): Promise<SystemInfo> {
    const doc = await SystemModel.create({ ...payload }, { returning: true });
    return doc;
  }

  @serializeAuthMutation
  public async initializeUser({
    username,
    password,
  }: {
    username: string;
    password: string;
  }) {
    const authInfo = await this.getAuthInfo();
    if (!isDefaultAuthInfo(authInfo)) {
      return { code: 450, message: t('未知错误') };
    }
    if (password === 'admin') {
      return { code: 400, message: t('密码不能设置为admin') };
    }
    await this.updateAuthInfo(authInfo, {
      username,
      password: await hashPassword(password),
      token: '',
      tokens: {},
      isTwoFactorChecking: false,
      twoFactorExpiresAt: 0,
    });
    return { code: 200, message: t('更新成功') };
  }

  @serializeAuthMutation
  public async updateUsernameAndPassword({
    username,
    password,
  }: {
    username: string;
    password: string;
  }) {
    if (password === 'admin') {
      return { code: 400, message: t('密码不能设置为admin') };
    }
    const authInfo = await this.getAuthInfo();
    await this.updateAuthInfo(authInfo, {
      username,
      password: await hashPassword(password),
      token: '',
      tokens: {},
      isTwoFactorChecking: false,
      twoFactorExpiresAt: 0,
    });
    return { code: 200, message: t('更新成功') };
  }

  @serializeAuthMutation
  public async updateAvatar(avatar: string) {
    const authInfo = await this.getAuthInfo();
    await this.updateAuthInfo(authInfo, { avatar });
    return { code: 200, data: avatar, message: t('更新成功') };
  }

  @serializeAuthMutation
  public async initTwoFactor() {
    const secret = authenticator.generateSecret();
    const authInfo = await this.getAuthInfo();
    if (authInfo.twoFactorActivated) {
      throw new Error(t('请先关闭两步验证'));
    }
    const otpauth = authenticator.keyuri(authInfo.username, 'qinglong', secret);
    await this.updateAuthInfo(authInfo, { twoFactorSecret: secret });
    return { secret, url: otpauth };
  }

  @serializeAuthMutation
  public async activeTwoFactor(code: string) {
    const authInfo = await this.getAuthInfo();
    const isValid = authenticator.verify({
      token: code,
      secret: authInfo.twoFactorSecret,
    });
    if (isValid) {
      await this.updateAuthInfo(authInfo, {
        twoFactorActivated: true,
        token: '',
        tokens: {},
        isTwoFactorChecking: false,
        twoFactorExpiresAt: 0,
      });
    }
    return isValid;
  }

  @serializeAuthMutation
  public async twoFactorLogin(
    {
      username,
      password,
      code,
    }: { username: string; password: string; code: string },
    req: any,
  ) {
    const authInfo = await this.getAuthInfo();
    const { isTwoFactorChecking, twoFactorSecret } = authInfo;
    const now = Date.now();
    const retries = authInfo.retries || 0;
    if (retries > 2 && now - authInfo.lastlogon < Math.pow(3, retries) * 1000) {
      return { code: 410, message: t('失败次数过多，请稍后重试') };
    }
    if (
      !isTwoFactorChecking ||
      !authInfo.twoFactorActivated ||
      !authInfo.twoFactorExpiresAt ||
      authInfo.twoFactorExpiresAt <= now
    ) {
      return { code: 450, message: t('未知错误') };
    }
    const step = Math.floor(now / 30000);
    const isValid =
      username === authInfo.username &&
      (await verifyPassword(password, authInfo.password)) &&
      authInfo.lastTwoFactorStep !== step &&
      authenticator.verify({ token: code, secret: twoFactorSecret });
    if (isValid) {
      await this.updateAuthInfo(authInfo, { lastTwoFactorStep: step });
      return this.authenticate({ username, password }, req, false);
    } else {
      const ip = getClientIp(req);
      const query = new IP2Region();
      const ipAddress = query.search(ip);
      let address = '';
      if (ipAddress) {
        const { country, province, city, isp } = ipAddress;
        address = uniq([country, province, city, isp])
          .filter(Boolean)
          .join(' ');
      }
      await this.updateAuthInfo(authInfo, {
        retries: retries + 1,
        lastlogon: now,
        isTwoFactorChecking: retries + 1 < 5,
        lastip: ip,
        lastaddr: address,
        platform: req.platform,
      });
      return { code: 430, message: t('验证失败') };
    }
  }

  @serializeAuthMutation
  public async deactivateTwoFactor() {
    const authInfo = await this.getAuthInfo();
    await this.updateAuthInfo(authInfo, {
      twoFactorActivated: false,
      twoFactorSecret: '',
      token: '',
      tokens: {},
      isTwoFactorChecking: false,
      twoFactorExpiresAt: 0,
    });
    return true;
  }

  public async getAuthInfo() {
    const authInfo = await shareStore.getAuthInfo();
    if (authInfo) {
      return authInfo;
    }
    const doc = await this.getDb({ type: AuthDataType.authConfig });
    return (doc.info || {}) as AuthInfo;
  }

  private async updateAuthInfo(authInfo: AuthInfo, info: Partial<AuthInfo>) {
    const result = { ...authInfo, ...info };
    await shareStore.updateAuthInfo(result);
    await this.updateAuthDb({
      type: AuthDataType.authConfig,
      info: result,
    });
    if (info.tokens && Object.keys(info.tokens).length === 0) {
      this.sockService.getClients().forEach((conn) => conn.close('401'));
    }
  }

  public async getNotificationMode(): Promise<NotificationInfo> {
    const doc = await this.getDb({ type: AuthDataType.notification });
    return (doc.info || {}) as NotificationInfo;
  }

  private async updateAuthDb(payload: SystemInfo): Promise<any> {
    let doc = await SystemModel.findOne({ where: { type: payload.type } });
    if (doc) {
      const updateResult = await SystemModel.update(payload, {
        where: { id: doc.id },
        returning: true,
      });
      doc = updateResult[1][0];
    } else {
      doc = await SystemModel.create(payload, { returning: true });
    }
    return doc;
  }

  public async getDb(query: any): Promise<SystemInfo> {
    const doc = await SystemModel.findOne({ where: { ...query } });
    if (!doc) {
      throw new Error(`${JSON.stringify(query)} not found`);
    }
    return doc.get({ plain: true });
  }

  public async updateNotificationMode(notificationInfo: NotificationInfo) {
    const code = Math.random().toString().slice(-6);
    const isSuccess = await this.notificationService.testNotify(
      notificationInfo,
      t('青龙'),
      t('【蛟龙】测试通知 https://t.me/jiao_long'),
    );
    if (isSuccess) {
      const result = await this.updateAuthDb({
        type: AuthDataType.notification,
        info: { ...notificationInfo },
      });
      return { code: 200, data: { ...result, code } };
    } else {
      return { code: 400, message: t('通知发送失败，请检查参数') };
    }
  }

  private normalizeTokens(
    tokens: Record<string, string | TokenInfo[]>,
  ): Record<string, TokenInfo[]> {
    const normalized: Record<string, TokenInfo[]> = {};

    for (const [platform, value] of Object.entries(tokens)) {
      if (typeof value === 'string') {
        // Legacy format: convert string token to TokenInfo array
        if (value) {
          normalized[platform] = [
            {
              value,
              timestamp: Date.now(),
              ip: '',
              address: '',
              platform,
            },
          ];
        } else {
          normalized[platform] = [];
        }
      } else {
        // Already in new format
        normalized[platform] = value || [];
      }
    }

    return normalized;
  }

  private addTokenToList(
    tokens: Record<string, string | TokenInfo[]>,
    platform: string,
    tokenInfo: TokenInfo,
    maxTokensPerPlatform: number = config.maxTokensPerPlatform,
  ): Record<string, TokenInfo[]> {
    // Validate maxTokensPerPlatform parameter
    if (!Number.isInteger(maxTokensPerPlatform) || maxTokensPerPlatform < 1) {
      this.logger.warn(
        `Invalid maxTokensPerPlatform value: ${maxTokensPerPlatform}, using default`,
      );
      maxTokensPerPlatform = config.maxTokensPerPlatform;
    }

    const normalized = this.normalizeTokens(tokens);

    if (!normalized[platform]) {
      normalized[platform] = [];
    }

    // Add new token
    normalized[platform].unshift(tokenInfo);

    // Limit the number of active tokens per platform
    if (normalized[platform].length > maxTokensPerPlatform) {
      normalized[platform] = normalized[platform].slice(
        0,
        maxTokensPerPlatform,
      );
    }

    return normalized;
  }

  private removeTokenFromList(
    tokens: Record<string, string | TokenInfo[]>,
    platform: string,
    tokenValue: string,
  ): Record<string, TokenInfo[]> {
    const normalized = this.normalizeTokens(tokens);

    if (normalized[platform]) {
      normalized[platform] = normalized[platform].filter(
        (t) => t.value !== tokenValue,
      );
    }

    return normalized;
  }

  private findTokenInList(
    tokens: Record<string, string | TokenInfo[]>,
    platform: string,
    tokenValue: string,
  ): TokenInfo | undefined {
    const normalized = this.normalizeTokens(tokens);

    if (normalized[platform]) {
      return normalized[platform].find((t) => t.value === tokenValue);
    }

    return undefined;
  }

  @serializeAuthMutation
  public async resetAuthInfo(info: Partial<AuthInfo>) {
    const { retries, twoFactorActivated, password, username } = info;
    if (password === 'admin') {
      return { code: 400, message: t('密码不能设置为admin') };
    }
    const authInfo = await this.getAuthInfo();
    const payload = pickBy(
      {
        retries,
        twoFactorActivated,
        password,
        username,
      },
      (x) => !isNil(x),
    );

    if (password !== undefined) {
      payload.password = await hashPassword(password);
    }
    if (
      password !== undefined ||
      username !== undefined ||
      twoFactorActivated !== undefined
    ) {
      Object.assign(payload, {
        token: '',
        tokens: {},
        isTwoFactorChecking: false,
        twoFactorExpiresAt: 0,
      });
    }
    await this.updateAuthInfo(authInfo, payload);
  }
}
