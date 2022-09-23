import { Service, Inject } from 'typedi';
import winston from 'winston';
import { createRandomString, getNetIp, getPlatform } from '../config/util';
import config from '../config';
import * as fs from 'fs';
import _ from 'lodash';
import jwt from 'jsonwebtoken';
import { authenticator } from '@otplib/preset-default';
import { AuthDataType, AuthInfo, AuthModel, LoginStatus } from '../data/auth';
import { NotificationInfo } from '../data/notify';
import NotificationService from './notify';
import { Request } from 'express';
import ScheduleService from './schedule';
import { spawn } from 'child_process';
import SockService from './sock';
import dayjs from 'dayjs';

@Service()
export default class UserService {
  @Inject((type) => NotificationService)
  private notificationService!: NotificationService;

  constructor(
    @Inject('logger') private logger: winston.Logger,
    private scheduleService: ScheduleService,
    private sockService: SockService,
  ) { }

  public async login(
    payloads: {
      username: string;
      password: string;
    },
    req: Request,
    needTwoFactor = true,
  ): Promise<any> {
    if (!fs.existsSync(config.authConfigFile)) {
      return this.initAuthInfo();
    }

    let { username, password } = payloads;
    const content = this.getAuthInfo();
    const timestamp = Date.now();
    if (content) {
      let {
        username: cUsername,
        password: cPassword,
        retries = 0,
        lastlogon,
        lastip,
        lastaddr,
        twoFactorActivated,
        twoFactorActived,
        tokens = {},
        platform,
      } = content;
      // patch old field
      twoFactorActivated = twoFactorActivated || twoFactorActived;

      if (
        (cUsername === 'admin' && cPassword === 'admin') ||
        !cUsername ||
        !cPassword
      ) {
        return this.initAuthInfo();
      }

      const retriesTime = Math.pow(3, retries) * 1000;
      if (retries > 2 && timestamp - lastlogon < retriesTime) {
        const waitTime = Math.ceil((retriesTime - (timestamp - lastlogon)) / 1000);
        return {
          code: 410,
          message: `失败次数过多，请${waitTime}秒后重试`,
          data: waitTime,
        };
      }

      const { ip, address } = await getNetIp(req);
      if (username === cUsername && password === cPassword) {
        if (twoFactorActivated && needTwoFactor) {
          this.updateAuthInfo(content, {
            isTwoFactorChecking: true,
          });
          return {
            code: 420,
            message: '',
          };
        }

        const data = createRandomString(50, 100);
        const expiration = twoFactorActivated ? 60 : 20;
        let token = jwt.sign({ data }, config.secret as any, {
          expiresIn: 60 * 60 * 24 * expiration,
          algorithm: 'HS384',
        });

        this.updateAuthInfo(content, {
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
        await this.notificationService.notify(
          '登录通知',
          `你于${dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss')}在 ${address} ${req.platform
          }端 登录成功，ip地址 ${ip}`,
        );
        await this.getLoginLog();
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
        return {
          code: 200,
          data: { token, lastip, lastaddr, lastlogon, retries, platform },
        };
      } else {
        this.updateAuthInfo(content, {
          retries: retries + 1,
          lastlogon: timestamp,
          lastip: ip,
          lastaddr: address,
          platform: req.platform,
        });
        await this.notificationService.notify(
          '登录通知',
          `你于${dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss')}在 ${address} ${req.platform
          }端 登录失败，ip地址 ${ip}`,
        );
        await this.getLoginLog();
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
    } else {
      return this.initAuthInfo();
    }
  }

  public async logout(platform: string): Promise<any> {
    const authInfo = this.getAuthInfo();
    this.updateAuthInfo(authInfo, {
      token: '',
      tokens: { ...authInfo.tokens, [platform]: '' },
    });
  }

  public async getLoginLog(): Promise<AuthInfo[]> {
    const docs = await AuthModel.findAll({
      where: { type: AuthDataType.loginLog },
    });
    if (docs && docs.length > 0) {
      const result = docs.sort((a, b) => b.info.timestamp - a.info.timestamp);
      if (result.length > 100) {
        await AuthModel.destroy({
          where: { id: result[result.length - 1].id },
        });
      }
      return result.map((x) => x.info);
    }
    return [];
  }

  private async insertDb(payload: AuthInfo): Promise<AuthInfo> {
    const doc = await AuthModel.create({ ...payload }, { returning: true });
    return doc;
  }

  private initAuthInfo() {
    const newPassword = createRandomString(16, 22);
    fs.writeFileSync(
      config.authConfigFile,
      JSON.stringify({
        username: 'admin',
        password: newPassword,
      }),
    );
    return {
      code: 100,
      message: '已初始化密码，请前往auth.json查看并重新登录',
    };
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
    const authInfo = this.getAuthInfo();
    this.updateAuthInfo(authInfo, { username, password });
    return { code: 200, message: '更新成功' };
  }

  public async updateAvatar(avatar: string) {
    const authInfo = this.getAuthInfo();
    this.updateAuthInfo(authInfo, { avatar });
    return { code: 200, data: avatar, message: '更新成功' };
  }

  public getUserInfo(): Promise<any> {
    return new Promise((resolve) => {
      fs.readFile(config.authConfigFile, 'utf8', (err, data) => {
        if (err) console.log(err);
        resolve(JSON.parse(data));
      });
    });
  }

  public initTwoFactor() {
    const secret = authenticator.generateSecret();
    const authInfo = this.getAuthInfo();
    const otpauth = authenticator.keyuri(authInfo.username, 'qinglong', secret);
    this.updateAuthInfo(authInfo, { twoFactorSecret: secret });
    return { secret, url: otpauth };
  }

  public activeTwoFactor(code: string) {
    const authInfo = this.getAuthInfo();
    const isValid = authenticator.verify({
      token: code,
      secret: authInfo.twoFactorSecret,
    });
    if (isValid) {
      this.updateAuthInfo(authInfo, { twoFactorActivated: true });
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
    const authInfo = this.getAuthInfo();
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
      const { ip, address } = await getNetIp(req);
      this.updateAuthInfo(authInfo, {
        lastip: ip,
        lastaddr: address,
        platform: req.platform,
      });
      return { code: 430, message: '验证失败' };
    }
  }

  public deactiveTwoFactor() {
    const authInfo = this.getAuthInfo();
    this.updateAuthInfo(authInfo, {
      twoFactorActivated: false,
      twoFactorActived: false,
      twoFactorSecret: '',
    });
    return true;
  }

  private getAuthInfo() {
    const content = fs.readFileSync(config.authConfigFile, 'utf8');
    return JSON.parse(content || '{}');
  }

  private updateAuthInfo(authInfo: any, info: any) {
    fs.writeFileSync(
      config.authConfigFile,
      JSON.stringify({ ...authInfo, ...info }),
    );
  }

  public async getNotificationMode(): Promise<NotificationInfo> {
    const doc = await this.getDb({ type: AuthDataType.notification });
    return (doc && doc.info) || {};
  }

  private async updateAuthDb(payload: AuthInfo): Promise<any> {
    let doc = await AuthModel.findOne({ type: payload.type });
    if (doc) {
      const updateResult = await AuthModel.update(payload, {
        where: { id: doc.id },
        returning: true,
      });
      doc = updateResult[1][0];
    } else {
      doc = await AuthModel.create(payload, { returning: true });
    }
    return doc;
  }

  public async getDb(query: any): Promise<any> {
    const doc: any = await AuthModel.findOne({ where: { ...query } });
    return doc && (doc.get({ plain: true }) as any);
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
}
