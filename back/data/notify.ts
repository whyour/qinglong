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
  'ntfy' = 'ntfy',
  'wxPusherBot' = 'wxPusherBot',
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

export class synologyChatNotification extends NotificationBaseInfo {
  public synologyChatUrl = '';
}

export class BarkNotification extends NotificationBaseInfo {
  public barkPush = '';
  public barkIcon = 'https://qn.whyour.cn/logo.png';
  public barkSound = '';
  public barkGroup = 'qinglong';
  public barkLevel = 'active';
  public barkUrl = '';
  public barkArchive = '';
}

export class TelegramBotNotification extends NotificationBaseInfo {
  public telegramBotToken = '';
  public telegramBotUserId = '';
  public telegramBotProxyHost = '';
  public telegramBotProxyPort = '';
  public telegramBotProxyAuth = '';
  public telegramBotApiHost = 'https://api.telegram.org';
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
  public pushPlusTemplate = '';
  public pushplusChannel = '';
  public pushplusWebhook = '';
  public pushplusCallbackUrl = '';
  public pushplusTo = '';
}

export class WePlusBotNotification extends NotificationBaseInfo {
  public wePlusBotToken = '';
  public wePlusBotReceiver = '';
  public wePlusBotVersion = '';
}

export class EmailNotification extends NotificationBaseInfo {
  public emailService: string = '';
  public emailUser: string = '';
  public emailPass: string = '';
  public emailTo: string = '';
}

export class PushMeNotification extends NotificationBaseInfo {
  public pushMeKey: string = '';
  public pushMeUrl: string = '';
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
  public larkKey = '';
}

export class NtfyNotification extends NotificationBaseInfo {
  public ntfyUrl = '';
  public ntfyTopic = '';
  public ntfyPriority = '';
  public ntfyToken = '';
  public ntfyUsername = '';
  public ntfyPassword = '';
  public ntfyActions = '';
}

export class WxPusherBotNotification extends NotificationBaseInfo {
  public wxPusherBotAppToken = '';
  public wxPusherBotTopicIds = '';
  public wxPusherBotUids = '';
}

export interface NotificationInfo
  extends GoCqHttpBotNotification,
    GotifyNotification,
    ServerChanNotification,
    PushDeerNotification,
    synologyChatNotification,
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
    LarkNotification,
    NtfyNotification,
    WxPusherBotNotification {}
