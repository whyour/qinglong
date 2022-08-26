"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthModel = exports.AuthDataType = exports.LoginStatus = exports.AuthInfo = void 0;
const _1 = require(".");
const sequelize_1 = require("sequelize");
class AuthInfo {
    constructor(options) {
        this.ip = options.ip;
        this.info = options.info;
        this.type = options.type;
        this.id = options.id;
    }
}
exports.AuthInfo = AuthInfo;
var LoginStatus;
(function (LoginStatus) {
    LoginStatus[LoginStatus["success"] = 0] = "success";
    LoginStatus[LoginStatus["fail"] = 1] = "fail";
})(LoginStatus = exports.LoginStatus || (exports.LoginStatus = {}));
var AuthDataType;
(function (AuthDataType) {
    AuthDataType["loginLog"] = "loginLog";
    AuthDataType["authToken"] = "authToken";
    AuthDataType["notification"] = "notification";
    AuthDataType["removeLogFrequency"] = "removeLogFrequency";
})(AuthDataType = exports.AuthDataType || (exports.AuthDataType = {}));
exports.AuthModel = _1.sequelize.define('Auth', {
    ip: sequelize_1.DataTypes.STRING,
    type: sequelize_1.DataTypes.STRING,
    info: {
        type: sequelize_1.DataTypes.JSON,
        allowNull: true,
    },
});
//# sourceMappingURL=auth.js.map