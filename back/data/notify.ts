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
  public GOBOT_URL = '';
  public GOBOT_TOKEN = '';
  public GOBOT_QQ = '';
}

export class ServerChanNotification extends NotificationBaseInfo {
  public SCKEY = '';
}

export class BarkNotification extends NotificationBaseInfo {
  public BARK_PUSH = '';
  public BARK_SOUND = '';
  public BARK_GROUP = 'qinglong';
}

export class TelegramBotNotification extends NotificationBaseInfo {
  public TG_BOT_TOKEN = '';
  public TG_USER_ID = '';
  public TG_PROXY_HOST = '';
  public TG_PROXY_PORT = '';
  public TG_PROXY_AUTH = '';
  public TG_API_HOST = 'api.telegram.org';
}

export class DingtalkBotNotification extends NotificationBaseInfo {
  public DD_BOT_TOKEN = '';
  public DD_BOT_SECRET = '';
}

export class WeWorkBotNotification extends NotificationBaseInfo {
  public QYWX_KEY = '';
}

export class WeWorkAppNotification extends NotificationBaseInfo {
  public QYWX_AM = '';
}

export class IGotNotification extends NotificationBaseInfo {
  public IGOT_PUSH_KEY = '';
}

export class PushPlusNotification extends NotificationBaseInfo {
  public PUSH_PLUS_TOKEN = '';
  public PUSH_PLUS_USER = '';
}

export class EmailNotification extends NotificationBaseInfo {
  public service: string = '';
  public user: string = '';
  public pass: string = '';
}

export type NotificationInfo =
  | GoCqHttpBotNotification
  | ServerChanNotification
  | BarkNotification
  | TelegramBotNotification
  | DingtalkBotNotification
  | WeWorkBotNotification
  | IGotNotification
  | PushPlusNotification
  | EmailNotification;
