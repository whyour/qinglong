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
} from '../data/system';
import { NotificationInfo } from '../data/notify';
import NotificationService from './notify';
import { Request } from 'express';
import ScheduleService from './schedule';
import SockService from './sock';
import dayjs from 'dayjs';
import IP2Region from 'ip2region';
import requestIp from 'request-ip';
import uniq from 'lodash/uniq';
import pickBy from 'lodash/pickBy';
import isNil from 'lodash/isNil';
import { shareStore } from '../shared/store';

@Service()
export default class UserService {
  @Inject((type) => NotificationService)
  private notificationService!: NotificationService;

  constructor(
    @Inject('logger') private logger: winston.Logger,
    private scheduleService: ScheduleService,
    private sockService: SockService,
  ) {}

  public async login(
    payloads: {
      username: string;
      password: string;
    },
    req: Request,
    needTwoFactor = true,
  ): Promise<any> {
    let { username, password } = payloads;
    const content = await this.getAuthInfo();
    const timestamp = Date.now();
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
    } = content;
    const retriesTime = Math.pow(3, retries) * 1000;
    if (retries > 2 && timestamp - lastlogon < retriesTime) {
      const waitTime = Math.ceil(
        (retriesTime - (timestamp - lastlogon)) / 1000,
      );
      return {
        code: 410,
        message: `失败次数过多，请${waitTime}秒后重试`,
        data: waitTime,
      };
    }

    if (
      username === cUsername &&
      password === cPassword &&
      twoFactorActivated &&
      needTwoFactor
    ) {
      await this.updateAuthInfo(content, {
        isTwoFactorChecking: true,
      });
      return {
        code: 420,
        message: '',
      };
    }

    const ip = requestIp.getClientIp(req) || '';
    const query = new IP2Region();
    const ipAddress = query.search(ip);
    let address = '';
    if (ipAddress) {
      const { country, province, city, isp } = ipAddress;
      address = uniq([country, province, city, isp]).filter(Boolean).join(' ');
    }
    if (username === cUsername && password === cPassword) {
      const data = createRandomString(50, 100);
      const expiration = twoFactorActivated ? '60d' : '20d';
      let token = jwt.sign({ data }, config.jwt.secret, {
        expiresIn: config.jwt.expiresIn || expiration,
        algorithm: 'HS384',
      });

      await this.updateAuthInfo(content, {
        token,
        tokens: {
          ...tokens,
          [req.platform]: token,
        },
        lastlogon: timestamp,
        retries: 0,
        lastip: ip,
        lastaddr: address,
        platform: req.platform,
        isTwoFactorChecking: false,
      });
      this.notificationService.notify(
        '登录通知',
        `你于${dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss')}在 ${address} ${
          req.platform
        }端 登录成功，ip地址 ${ip}`,
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
        '登录通知',
        `你于${dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss')}在 ${address} ${
          req.platform
        }端 登录失败，ip地址 ${ip}`,
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
          message: `失败次数过多，请${waitTime}秒后重试`,
          data: waitTime,
        };
      } else {
        return { code: 400, message: config.authError };
      }
    }
  }

  public async logout(platform: string): Promise<any> {
    const authInfo = await this.getAuthInfo();
    await this.updateAuthInfo(authInfo, {
      token: '',
      tokens: { ...authInfo.tokens, [platform]: '' },
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

  private async insertDb(payload: SystemInfo): Promise<SystemInfo> {
    const doc = await SystemModel.create({ ...payload }, { returning: true });
    return doc;
  }

  public async updateUsernameAndPassword({
    username,
    password,
  }: {
    username: string;
    password: string;
  }) {
    if (password === 'admin') {
      return { code: 400, message: '密码不能设置为admin' };
    }
    const authInfo = await this.getAuthInfo();
    await this.updateAuthInfo(authInfo, { username, password });
    return { code: 200, message: '更新成功' };
  }

  public async updateAvatar(avatar: string) {
    const authInfo = await this.getAuthInfo();
    await this.updateAuthInfo(authInfo, { avatar });
    return { code: 200, data: avatar, message: '更新成功' };
  }

  public async initTwoFactor() {
    const secret = authenticator.generateSecret();
    const authInfo = await this.getAuthInfo();
    const otpauth = authenticator.keyuri(authInfo.username, 'qinglong', secret);
    await this.updateAuthInfo(authInfo, { twoFactorSecret: secret });
    return { secret, url: otpauth };
  }

  public async activeTwoFactor(code: string) {
    const authInfo = await this.getAuthInfo();
    const isValid = authenticator.verify({
      token: code,
      secret: authInfo.twoFactorSecret,
    });
    if (isValid) {
      await this.updateAuthInfo(authInfo, { twoFactorActivated: true });
    }
    return isValid;
  }

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
    if (!isTwoFactorChecking) {
      return { code: 450, message: '未知错误' };
    }
    const isValid = authenticator.verify({
      token: code,
      secret: twoFactorSecret,
    });
    if (isValid) {
      return this.login({ username, password }, req, false);
    } else {
      const ip = requestIp.getClientIp(req) || '';
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
        lastip: ip,
        lastaddr: address,
        platform: req.platform,
      });
      return { code: 430, message: '验证失败' };
    }
  }

  public async deactiveTwoFactor() {
    const authInfo = await this.getAuthInfo();
    await this.updateAuthInfo(authInfo, {
      twoFactorActivated: false,
      twoFactorSecret: '',
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
      '青龙',
      `【蛟龙】测试通知 https://t.me/jiao_long`,
    );
    if (isSuccess) {
      const result = await this.updateAuthDb({
        type: AuthDataType.notification,
        info: { ...notificationInfo },
      });
      return { code: 200, data: { ...result, code } };
    } else {
      return { code: 400, message: '通知发送失败，请检查参数' };
    }
  }

  public async resetAuthInfo(info: Partial<AuthInfo>) {
    const { retries, twoFactorActivated, password, username } = info;
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

    await this.updateAuthInfo(authInfo, payload);
  }
}
