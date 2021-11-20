import { NotificationInfo } from '../data/notify';
import { Service, Inject } from 'typedi';
import winston from 'winston';
import UserService from './user';
import got from 'got';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { HttpProxyAgent, HttpsProxyAgent } from 'hpagent';

@Service()
export default class NotificationService {
  @Inject((type) => UserService)
  private userService!: UserService;

  private modeMap = new Map([
    ['gotify', this.gotify],
    ['goCqHttpBot', this.goCqHttpBot],
    ['serverChan', this.serverChan],
    ['bark', this.bark],
    ['telegramBot', this.telegramBot],
    ['dingtalkBot', this.dingtalkBot],
    ['weWorkBot', this.weWorkBot],
    ['weWorkApp', this.weWorkApp],
    ['iGot', this.iGot],
    ['pushPlus', this.pushPlus],
    ['email', this.email],
  ]);

  private timeout = 10000;
  private title = '';
  private content = '';
  private params!: Omit<NotificationInfo, 'type'>;

  constructor(@Inject('logger') private logger: winston.Logger) {}

  public async notify(
    title: string,
    content: string,
  ): Promise<boolean | undefined> {
    const { type, ...rest } = await this.userService.getNotificationMode();
    if (type) {
      this.title = title;
      this.content = content;
      this.params = rest;
      const notificationModeAction = this.modeMap.get(type);
      try {
        return await notificationModeAction?.call(this);
      } catch (error: any) {
        return false;
      }
    }
    return false;
  }

  public async testNotify(
    info: NotificationInfo,
    title: string,
    content: string,
  ) {
    const { type, ...rest } = info;
    if (type) {
      this.title = title;
      this.content = content;
      this.params = rest;
      const notificationModeAction = this.modeMap.get(type);
      return await notificationModeAction?.call(this);
    }
    return true;
  }

  private async gotify() {
    const { gotifyUrl, gotifyToken, gotifyPriority } = this.params;
    const res: any = await got
      .post(`${gotifyUrl}/message?token=${gotifyToken}`, {
        timeout: this.timeout,
        retry: 0,
        body: `title=${encodeURIComponent(
          this.title,
        )}&message=${encodeURIComponent(
          this.content,
        )}&priority=${gotifyPriority}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      })
      .json();
    return typeof res.id === 'number';
  }

  private async goCqHttpBot() {
    const { goCqHttpBotQq, goCqHttpBotToken, goCqHttpBotUrl } = this.params;
    const res: any = await got
      .post(
        `${goCqHttpBotUrl}?access_token=${goCqHttpBotToken}&${goCqHttpBotQq}`,
        {
          timeout: this.timeout,
          retry: 0,
          json: { message: `${this.title}\n${this.content}` },
        },
      )
      .json();
    return res.retcode === 0;
  }

  private async serverChan() {
    const { serverChanKey } = this.params;
    const url = serverChanKey.startsWith('SCT')
      ? `https://sctapi.ftqq.com/${serverChanKey}.send`
      : `https://sc.ftqq.com/${serverChanKey}.send`;
    const res: any = await got
      .post(url, {
        timeout: this.timeout,
        retry: 0,
        body: `title=${this.title}&desp=${this.content}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      .json();
    return res.errno === 0 || res.data.errno === 0;
  }

  private async bark() {
    let { barkPush, barkSound, barkGroup } = this.params;
    if (!barkPush.startsWith('http') && !barkPush.startsWith('https')) {
      barkPush = `https://api.day.app/${barkPush}`;
    }
    const url = `${barkPush}/${encodeURIComponent(
      this.title,
    )}/${encodeURIComponent(
      this.content,
    )}?sound=${barkSound}&group=${barkGroup}`;
    const res: any = await got
      .get(url, {
        timeout: this.timeout,
        retry: 0,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      .json();
    return res.code === 200;
  }

  private async telegramBot() {
    const {
      telegramBotApiHost,
      telegramBotProxyAuth,
      telegramBotProxyHost,
      telegramBotProxyPort,
      telegramBotToken,
      telegramBotUserId,
    } = this.params;
    const authStr = telegramBotProxyAuth ? `${telegramBotProxyAuth}@` : '';
    const url = `https://${
      telegramBotApiHost ? telegramBotApiHost : 'api.telegram.org'
    }/bot${telegramBotToken}/sendMessage`;
    let agent;
    if (telegramBotProxyHost && telegramBotProxyPort) {
      const options: any = {
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 256,
        maxFreeSockets: 256,
        proxy: `http://${authStr}${telegramBotProxyHost}:${telegramBotProxyPort}`,
      };
      const httpAgent = new HttpProxyAgent(options);
      const httpsAgent = new HttpsProxyAgent(options);
      agent = {
        http: httpAgent,
        https: httpsAgent,
      };
    }
    const res: any = await got
      .post(url, {
        timeout: this.timeout,
        retry: 0,
        body: `chat_id=${telegramBotUserId}&text=${this.title}\n\n${this.content}&disable_web_page_preview=true`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        agent,
      })
      .json();
    return !!res.ok;
  }

  private async dingtalkBot() {
    const { dingtalkBotSecret, dingtalkBotToken } = this.params;
    let secretParam = '';
    if (dingtalkBotSecret) {
      const dateNow = Date.now();
      const hmac = crypto.createHmac('sha256', dingtalkBotSecret);
      hmac.update(`${dateNow}\n${dingtalkBotSecret}`);
      const result = encodeURIComponent(hmac.digest('base64'));
      secretParam = `&timestamp=${dateNow}&sign=${result}`;
    }
    const url = `https://oapi.dingtalk.com/robot/send?access_token=${dingtalkBotToken}${secretParam}`;
    const res: any = await got
      .post(url, {
        timeout: this.timeout,
        retry: 0,
        json: {
          msgtype: 'text',
          text: {
            content: ` ${this.title}\n\n${this.content}`,
          },
        },
      })
      .json();
    return res.errcode === 0;
  }

  private async weWorkBot() {
    const { weWorkBotKey } = this.params;
    const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${weWorkBotKey}`;
    const res: any = await got
      .post(url, {
        timeout: this.timeout,
        retry: 0,
        json: {
          msgtype: 'text',
          text: {
            content: ` ${this.title}\n\n${this.content}`,
          },
        },
      })
      .json();
    return res.errcode === 0;
  }

  private async weWorkApp() {
    const { weWorkAppKey } = this.params;
    const [corpid, corpsecret, touser, agentid, thumb_media_id = '1'] =
      weWorkAppKey.split(',');
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken`;
    const { access_token } = await got
      .post(url, {
        timeout: this.timeout,
        retry: 0,
        json: {
          corpid,
          corpsecret,
        },
      })
      .json();

    let options: any = {
      msgtype: 'mpnews',
      mpnews: {
        articles: [
          {
            title: `${this.title}`,
            thumb_media_id,
            author: `智能助手`,
            content_source_url: ``,
            content: `${this.content.replace(/\n/g, '<br/>')}`,
            digest: `${this.content}`,
          },
        ],
      },
    };
    switch (thumb_media_id) {
      case '0':
        options = {
          msgtype: 'textcard',
          textcard: {
            title: `${this.title}`,
            description: `${this.content}`,
            url: 'https://github.com/whyour/qinglong',
            btntxt: '更多',
          },
        };
        break;

      case '1':
        options = {
          msgtype: 'text',
          text: {
            content: `${this.title}\n\n${this.content}`,
          },
        };
        break;
    }

    const res: any = await got
      .post(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${access_token}`,
        {
          timeout: this.timeout,
          retry: 0,
          json: {
            touser,
            agentid,
            safe: '0',
            ...options,
          },
        },
      )
      .json();

    return res.errcode === 0;
  }

  private async iGot() {
    const { iGotPushKey } = this.params;
    const url = `https://push.hellyw.com/${iGotPushKey.toLowerCase()}`;
    const res: any = await got
      .post(url, {
        timeout: this.timeout,
        retry: 0,
        body: `title=${this.title}&content=${this.content}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      .json();

    return res.ret === 0;
  }

  private async pushPlus() {
    const { pushPlusToken, pushPlusUser } = this.params;
    const url = `https://www.pushplus.plus/send`;
    const res: any = await got
      .post(url, {
        timeout: this.timeout,
        retry: 0,
        json: {
          token: `${pushPlusToken}`,
          title: `${this.title}`,
          content: `${this.content.replace(/[\n\r]/g, '<br>')}`,
          topic: `${pushPlusUser || ''}`,
        },
      })
      .json();

    return res.code === 200;
  }

  private async email() {
    const { emailPass, emailService, emailUser } = this.params;
    const transporter = nodemailer.createTransport({
      service: emailService,
      auth: {
        user: emailUser,
        pass: emailPass,
      },
    });

    const info = await transporter.sendMail({
      from: `"青龙快讯" <${emailUser}>`,
      to: `${emailUser}`,
      subject: `${this.title}`,
      html: `${this.content.replace(/\n/g, '<br/>')}`,
    });

    transporter.close();

    return !!info.messageId;
  }
}
