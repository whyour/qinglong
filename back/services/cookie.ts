import { Service, Inject } from 'typedi';
import winston from 'winston';
import fetch from 'node-fetch';
import { getFileContentByName } from '../config/util';
import config from '../config';
import * as fs from 'fs';
import got from 'got';
import DataStore from 'nedb';
import { Cookie, CookieStatus, initCookiePosition } from '../data/cookie';

@Service()
export default class CookieService {
  private cronDb = new DataStore({ filename: config.cookieDbFile });
  constructor(@Inject('logger') private logger: winston.Logger) {
    this.cronDb.loadDatabase((err) => {
      if (err) throw err;
    });
  }

  public async getCookies() {
    const content = getFileContentByName(config.cookieFile);
    return this.formatCookie(content.split('\n').filter((x) => !!x));
  }

  public async addCookie(cookies: string[]) {
    let content = getFileContentByName(config.cookieFile);
    const originCookies = content.split('\n').filter((x) => !!x);
    const result = originCookies.concat(cookies);
    fs.writeFileSync(config.cookieFile, result.join('\n'));
    return '';
  }

  public async updateCookie({ cookie, oldCookie }) {
    let content = getFileContentByName(config.cookieFile);
    const cookies = content.split('\n');
    const index = cookies.findIndex((x) => x === oldCookie);
    if (index !== -1) {
      cookies[index] = cookie;
      fs.writeFileSync(config.cookieFile, cookies.join('\n'));
      return '';
    } else {
      return '未找到要原有Cookie';
    }
  }

  public async deleteCookie(cookie: string) {
    let content = getFileContentByName(config.cookieFile);
    const cookies = content.split('\n');
    const index = cookies.findIndex((x) => x === cookie);
    if (index !== -1) {
      cookies.splice(index, 1);
      fs.writeFileSync(config.cookieFile, cookies.join('\n'));
      return '';
    } else {
      return '未找到要删除的Cookie';
    }
  }

  private async formatCookie(data: any[]) {
    const result = [];
    for (const x of data) {
      const { nickname, status } = await this.getJdInfo(x);
      if (/pt_pin=(.+?);/.test(x)) {
        result.push({
          pin: x.match(/pt_pin=(.+?);/)[1],
          cookie: x,
          status,
          nickname: nickname,
        });
      } else {
        result.push({
          pin: 'pin未匹配到',
          cookie: x,
          status,
          nickname: nickname,
        });
      }
    }
    return result;
  }

  public async refreshCookie(_id: string) {
    const current = await this.get(_id);
    const { status, nickname } = await this.getJdInfo(current.value);
    return {
      ...current,
      status,
      nickname,
    };
  }

  private getJdInfo(cookie: string) {
    return fetch(
      `https://me-api.jd.com/user_new/info/GetJDUserInfoUnion?orgFlag=JD_PinGou_New&callSource=mainorder&channel=4&isHomewhite=0&sceneval=2&_=${Date.now()}&sceneval=2&g_login_type=1&g_ty=ls`,
      {
        method: 'get',
        headers: {
          Accept: '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'zh-cn',
          Connection: 'keep-alive',
          Cookie: cookie,
          Referer: 'https://home.m.jd.com/myJd/newhome.action',
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 14_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1',
          Host: 'me-api.jd.com',
        },
      },
    )
      .then((x) => x.json())
      .then((x) => {
        if (x.retcode === '0' && x.data && x.data.userInfo) {
          return {
            nickname: x.data.userInfo.baseInfo.nickname,
            status: CookieStatus.normal,
          };
        } else if (x.retcode === 13) {
          return { status: CookieStatus.invalid, nickname: '-' };
        }
        return { status: CookieStatus.abnormal, nickname: '-' };
      });
  }

  private async formatCookies(cookies: Cookie[]) {
    const result = [];
    for (let i = 0; i < cookies.length; i++) {
      const cookie = cookies[i];
      if (cookie.status !== CookieStatus.disabled) {
        const { status, nickname } = await this.getJdInfo(cookie.value);
        result.push({ ...cookie, status, nickname });
      } else {
        result.push({ ...cookie, nickname: '-' });
      }
    }
    return result;
  }

  public async create(payload: string[]): Promise<Cookie[]> {
    const cookies = await this.cookies();
    let position = initCookiePosition;
    if (cookies && cookies.length > 0) {
      position = cookies[cookies.length - 1].position;
    }
    const tabs = payload.map((x) => {
      const cookie = new Cookie({ value: x, position });
      position = position / 2;
      cookie.position = position;
      return cookie;
    });
    const docs = await this.insert(tabs);
    await this.set_cookies();
    return await this.formatCookies(docs);
  }

  public async insert(payload: Cookie[]): Promise<Cookie[]> {
    return new Promise((resolve) => {
      this.cronDb.insert(payload, (err, docs) => {
        if (err) {
          this.logger.error(err);
        } else {
          resolve(docs);
        }
      });
    });
  }

  public async update(payload: Cookie): Promise<Cookie> {
    const { _id, ...other } = payload;
    const doc = await this.get(_id);
    const tab = new Cookie({ ...doc, ...other });
    const newDoc = await this.updateDb(tab);
    await this.set_cookies();
    const [newCookie] = await this.formatCookies([newDoc]);
    return newCookie;
  }

  private async updateDb(payload: Cookie): Promise<Cookie> {
    return new Promise((resolve) => {
      this.cronDb.update(
        { _id: payload._id },
        payload,
        { returnUpdatedDocs: true },
        (err, num, doc) => {
          if (err) {
            this.logger.error(err);
          } else {
            resolve(doc as Cookie);
          }
        },
      );
    });
  }

  public async remove(ids: string[]) {
    return new Promise((resolve: any) => {
      this.cronDb.remove(
        { _id: { $in: ids } },
        { multi: true },
        async (err) => {
          await this.set_cookies();
          resolve();
        },
      );
    });
  }

  public async move(
    _id: string,
    {
      fromIndex,
      toIndex,
    }: {
      fromIndex: number;
      toIndex: number;
    },
  ) {
    let targetPosition: number;
    const isUpward = fromIndex > toIndex;
    const cookies = await this.cookies();
    if (toIndex === 0 || toIndex === cookies.length - 1) {
      targetPosition = isUpward
        ? cookies[0].position * 2
        : cookies[toIndex].position / 2;
    } else {
      targetPosition = isUpward
        ? (cookies[toIndex].position + cookies[toIndex - 1].position) / 2
        : (cookies[toIndex].position + cookies[toIndex + 1].position) / 2;
    }
    this.update({
      _id,
      position: targetPosition,
    });
    await this.set_cookies();
  }

  public async cookies(
    searchText?: string,
    sort: any = { position: -1 },
    needDetail: boolean = false,
  ): Promise<Cookie[]> {
    let query = {};
    if (searchText) {
      const reg = new RegExp(searchText);
      query = {
        $or: [
          {
            name: reg,
          },
          {
            command: reg,
          },
        ],
      };
    }
    const newDocs = await this.find(query, sort);
    if (needDetail) {
      return await this.formatCookies(newDocs);
    } else {
      return newDocs;
    }
  }

  private async find(query: any, sort: any): Promise<Cookie[]> {
    return new Promise((resolve) => {
      this.cronDb
        .find(query)
        .sort({ ...sort })
        .exec((err, docs) => {
          resolve(docs);
        });
    });
  }

  public async get(_id: string): Promise<Cookie> {
    return new Promise((resolve) => {
      this.cronDb.find({ _id }).exec((err, docs) => {
        resolve(docs[0]);
      });
    });
  }

  public async getBySort(sort: any): Promise<Cookie> {
    return new Promise((resolve) => {
      this.cronDb
        .find({})
        .sort({ ...sort })
        .limit(1)
        .exec((err, docs) => {
          resolve(docs[0]);
        });
    });
  }

  public async disabled(ids: string[]) {
    return new Promise((resolve: any) => {
      this.cronDb.update(
        { _id: { $in: ids } },
        { $set: { status: CookieStatus.disabled } },
        { multi: true },
        async (err) => {
          await this.set_cookies();
          resolve();
        },
      );
    });
  }

  public async enabled(ids: string[]) {
    return new Promise((resolve: any) => {
      this.cronDb.update(
        { _id: { $in: ids } },
        { $set: { status: CookieStatus.noacquired } },
        { multi: true },
        async (err, num) => {
          await this.set_cookies();
          resolve();
        },
      );
    });
  }

  public async set_cookies() {
    const cookies = await this.cookies();
    let cookie_string = '';
    cookies.forEach((tab) => {
      if (tab.status !== CookieStatus.disabled) {
        cookie_string += tab.value;
        cookie_string += '\n';
      }
    });
    fs.writeFileSync(config.cookieFile, cookie_string);
  }
}
