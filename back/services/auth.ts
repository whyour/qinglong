import { Service, Inject } from 'typedi';
import winston from 'winston';
import { createRandomString, getNetIp } from '../config/util';
import config from '../config';
import * as fs from 'fs';
import _ from 'lodash';
import jwt from 'jsonwebtoken';
import { authenticator } from '@otplib/preset-default';

@Service()
export default class AuthService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  public async login(
    payloads: {
      username: string;
      password: string;
    },
    req: any,
  ): Promise<any> {
    if (!fs.existsSync(config.authConfigFile)) {
      return this.initAuthInfo();
    }

    let { username, password } = payloads;
    const content = fs.readFileSync(config.authConfigFile, 'utf8');
    const timestamp = Date.now();
    if (content) {
      const {
        username: cUsername,
        password: cPassword,
        retries = 0,
        lastlogon,
        lastip,
        lastaddr,
        twoFactorActived,
        twoFactorChecked,
      } = JSON.parse(content);

      if (
        (cUsername === 'admin' && cPassword === 'adminadmin') ||
        !cUsername ||
        !cPassword
      ) {
        return this.initAuthInfo();
      }

      if (twoFactorActived && !twoFactorChecked) {
        return {
          code: 420,
          message: '请输入两步验证token',
        };
      }

      if (retries > 2 && Date.now() - lastlogon < Math.pow(3, retries) * 1000) {
        fs.writeFileSync(
          config.authConfigFile,
          JSON.stringify({
            ...JSON.parse(content),
            twoFactorChecked: false,
          }),
        );
        return {
          code: 410,
          message: `失败次数过多，请${Math.round(
            (Math.pow(3, retries) * 1000 - Date.now() + lastlogon) / 1000,
          )}秒后重试`,
          data: Math.round(
            (Math.pow(3, retries) * 1000 - Date.now() + lastlogon) / 1000,
          ),
        };
      }

      const { ip, address } = await getNetIp(req);
      if (username === cUsername && password === cPassword) {
        const data = createRandomString(50, 100);
        const expiration = twoFactorActived ? 30 : 3;
        let token = jwt.sign({ data }, config.secret as any, {
          expiresIn: 60 * 60 * 24 * expiration,
          algorithm: 'HS384',
        });
        fs.writeFileSync(
          config.authConfigFile,
          JSON.stringify({
            ...JSON.parse(content),
            token,
            lastlogon: timestamp,
            retries: 0,
            lastip: ip,
            lastaddr: address,
            twoFactorChecked: false,
          }),
        );
        return { code: 200, data: { token, lastip, lastaddr, lastlogon } };
      } else {
        fs.writeFileSync(
          config.authConfigFile,
          JSON.stringify({
            ...JSON.parse(content),
            retries: retries + 1,
            lastlogon: timestamp,
            lastip: ip,
            lastaddr: address,
            twoFactorChecked: false,
          }),
        );
        return { code: 400, message: config.authError };
      }
    } else {
      return this.initAuthInfo();
    }
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
      this.updateAuthInfo(authInfo, { twoFactorActived: true });
    }
    return isValid;
  }

  public async twoFactorLogin({ username, password, code }, req) {
    const authInfo = this.getAuthInfo();
    const isValid = authenticator.verify({
      token: code,
      secret: authInfo.twoFactorSecret,
    });
    if (isValid) {
      this.updateAuthInfo(authInfo, { twoFactorChecked: true });
      return this.login({ username, password }, req);
    } else {
      const { ip, address } = await getNetIp(req);
      this.updateAuthInfo(authInfo, {
        lastip: ip,
        lastaddr: address,
      });
      return { code: 430, message: '验证失败' };
    }
  }

  public deactiveTwoFactor() {
    const authInfo = this.getAuthInfo();
    this.updateAuthInfo(authInfo, {
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
}
