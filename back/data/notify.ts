import { IncomingHttpHeaders } from 'http';

export enum NotificationMode {
  'gotify' = 'gotify',
  'goCqHttpBot' = 'goCqHttpBot',
  'serverChan' = 'serverChan',
  'pushDeer' = 'pushDeer',
  'bark' = 'bark',
  'chat' = 'chat',
  'telegramBot' = 'telegramBot',
  'dingtalkBot' = 'dingtalkBot',
  'weWorkBot' = 'weWorkBot',
  'weWorkApp' = 'weWorkApp',
  'aibotk' = 'aibotk',
  'iGot' = 'iGot',
  'pushPlus' = 'pushPlus',
  'wePlusBot' = 'wePlusBot',
  'email' = 'email',
  'pushMe' = 'pushMe',
  'feishu' = 'feishu',
  'webhook' = 'webhook',
  'chronocat' = 'Chronocat',
}

abstract class NotificationBaseInfo {
  public type!: NotificationMode;
}

export class GotifyNotification extends NotificationBaseInfo {
  public gotifyUrl = '';
  public gotifyToken = '';
  public gotifyPriority = 0;
}

export class GoCqHttpBotNotification extends NotificationBaseInfo {
  public gobotUrl = '';
  public gobotToken = '';
  public gobotQq = '';
}

export class ServerChanNotification extends NotificationBaseInfo {
  public pushKey = '';
}

export class PushDeerNotification extends NotificationBaseInfo {
  public deerKey = '';
  public deerUrl = '';
}

export class ChatNotification extends NotificationBaseInfo {
  public chatUrl = '';
  public chatToken = '';
}

export class BarkNotification extends NotificationBaseInfo {
  public barkPush = '';
  public barkIcon = 'https://qn.whyour.cn/logo.png';
  public barkSound = '';
  public barkGroup = 'qinglong';
  public barkLevel = 'active';
  public barkUrl = '';
  public barkArchive=""
}

export class TelegramBotNotification extends NotificationBaseInfo {
  public tgBotToken = '';
  public tgUserId = '';
  public tgProxyHost = '';
  public tgProxyPort = '';
  public tgProxyAuth = '';
  public tgApiHost = 'https://api.telegram.org';
}

export class DingtalkBotNotification extends NotificationBaseInfo {
  public ddBotToken = '';
  public ddBotSecret = '';
}

export class WeWorkBotNotification extends NotificationBaseInfo {
  public qywxKey = '';
  public qywxOrigin = '';
}

export class WeWorkAppNotification extends NotificationBaseInfo {
  public qywxKey = '';
  public qywxOrigin = '';
}

export class AibotkNotification extends NotificationBaseInfo {
  public aibotkKey: string = '';
  public aibotkType: 'room' | 'contact' = 'room';
  public aibotkName: string = '';
}

export class IGotNotification extends NotificationBaseInfo {
  public igotPushKey = '';
}

export class PushPlusNotification extends NotificationBaseInfo {
  public pushPlusToken = '';
  public pushPlusUser = '';
}

export class WePlusBotNotification extends NotificationBaseInfo {
  public wePlusBotToken = '';
  public wePlusBotReceiver = '';
  public wePlusBotVersion = '';
}

export class EmailNotification extends NotificationBaseInfo {
  public smtpService: string = '';
  public smtpName: string = '';
  public smtpPassword: string = '';
}

export class PushMeNotification extends NotificationBaseInfo {
  public pushmeKey: string = '';
  public pushmeUrl: string = '';
}

export class ChronocatNotification extends NotificationBaseInfo {
  public chronocatURL: string = '';
  public chronocatQQ: string = '';
  public chronocatToken: string = '';
}

export class WebhookNotification extends NotificationBaseInfo {
  public webhookHeaders: string = '';
  public webhookBody: string = '';
  public webhookUrl: string = '';
  public webhookMethod: 'GET' | 'POST' | 'PUT' = 'GET';
  public webhookContentType:
    | 'application/json'
    | 'multipart/form-data'
    | 'application/x-www-form-urlencoded' = 'application/json';
}

export class LarkNotification extends NotificationBaseInfo {
  public fskey = '';
}

export interface NotificationInfo
  extends GoCqHttpBotNotification,
    GotifyNotification,
    ServerChanNotification,
    PushDeerNotification,
    ChatNotification,
    BarkNotification,
    TelegramBotNotification,
    DingtalkBotNotification,
    WeWorkBotNotification,
    WeWorkAppNotification,
    AibotkNotification,
    IGotNotification,
    PushPlusNotification,
    WePlusBotNotification,
    EmailNotification,
    PushMeNotification,
    WebhookNotification,
    ChronocatNotification,
    LarkNotification {}

