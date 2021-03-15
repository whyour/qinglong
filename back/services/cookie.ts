import { Service, Inject } from 'typedi';
import winston from 'winston';
import fetch from 'node-fetch';

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

  public async getYiYan(): Promise<any> {
    return { yiYan: 'test' };
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
      this.praseSetCookies(text);
    } catch (error) {
      this.logger.error(error.response.body);
    }
  }

  private async step2() {
    try {
      if (this.cookies == '') {
        return 0;
      }
      let timeStamp = new Date().getTime();
      let url =
        'https://plogin.m.jd.com/cgi-bin/m/tmauthreflogurl?s_token=' +
        this.s_token +
        '&v=' +
        timeStamp +
        '&remember=true';
      const response = await fetch(url, {
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
      }).then((res) => res.json);
      // this.token = response.body.token
      // this.okl_token = response.headers['set-cookie'][0]
      // this.okl_token = this.okl_token.substring(this.okl_token.indexOf("=") + 1, this.okl_token.indexOf(";"))
      var qrUrl =
        'https://plogin.m.jd.com/cgi-bin/m/tmauth?appid=300&client_type=m&token=' +
        this.token;
      return qrUrl;
    } catch (error) {
      console.log(error.response.body);
      return 0;
    }
  }

  private praseSetCookies(response: any) {
    this.s_token = response.body.s_token;
    this.guid = response.headers['set-cookie'][0];
    this.guid = this.guid.substring(
      this.guid.indexOf('=') + 1,
      this.guid.indexOf(';'),
    );
    this.lsid = response.headers['set-cookie'][2];
    this.lsid = this.lsid.substring(
      this.lsid.indexOf('=') + 1,
      this.lsid.indexOf(';'),
    );
    this.lstoken = response.headers['set-cookie'][3];
    this.lstoken = this.lstoken.substring(
      this.lstoken.indexOf('=') + 1,
      this.lstoken.indexOf(';'),
    );
    this.cookies =
      'guid=' +
      this.guid +
      '; lang=chs; lsid=' +
      this.lsid +
      '; lstoken=' +
      this.lstoken +
      '; ';
  }
}
