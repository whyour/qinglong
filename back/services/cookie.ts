import { Service, Inject } from 'typedi';
import winston from 'winston';
import fetch from 'node-fetch';
import { getFileContentByName } from '../config/util';
import config from '../config';
import * as fs from 'fs';
import got from 'got';

enum Status {
  '正常',
  '失效',
  '状态异常',
}

@Service()
export default class CookieService {
  private cookies: string = '';
  private s_token: string = '';
  private guid: string = '';
  private lsid: string = '';
  private lstoken: string = '';
  private okl_token: string = '';
  private token: string = '';
  constructor(@Inject('logger') private logger: winston.Logger) {}

  public async getQrUrl(): Promise<{ qrurl: string }> {
    await this.step1();
    const qrurl = await this.step2();
    return { qrurl };
  }

  private async step1() {
    try {
      let timeStamp = new Date().getTime();
      let url =
        'https://plogin.m.jd.com/cgi-bin/mm/new_login_entrance?lang=chs&appid=300&returnurl=https://wq.jd.com/passport/LoginRedirect?state=' +
        timeStamp +
        '&returnurl=https://home.m.jd.com/myJd/newhome.action?sceneval=2&ufc=&/myJd/home.action&source=wq_passport';
      const text = await fetch(url, {
        method: 'get',
        headers: {
          Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-cn',
          Referer:
            'https://plogin.m.jd.com/login/login?appid=300&returnurl=https://wq.jd.com/passport/LoginRedirect?state=' +
            timeStamp +
            '&returnurl=https://home.m.jd.com/myJd/newhome.action?sceneval=2&ufc=&/myJd/home.action&source=wq_passport',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.111 Safari/537.36',
          Host: 'plogin.m.jd.com',
        },
      });
      await this.praseSetCookies(text);
    } catch (error) {
      this.logger.error(error);
    }
  }

  private async step2() {
    try {
      if (this.cookies == '') {
        return '';
      }
      console.log(this.cookies);
      let timeStamp = new Date().getTime();
      let url =
        'https://plogin.m.jd.com/cgi-bin/m/tmauthreflogurl?s_token=' +
        this.s_token +
        '&v=' +
        timeStamp +
        '&remember=true';
      const response: any = await fetch(url, {
        method: 'post',
        body: JSON.stringify({
          lang: 'chs',
          appid: 300,
          returnurl:
            'https://wqlogin2.jd.com/passport/LoginRedirect?state=' +
            timeStamp +
            '&returnurl=//home.m.jd.com/myJd/newhome.action?sceneval=2&ufc=&/myJd/home.action',
          source: 'wq_passport',
        }),
        headers: {
          Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded; Charset=UTF-8',
          Accept: 'application/json, text/plain, */*',
          Cookie: this.cookies,
          Referer:
            'https://plogin.m.jd.com/login/login?appid=300&returnurl=https://wqlogin2.jd.com/passport/LoginRedirect?state=' +
            timeStamp +
            '&returnurl=//home.m.jd.com/myJd/newhome.action?sceneval=2&ufc=&/myJd/home.action&source=wq_passport',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.111 Safari/537.36',
          Host: 'plogin.m.jd.com',
        },
      });
      const body = await response.json();
      this.token = body.token;
      const setCookies = response.headers.get('set-cookie');
      this.okl_token = setCookies.match(/okl_token=(.+?);/)[1];
      var qrUrl =
        'https://plogin.m.jd.com/cgi-bin/m/tmauth?appid=300&client_type=m&token=' +
        this.token;
      return qrUrl;
    } catch (error) {
      console.log(error.response.body);
      return '';
    }
  }

  private async praseSetCookies(response: any) {
    const body = await response.json();
    this.s_token = body.s_token;
    const setCookies = response.headers.get('set-cookie');
    this.guid = setCookies.match(/guid=(.+?);/)[1];
    this.lsid = setCookies.match(/lsid=(.+?);/)[1];
    this.lstoken = setCookies.match(/lstoken=(.+?);/)[1];
    this.cookies =
      'guid=' +
      this.guid +
      '; lang=chs; lsid=' +
      this.lsid +
      '; lstoken=' +
      this.lstoken +
      '; ';
  }

  private getCookie(response: any) {
    const setCookies = response.headers['set-cookie'];
    var TrackerID = setCookies[0].match(/TrackerID=(.+?);/)[1];
    var pt_key = setCookies[1].match(/pt_key=(.+?);/)[1];
    var pt_pin = setCookies[2].match(/pt_pin=(.+?);/)[1];
    var pt_token = setCookies[3].match(/pt_token=(.+?);/)[1];
    var pwdt_id = setCookies[4].match(/pwdt_id=(.+?);/)[1];
    var s_key = setCookies[5].match(/s_key=(.+?);/)[1];
    var s_pin = setCookies[6].match(/s_pin=(.+?);/)[1];
    this.cookies =
      'TrackerID=' +
      TrackerID +
      '; pt_key=' +
      pt_key +
      '; pt_pin=' +
      pt_pin +
      '; pt_token=' +
      pt_token +
      '; pwdt_id=' +
      pwdt_id +
      '; s_key=' +
      s_key +
      '; s_pin=' +
      s_pin +
      '; wq_skey=';
    var userCookie = 'pt_key=' + pt_key + ';pt_pin=' + pt_pin + ';';
    console.log('\n############  登录成功，获取到 Cookie  #############\n\n');
    console.log('Cookie1="' + userCookie + '"\n');
    console.log('\n####################################################\n\n');
    return userCookie;
  }

  public async addCookie() {
    const res: any = await this.checkLogin();
    if (res.body.errcode === 0) {
      let ucookie = this.getCookie(res);
      let content = getFileContentByName(config.confFile);
      const regx = /.*Cookie[0-9]{1}\=\"(.+?)\"/g;
      const lastCookie = (content.match(regx) as any[]).pop();
      const cookieRegx = /Cookie([0-9]+)\=.+?/.exec(lastCookie);
      if (cookieRegx) {
        const num = parseInt(cookieRegx[1]) + 1;
        const newCookie = `${lastCookie}\nCookie${num}="${ucookie}"`;
        const result = content.replace(lastCookie, newCookie);
        fs.writeFileSync(config.confFile, result);
      }
      return { cookie: ucookie };
    } else {
      return res.body;
    }
  }

  private async checkLogin() {
    try {
      if (this.cookies == '') {
        return '';
      }
      let timeStamp = new Date().getTime();
      let url =
        'https://plogin.m.jd.com/cgi-bin/m/tmauthchecktoken?&token=' +
        this.token +
        '&ou_state=0&okl_token=' +
        this.okl_token;
      return got.post(url, {
        responseType: 'json',
        form: {
          lang: 'chs',
          appid: 300,
          returnurl:
            'https://wqlogin2.jd.com/passport/LoginRedirect?state=1100399130787&returnurl=//home.m.jd.com/myJd/newhome.action?sceneval=2&ufc=&/myJd/home.action',
          source: 'wq_passport',
        },
        headers: {
          Referer:
            'https://plogin.m.jd.com/login/login?appid=300&returnurl=https://wqlogin2.jd.com/passport/LoginRedirect?state=' +
            timeStamp +
            '&returnurl=//home.m.jd.com/myJd/newhome.action?sceneval=2&ufc=&/myJd/home.action&source=wq_passport',
          Cookie: this.cookies,
          Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded; Charset=UTF-8',
          Accept: 'application/json, text/plain, */*',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.111 Safari/537.36',
        },
      });
    } catch (error) {
      console.log(error);
      let res: any = {};
      res.body = { check_ip: 0, errcode: 222, message: '出错' };
      res.headers = {};
      return res;
    }
  }

  public async getCookies() {
    const content = getFileContentByName(config.confFile);
    const regx = /Cookie[0-9]{1}\=\"(.+?)\"/g;
    let m,
      data = [];
    while ((m = regx.exec(content)) !== null) {
      data.push(m[1]);
    }
    return this.formatCookie(data);
  }

  private async formatCookie(data: any[]) {
    const result = [];
    for (const x of data) {
      const { nickname, status } = await this.getJdInfo(x);
      result.push({
        pin: x.match(/pt_pin=(.+?);/)[1],
        cookie: x,
        status,
        nickname: nickname,
      });
    }
    return result;
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
        console.log(x.data.userInfo);
        if (x.retcode === '0' && x.data && x.data.userInfo) {
          return { nickname: x.data.userInfo.baseInfo.nickname, status: 0 };
        } else if (x.retcode === 13) {
          return { status: 1, nickname: '-' };
        }
        return { status: 2, nickname: '-' };
      });
  }
}
