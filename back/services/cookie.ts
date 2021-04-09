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
    const { status } = await this.getJdInfo(current.value);
    return {
      ...current,
      status,
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

  public async create(payload: string[]): Promise<void> {
    const cookies = await this.cookies('', { postion: 1 });
    let position = initCookiePosition;
    if (cookies && cookies.length > 0) {
      position = cookies[0].position / 2;
    }
    const tabs = payload.map((x) => {
      const cookie = new Cookie({ value: x, position });
      position = position / 2;
      return cookie;
    });
    this.cronDb.insert(tabs);
    await this.set_cookies();
  }

  public async update(payload: Cookie): Promise<void> {
    const { _id, ...other } = payload;
    const doc = await this.get(_id);
    const tab = new Cookie({ ...doc, ...other });
    this.cronDb.update({ _id }, tab, { returnUpdatedDocs: true });
    await this.set_cookies();
  }

  public async remove(_id: string) {
    this.cronDb.remove({ _id }, {});
    await this.set_cookies();
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
        ? (cookies[0].position * 2 + 1) / 2
        : (cookies[toIndex].position * 2 - 1) / 2;
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

  public async disabled(_id: string) {
    this.cronDb.update({ _id }, { $set: { status: CookieStatus.disabled } });
    await this.set_cookies();
  }

  public async enabled(_id: string) {
    this.cronDb.update({ _id }, { $set: { status: CookieStatus.noacquired } });
  }

  private async set_cookies() {
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
