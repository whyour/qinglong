"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModel = exports.CrontabStatus = exports.App = void 0;
const _1 = require(".");
const sequelize_1 = require("sequelize");
class App {
    constructor(options) {
        this.name = options.name;
        this.scopes = options.scopes;
        this.client_id = options.client_id;
        this.client_secret = options.client_secret;
        this.id = options.id;
    }
}
exports.App = App;
var CrontabStatus;
(function (CrontabStatus) {
    CrontabStatus[CrontabStatus["running"] = 0] = "running";
    CrontabStatus[CrontabStatus["idle"] = 1] = "idle";
    CrontabStatus[CrontabStatus["disabled"] = 2] = "disabled";
    CrontabStatus[CrontabStatus["queued"] = 3] = "queued";
})(CrontabStatus = exports.CrontabStatus || (exports.CrontabStatus = {}));
exports.AppModel = _1.sequelize.define('App', {
    name: { type: sequelize_1.DataTypes.STRING, unique: 'name' },
    scopes: sequelize_1.DataTypes.JSON,
    client_id: sequelize_1.DataTypes.STRING,
    client_secret: sequelize_1.DataTypes.STRING,
    tokens: sequelize_1.DataTypes.JSON,
});
//# sourceMappingURL=open.js.map