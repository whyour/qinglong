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
  public goCqHttpBotUrl = '';
  public goCqHttpBotToken = '';
  public goCqHttpBotQq = '';
}

export class ServerChanNotification extends NotificationBaseInfo {
  public serverChanKey = '';
}

export class PushDeerNotification extends NotificationBaseInfo {
  public pushDeerKey = '';
  public pushDeerUrl = '';
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
}

export class TelegramBotNotification extends NotificationBaseInfo {
  public telegramBotToken = '';
  public telegramBotUserId = '';
  public telegramBotProxyHost = '';
  public telegramBotProxyPort = '';
  public telegramBotProxyAuth = '';
  public telegramBotApiHost = 'api.telegram.org';
}

export class DingtalkBotNotification extends NotificationBaseInfo {
  public dingtalkBotToken = '';
  public dingtalkBotSecret = '';
}

export class WeWorkBotNotification extends NotificationBaseInfo {
  public weWorkBotKey = '';
  public weWorkOrigin = '';
}

export class WeWorkAppNotification extends NotificationBaseInfo {
  public weWorkAppKey = '';
  public weWorkOrigin = '';
}

export class AibotkNotification extends NotificationBaseInfo {
  public aibotkKey: string = '';
  public aibotkType: 'room' | 'contact' = 'room';
  public aibotkName: string = '';
}

export class IGotNotification extends NotificationBaseInfo {
  public iGotPushKey = '';
}

export class PushPlusNotification extends NotificationBaseInfo {
  public pushPlusToken = '';
  public pushPlusUser = '';
}

export class EmailNotification extends NotificationBaseInfo {
  public emailService: string = '';
  public emailUser: string = '';
  public emailPass: string = '';
}

export class PushMeNotification extends NotificationBaseInfo {
  public pushMeKey: string = '';
}

export class ChronocatNotification extends NotificationBaseInfo {
  public chronocatURL: string = '';
  public chronocatQQ: string = '';
  public chronocatToekn: string = '';
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
  public larkKey = '';
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
    EmailNotification,
    PushMeNotification,
    WebhookNotification,
    ChronocatNotification,
    LarkNotification {}
    
