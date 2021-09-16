export enum NotificationMode {
  'goCqHttpBot' = 'goCqHttpBot',
  'serverChan' = 'serverChan',
  'bark' = 'bark',
  'telegramBot' = 'telegramBot',
  'dingtalkBot' = 'dingtalkBot',
  'weWorkBot' = 'weWorkBot',
  'weWorkApp' = 'weWorkApp',
  'iGot' = 'iGot',
  'pushPlus' = 'pushPlus',
  'email' = 'email',
}

abstract class NotificationBaseInfo {
  public type!: NotificationMode;
}

export class GoCqHttpBotNotification extends NotificationBaseInfo {
  public goCqHttpBotUrl = '';
  public goCqHttpBotToken = '';
  public goCqHttpBotQq = '';
}

export class ServerChanNotification extends NotificationBaseInfo {
  public serverChanKey = '';
}

export class BarkNotification extends NotificationBaseInfo {
  public barkPush = '';
  public barkSound = '';
  public barkGroup = 'qinglong';
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
}

export class WeWorkAppNotification extends NotificationBaseInfo {
  public weWorkAppKey = '';
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

export interface NotificationInfo
  extends GoCqHttpBotNotification,
    ServerChanNotification,
    BarkNotification,
    TelegramBotNotification,
    DingtalkBotNotification,
    WeWorkBotNotification,
    WeWorkAppNotification,
    IGotNotification,
    PushPlusNotification,
    EmailNotification {}
