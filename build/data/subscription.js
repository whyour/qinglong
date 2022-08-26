"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubscriptionModel = exports.SubscriptionStatus = exports.Subscription = void 0;
const _1 = require(".");
const sequelize_1 = require("sequelize");
class Subscription {
    constructor(options) {
        this.id = options.id;
        this.name = options.name || options.alias;
        this.type = options.type;
        this.schedule = options.schedule;
        this.status =
            options.status && SubscriptionStatus[options.status]
                ? options.status
                : SubscriptionStatus.idle;
        this.url = options.url;
        this.whitelist = options.whitelist;
        this.blacklist = options.blacklist;
        this.dependences = options.dependences;
        this.branch = options.branch;
        this.pull_type = options.pull_type;
        this.pull_option = options.pull_option;
        this.pid = options.pid;
        this.is_disabled = options.is_disabled;
        this.log_path = options.log_path;
        this.schedule_type = options.schedule_type;
        this.alias = options.alias;
        this.interval_schedule = options.interval_schedule;
        this.extensions = options.extensions;
        this.sub_before = options.sub_before;
        this.sub_after = options.sub_after;
    }
}
exports.Subscription = Subscription;
var SubscriptionStatus;
(function (SubscriptionStatus) {
    SubscriptionStatus[SubscriptionStatus["running"] = 0] = "running";
    SubscriptionStatus[SubscriptionStatus["idle"] = 1] = "idle";
    SubscriptionStatus[SubscriptionStatus["disabled"] = 2] = "disabled";
    SubscriptionStatus[SubscriptionStatus["queued"] = 3] = "queued";
})(SubscriptionStatus = exports.SubscriptionStatus || (exports.SubscriptionStatus = {}));
exports.SubscriptionModel = _1.sequelize.define('Subscription', {
    name: {
        unique: 'compositeIndex',
        type: sequelize_1.DataTypes.STRING,
    },
    url: {
        unique: 'compositeIndex',
        type: sequelize_1.DataTypes.STRING,
    },
    schedule: {
        unique: 'compositeIndex',
        type: sequelize_1.DataTypes.STRING,
    },
    interval_schedule: {
        unique: 'compositeIndex',
        type: sequelize_1.DataTypes.JSON,
    },
    type: sequelize_1.DataTypes.STRING,
    whitelist: sequelize_1.DataTypes.STRING,
    blacklist: sequelize_1.DataTypes.STRING,
    status: sequelize_1.DataTypes.NUMBER,
    dependences: sequelize_1.DataTypes.STRING,
    extensions: sequelize_1.DataTypes.STRING,
    sub_before: sequelize_1.DataTypes.STRING,
    sub_after: sequelize_1.DataTypes.STRING,
    branch: sequelize_1.DataTypes.STRING,
    pull_type: sequelize_1.DataTypes.STRING,
    pull_option: sequelize_1.DataTypes.JSON,
    pid: sequelize_1.DataTypes.NUMBER,
    is_disabled: sequelize_1.DataTypes.NUMBER,
    log_path: sequelize_1.DataTypes.STRING,
    schedule_type: sequelize_1.DataTypes.STRING,
    alias: { type: sequelize_1.DataTypes.STRING, unique: 'alias' },
});
//# sourceMappingURL=subscription.js.map