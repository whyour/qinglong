import { NotificationInfo } from '../data/notify';
import { Service, Inject } from 'typedi';
import winston from 'winston';
import UserService from './user';
import got from 'got';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { HttpProxyAgent, HttpsProxyAgent } from 'hpagent';
import { parseBody, parseHeaders } from '../config/util';

@Service()
export default class NotificationService {
  @Inject((type) => UserService)
  private userService!: UserService;

  private modeMap = new Map([
    ['gotify', this.gotify],
    ['goCqHttpBot', this.goCqHttpBot],
    ['serverChan', this.serverChan],
    ['pushDeer', this.pushDeer],
    ['chat', this.chat],
    ['bark', this.bark],
    ['telegramBot', this.telegramBot],
    ['dingtalkBot', this.dingtalkBot],
    ['weWorkBot', this.weWorkBot],
    ['weWorkApp', this.weWorkApp],
    ['aibotk', this.aibotk],
    ['iGot', this.iGot],
    ['pushPlus', this.pushPlus],
    ['email', this.email],
    ['webhook', this.webhook],
    ['lark', this.lark],
  ]);

  private title = '';
  private content = '';
  private params!: Omit<NotificationInfo, 'type'>;
  private gotOption = {
    timeout: 10000,
    retry: 1,
  };

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
    const { gotifyUrl, gotifyToken, gotifyPriority = 1 } = this.params;
    try {
      const res: any = await got
        .post(`${gotifyUrl}/message?token=${gotifyToken}`, {
          ...this.gotOption,
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
      if (typeof res.id === 'number') {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async goCqHttpBot() {
    const { goCqHttpBotQq, goCqHttpBotToken, goCqHttpBotUrl } = this.params;
    try {
      const res: any = await got
        .post(`${goCqHttpBotUrl}?${goCqHttpBotQq}`, {
          ...this.gotOption,
          json: { message: `${this.title}\n${this.content}` },
          headers: { Authorization: 'Bearer ' + goCqHttpBotToken },
        })
        .json();
      if (res.retcode === 0) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async serverChan() {
    const { serverChanKey } = this.params;
    const url = serverChanKey.startsWith('SCT')
      ? `https://sctapi.ftqq.com/${serverChanKey}.send`
      : `https://sc.ftqq.com/${serverChanKey}.send`;
    try {
      const res: any = await got
        .post(url, {
          ...this.gotOption,
          body: `title=${this.title}&desp=${this.content}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
        .json();
      if (res.errno === 0 || res.data.errno === 0) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async pushDeer() {
    const { pushDeerKey, pushDeerUrl } = this.params;
    const url = pushDeerUrl || `https://api2.pushdeer.com/message/push`;
    try {
      const res: any = await got
        .post(url, {
          ...this.gotOption,
          body: `pushkey=${pushDeerKey}&text=${encodeURIComponent(
            this.title,
          )}&desp=${encodeURIComponent(this.content)}&type=markdown`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
        .json();
      if (
        res.content.result.length !== undefined &&
        res.content.result.length > 0
      ) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async chat() {
    const { chatUrl, chatToken } = this.params;
    const url = `${chatUrl}${chatToken}`;
    try {
      const res: any = await got
        .post(url, {
          ...this.gotOption,
          body: `payload={"text":"${this.title}\n${this.content}"}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
        .json();
      if (res.success) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async bark() {
    let { barkPush, barkIcon, barkSound, barkGroup } = this.params;
    if (!barkPush.startsWith('http')) {
      barkPush = `https://api.day.app/${barkPush}`;
    }
    const url = `${barkPush}/${encodeURIComponent(
      this.title,
    )}/${encodeURIComponent(
      this.content,
    )}?icon=${barkIcon}&sound=${barkSound}&group=${barkGroup}`;

    try {
      const res: any = await got
        .get(url, {
          ...this.gotOption,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
        .json();
      if (res.code === 200) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
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
    try {
      const res: any = await got
        .post(url, {
          ...this.gotOption,
          body: `chat_id=${telegramBotUserId}&text=${this.title}\n\n${this.content}&disable_web_page_preview=true`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          agent,
        })
        .json();
      if (res.ok) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
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
    try {
      const res: any = await got
        .post(url, {
          ...this.gotOption,
          json: {
            msgtype: 'text',
            text: {
              content: ` ${this.title}\n\n${this.content}`,
            },
          },
        })
        .json();
      if (res.errcode === 0) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async weWorkBot() {
    const { weWorkBotKey, weWorkOrigin = 'https://qyapi.weixin.qq.com' } = this.params;
    const url = `${weWorkOrigin}/cgi-bin/webhook/send?key=${weWorkBotKey}`;
    try {
      const res: any = await got
        .post(url, {
          ...this.gotOption,
          json: {
            msgtype: 'text',
            text: {
              content: ` ${this.title}\n\n${this.content}`,
            },
          },
        })
        .json();
      if (res.errcode === 0) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async weWorkApp() {
    const { weWorkAppKey, weWorkOrigin = 'https://qyapi.weixin.qq.com' } = this.params;
    const [corpid, corpsecret, touser, agentid, thumb_media_id = '1'] =
      weWorkAppKey.split(',');
    const url = `${weWorkOrigin}/cgi-bin/gettoken`;
    const tokenRes: any = await got
      .post(url, {
        ...this.gotOption,
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

    try {
      const res: any = await got
        .post(
          `${weWorkOrigin}/cgi-bin/message/send?access_token=${tokenRes.access_token}`,
          {
            ...this.gotOption,
            json: {
              touser,
              agentid,
              safe: '0',
              ...options,
            },
          },
        )
        .json();

      if (res.errcode === 0) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async aibotk() {
    const { aibotkKey, aibotkType, aibotkName } = this.params;
    let url = '';
    let json = {};
    switch (aibotkType) {
      case 'room':
        url = 'https://api-bot.aibotk.com/openapi/v1/chat/room';
        json = {
          apiKey: `${aibotkKey}`,
          roomName: `${aibotkName}`,
          message: {
            type: 1,
            content: `【青龙快讯】\n\n${this.title}\n${this.content}`,
          },
        };
        break;
      case 'contact':
        url = 'https://api-bot.aibotk.com/openapi/v1/chat/contact';
        json = {
          apiKey: `${aibotkKey}`,
          name: `${aibotkName}`,
          message: {
            type: 1,
            content: `【青龙快讯】\n\n${this.title}\n${this.content}`,
          },
        };
        break;
    }

    try {
      const res: any = await got
        .post(url, {
          ...this.gotOption,
          json: {
            ...json,
          },
        })
        .json();
      if (res.code === 0) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async iGot() {
    const { iGotPushKey } = this.params;
    const url = `https://push.hellyw.com/${iGotPushKey.toLowerCase()}`;
    try {
      const res: any = await got
        .post(url, {
          ...this.gotOption,
          body: `title=${this.title}&content=${this.content}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
        .json();

      if (res.ret === 0) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async pushPlus() {
    const { pushPlusToken, pushPlusUser } = this.params;
    const url = `https://www.pushplus.plus/send`;
    try {
      const res: any = await got
        .post(url, {
          ...this.gotOption,
          json: {
            token: `${pushPlusToken}`,
            title: `${this.title}`,
            content: `${this.content.replace(/[\n\r]/g, '<br>')}`,
            topic: `${pushPlusUser || ''}`,
          },
        })
        .json();

      if (res.code === 200) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async lark() {
    let { larkKey } = this.params;

    if (!larkKey.startsWith('http')) {
      larkKey = `https://open.feishu.cn/open-apis/bot/v2/hook/${larkKey}`;
    }

    try {
      const res: any = await got
        .post(larkKey, {
          ...this.gotOption,
          json: {
            msg_type: 'text',
            content: { text: `${this.title}\n\n${this.content}` },
          },
          headers: { 'Content-Type': 'application/json' },
        })
        .json();
      if (res.StatusCode === 0) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async email() {
    const { emailPass, emailService, emailUser } = this.params;

    try {
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

      if (info.messageId) {
        return true;
      } else {
        throw new Error(JSON.stringify(info));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private async webhook() {
    const {
      webhookUrl,
      webhookBody,
      webhookHeaders,
      webhookMethod,
      webhookContentType,
    } = this.params;

    const { formatBody, formatUrl } = this.formatNotifyContent(
      webhookUrl,
      webhookBody,
    );
    if (!formatUrl && !formatBody) {
      return false;
    }
    const headers = parseHeaders(webhookHeaders);
    const body = parseBody(formatBody, webhookContentType);
    const bodyParam = this.formatBody(webhookContentType, body);
    const options = {
      method: webhookMethod,
      headers,
      ...this.gotOption,
      allowGetBody: true,
      ...bodyParam,
    };
    try {
      const res = await got(formatUrl, options);
      if (String(res.statusCode).startsWith('20')) {
        return true;
      } else {
        throw new Error(JSON.stringify(res));
      }
    } catch (error: any) {
      throw new Error(error.response ? error.response.body : error);
    }
  }

  private formatBody(contentType: string, body: any): object {
    if (!body) return {};
    switch (contentType) {
      case 'application/json':
        return { json: body };
      case 'multipart/form-data':
        return { form: body };
      case 'application/x-www-form-urlencoded':
        return { body };
    }
    return {};
  }

  private formatNotifyContent(url: string, body: string) {
    if (!url.includes('$title') && !body.includes('$title')) {
      return {};
    }

    return {
      formatUrl: url
        ?.replaceAll('$title', encodeURIComponent(this.title))
        ?.replaceAll('$content', encodeURIComponent(this.content)),
      formatBody: body
        ?.replaceAll('$title', this.title)
        ?.replaceAll('$content', this.content),
    };
  }
}
