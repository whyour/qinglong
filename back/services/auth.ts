import { Service, Inject } from 'typedi';
import winston from 'winston';
import { createRandomString, getNetIp } from '../config/util';
import config from '../config';
import * as fs from 'fs';
import _ from 'lodash';
import jwt from 'jsonwebtoken';

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
      } = JSON.parse(content);

      if (
        (cUsername === 'admin' && cPassword === 'adminadmin') ||
        !cUsername ||
        !cPassword
      ) {
        return this.initAuthInfo();
      }

      if (retries > 2 && Date.now() - lastlogon < Math.pow(3, retries) * 1000) {
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
        let token = jwt.sign({ data }, config.secret as any, {
          expiresIn: 60 * 60 * 24 * 3,
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
}
