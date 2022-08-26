"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const typedi_1 = require("typedi");
const winston_1 = __importDefault(require("winston"));
const user_1 = __importDefault(require("./user"));
const got_1 = __importDefault(require("got"));
const nodemailer_1 = __importDefault(require("nodemailer"));
const crypto_1 = __importDefault(require("crypto"));
const hpagent_1 = require("hpagent");
let NotificationService = class NotificationService {
    constructor(logger) {
        this.logger = logger;
        this.modeMap = new Map([
            ['gotify', this.gotify],
            ['goCqHttpBot', this.goCqHttpBot],
            ['serverChan', this.serverChan],
            ['pushDeer', this.pushDeer],
            ['bark', this.bark],
            ['telegramBot', this.telegramBot],
            ['dingtalkBot', this.dingtalkBot],
            ['weWorkBot', this.weWorkBot],
            ['weWorkApp', this.weWorkApp],
            ['iGot', this.iGot],
            ['pushPlus', this.pushPlus],
            ['email', this.email],
        ]);
        this.timeout = 10000;
        this.title = '';
        this.content = '';
    }
    async notify(title, content) {
        const _a = await this.userService.getNotificationMode(), { type } = _a, rest = __rest(_a, ["type"]);
        if (type) {
            this.title = title;
            this.content = content;
            this.params = rest;
            const notificationModeAction = this.modeMap.get(type);
            try {
                return await (notificationModeAction === null || notificationModeAction === void 0 ? void 0 : notificationModeAction.call(this));
            }
            catch (error) {
                return false;
            }
        }
        return false;
    }
    async testNotify(info, title, content) {
        const { type } = info, rest = __rest(info, ["type"]);
        if (type) {
            this.title = title;
            this.content = content;
            this.params = rest;
            const notificationModeAction = this.modeMap.get(type);
            return await (notificationModeAction === null || notificationModeAction === void 0 ? void 0 : notificationModeAction.call(this));
        }
        return true;
    }
    async gotify() {
        const { gotifyUrl, gotifyToken, gotifyPriority } = this.params;
        const res = await got_1.default
            .post(`${gotifyUrl}/message?token=${gotifyToken}`, {
            timeout: this.timeout,
            retry: 0,
            body: `title=${encodeURIComponent(this.title)}&message=${encodeURIComponent(this.content)}&priority=${gotifyPriority}`,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        })
            .json();
        return typeof res.id === 'number';
    }
    async goCqHttpBot() {
        const { goCqHttpBotQq, goCqHttpBotToken, goCqHttpBotUrl } = this.params;
        const res = await got_1.default
            .post(`${goCqHttpBotUrl}?${goCqHttpBotQq}`, {
            timeout: this.timeout,
            retry: 0,
            json: { message: `${this.title}\n${this.content}` },
            headers: { Authorization: 'Bearer ' + goCqHttpBotToken },
        })
            .json();
        return res.retcode === 0;
    }
    async serverChan() {
        const { serverChanKey } = this.params;
        const url = serverChanKey.startsWith('SCT')
            ? `https://sctapi.ftqq.com/${serverChanKey}.send`
            : `https://sc.ftqq.com/${serverChanKey}.send`;
        const res = await got_1.default
            .post(url, {
            timeout: this.timeout,
            retry: 0,
            body: `title=${this.title}&desp=${this.content}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
            .json();
        return res.errno === 0 || res.data.errno === 0;
    }
    async pushDeer() {
        const { pushDeerKey } = this.params;
        const url = `https://api2.pushdeer.com/message/push`;
        const res = await got_1.default
            .post(url, {
            timeout: this.timeout,
            retry: 0,
            body: `pushkey=${pushDeerKey}&text=${encodeURIComponent(this.title)}&desp=${encodeURIComponent(this.content)}&type=markdown`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
            .json();
        return (res.content.result.length !== undefined && res.content.result.length > 0);
    }
    async bark() {
        let { barkPush, barkIcon, barkSound, barkGroup } = this.params;
        if (!barkPush.startsWith('http') && !barkPush.startsWith('https')) {
            barkPush = `https://api.day.app/${barkPush}`;
        }
        const url = `${barkPush}/${encodeURIComponent(this.title)}/${encodeURIComponent(this.content)}?icon=${barkIcon}?sound=${barkSound}&group=${barkGroup}`;
        const res = await got_1.default
            .get(url, {
            timeout: this.timeout,
            retry: 0,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
            .json();
        return res.code === 200;
    }
    async telegramBot() {
        const { telegramBotApiHost, telegramBotProxyAuth, telegramBotProxyHost, telegramBotProxyPort, telegramBotToken, telegramBotUserId, } = this.params;
        const authStr = telegramBotProxyAuth ? `${telegramBotProxyAuth}@` : '';
        const url = `https://${telegramBotApiHost ? telegramBotApiHost : 'api.telegram.org'}/bot${telegramBotToken}/sendMessage`;
        let agent;
        if (telegramBotProxyHost && telegramBotProxyPort) {
            const options = {
                keepAlive: true,
                keepAliveMsecs: 1000,
                maxSockets: 256,
                maxFreeSockets: 256,
                proxy: `http://${authStr}${telegramBotProxyHost}:${telegramBotProxyPort}`,
            };
            const httpAgent = new hpagent_1.HttpProxyAgent(options);
            const httpsAgent = new hpagent_1.HttpsProxyAgent(options);
            agent = {
                http: httpAgent,
                https: httpsAgent,
            };
        }
        const res = await got_1.default
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
    async dingtalkBot() {
        const { dingtalkBotSecret, dingtalkBotToken } = this.params;
        let secretParam = '';
        if (dingtalkBotSecret) {
            const dateNow = Date.now();
            const hmac = crypto_1.default.createHmac('sha256', dingtalkBotSecret);
            hmac.update(`${dateNow}\n${dingtalkBotSecret}`);
            const result = encodeURIComponent(hmac.digest('base64'));
            secretParam = `&timestamp=${dateNow}&sign=${result}`;
        }
        const url = `https://oapi.dingtalk.com/robot/send?access_token=${dingtalkBotToken}${secretParam}`;
        const res = await got_1.default
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
    async weWorkBot() {
        const { weWorkBotKey } = this.params;
        const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${weWorkBotKey}`;
        const res = await got_1.default
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
    async weWorkApp() {
        const { weWorkAppKey } = this.params;
        const [corpid, corpsecret, touser, agentid, thumb_media_id = '1'] = weWorkAppKey.split(',');
        const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken`;
        const tokenRes = await got_1.default
            .post(url, {
            timeout: this.timeout,
            retry: 0,
            json: {
                corpid,
                corpsecret,
            },
        })
            .json();
        let options = {
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
        const res = await got_1.default
            .post(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tokenRes.access_token}`, {
            timeout: this.timeout,
            retry: 0,
            json: Object.assign({ touser,
                agentid, safe: '0' }, options),
        })
            .json();
        return res.errcode === 0;
    }
    async iGot() {
        const { iGotPushKey } = this.params;
        const url = `https://push.hellyw.com/${iGotPushKey.toLowerCase()}`;
        const res = await got_1.default
            .post(url, {
            timeout: this.timeout,
            retry: 0,
            body: `title=${this.title}&content=${this.content}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
            .json();
        return res.ret === 0;
    }
    async pushPlus() {
        const { pushPlusToken, pushPlusUser } = this.params;
        const url = `https://www.pushplus.plus/send`;
        const res = await got_1.default
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
    async email() {
        const { emailPass, emailService, emailUser } = this.params;
        const transporter = nodemailer_1.default.createTransport({
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
};
__decorate([
    (0, typedi_1.Inject)((type) => user_1.default),
    __metadata("design:type", user_1.default)
], NotificationService.prototype, "userService", void 0);
NotificationService = __decorate([
    (0, typedi_1.Service)(),
    __param(0, (0, typedi_1.Inject)('logger')),
    __metadata("design:paramtypes", [winston_1.default.Logger])
], NotificationService);
exports.default = NotificationService;
//# sourceMappingURL=notify.js.map