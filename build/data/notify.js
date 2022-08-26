"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailNotification = exports.PushPlusNotification = exports.IGotNotification = exports.WeWorkAppNotification = exports.WeWorkBotNotification = exports.DingtalkBotNotification = exports.TelegramBotNotification = exports.BarkNotification = exports.PushDeerNotification = exports.ServerChanNotification = exports.GoCqHttpBotNotification = exports.GotifyNotification = exports.NotificationMode = void 0;
var NotificationMode;
(function (NotificationMode) {
    NotificationMode["gotify"] = "gotify";
    NotificationMode["goCqHttpBot"] = "goCqHttpBot";
    NotificationMode["serverChan"] = "serverChan";
    NotificationMode["pushDeer"] = "pushDeer";
    NotificationMode["bark"] = "bark";
    NotificationMode["telegramBot"] = "telegramBot";
    NotificationMode["dingtalkBot"] = "dingtalkBot";
    NotificationMode["weWorkBot"] = "weWorkBot";
    NotificationMode["weWorkApp"] = "weWorkApp";
    NotificationMode["iGot"] = "iGot";
    NotificationMode["pushPlus"] = "pushPlus";
    NotificationMode["email"] = "email";
})(NotificationMode = exports.NotificationMode || (exports.NotificationMode = {}));
class NotificationBaseInfo {
}
class GotifyNotification extends NotificationBaseInfo {
    constructor() {
        super(...arguments);
        this.gotifyUrl = '';
        this.gotifyToken = '';
        this.gotifyPriority = 0;
    }
}
exports.GotifyNotification = GotifyNotification;
class GoCqHttpBotNotification extends NotificationBaseInfo {
    constructor() {
        super(...arguments);
        this.goCqHttpBotUrl = '';
        this.goCqHttpBotToken = '';
        this.goCqHttpBotQq = '';
    }
}
exports.GoCqHttpBotNotification = GoCqHttpBotNotification;
class ServerChanNotification extends NotificationBaseInfo {
    constructor() {
        super(...arguments);
        this.serverChanKey = '';
    }
}
exports.ServerChanNotification = ServerChanNotification;
class PushDeerNotification extends NotificationBaseInfo {
    constructor() {
        super(...arguments);
        this.pushDeerKey = '';
    }
}
exports.PushDeerNotification = PushDeerNotification;
class BarkNotification extends NotificationBaseInfo {
    constructor() {
        super(...arguments);
        this.barkPush = '';
        this.barkIcon = 'http://qn.whyour.cn/logo.png';
        this.barkSound = '';
        this.barkGroup = 'qinglong';
    }
}
exports.BarkNotification = BarkNotification;
class TelegramBotNotification extends NotificationBaseInfo {
    constructor() {
        super(...arguments);
        this.telegramBotToken = '';
        this.telegramBotUserId = '';
        this.telegramBotProxyHost = '';
        this.telegramBotProxyPort = '';
        this.telegramBotProxyAuth = '';
        this.telegramBotApiHost = 'api.telegram.org';
    }
}
exports.TelegramBotNotification = TelegramBotNotification;
class DingtalkBotNotification extends NotificationBaseInfo {
    constructor() {
        super(...arguments);
        this.dingtalkBotToken = '';
        this.dingtalkBotSecret = '';
    }
}
exports.DingtalkBotNotification = DingtalkBotNotification;
class WeWorkBotNotification extends NotificationBaseInfo {
    constructor() {
        super(...arguments);
        this.weWorkBotKey = '';
    }
}
exports.WeWorkBotNotification = WeWorkBotNotification;
class WeWorkAppNotification extends NotificationBaseInfo {
    constructor() {
        super(...arguments);
        this.weWorkAppKey = '';
    }
}
exports.WeWorkAppNotification = WeWorkAppNotification;
class IGotNotification extends NotificationBaseInfo {
    constructor() {
        super(...arguments);
        this.iGotPushKey = '';
    }
}
exports.IGotNotification = IGotNotification;
class PushPlusNotification extends NotificationBaseInfo {
    constructor() {
        super(...arguments);
        this.pushPlusToken = '';
        this.pushPlusUser = '';
    }
}
exports.PushPlusNotification = PushPlusNotification;
class EmailNotification extends NotificationBaseInfo {
    constructor() {
        super(...arguments);
        this.emailService = '';
        this.emailUser = '';
        this.emailPass = '';
    }
}
exports.EmailNotification = EmailNotification;
//# sourceMappingURL=notify.js.map