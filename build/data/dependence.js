"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DependenceModel = exports.unInstallDependenceCommandTypes = exports.InstallDependenceCommandTypes = exports.DependenceTypes = exports.DependenceStatus = exports.Dependence = void 0;
const _1 = require(".");
const sequelize_1 = require("sequelize");
class Dependence {
    constructor(options) {
        this.id = options.id;
        this.status = options.status || DependenceStatus.installing;
        this.type = options.type || DependenceTypes.nodejs;
        this.timestamp = new Date().toString();
        this.name = options.name;
        this.log = options.log || [];
        this.remark = options.remark || '';
    }
}
exports.Dependence = Dependence;
var DependenceStatus;
(function (DependenceStatus) {
    DependenceStatus[DependenceStatus["installing"] = 0] = "installing";
    DependenceStatus[DependenceStatus["installed"] = 1] = "installed";
    DependenceStatus[DependenceStatus["installFailed"] = 2] = "installFailed";
    DependenceStatus[DependenceStatus["removing"] = 3] = "removing";
    DependenceStatus[DependenceStatus["removed"] = 4] = "removed";
    DependenceStatus[DependenceStatus["removeFailed"] = 5] = "removeFailed";
})(DependenceStatus = exports.DependenceStatus || (exports.DependenceStatus = {}));
var DependenceTypes;
(function (DependenceTypes) {
    DependenceTypes[DependenceTypes["nodejs"] = 0] = "nodejs";
    DependenceTypes[DependenceTypes["python3"] = 1] = "python3";
    DependenceTypes[DependenceTypes["linux"] = 2] = "linux";
})(DependenceTypes = exports.DependenceTypes || (exports.DependenceTypes = {}));
var InstallDependenceCommandTypes;
(function (InstallDependenceCommandTypes) {
    InstallDependenceCommandTypes[InstallDependenceCommandTypes["pnpm add -g"] = 0] = "pnpm add -g";
    InstallDependenceCommandTypes[InstallDependenceCommandTypes["pip3 install"] = 1] = "pip3 install";
    InstallDependenceCommandTypes[InstallDependenceCommandTypes["apk add"] = 2] = "apk add";
})(InstallDependenceCommandTypes = exports.InstallDependenceCommandTypes || (exports.InstallDependenceCommandTypes = {}));
var unInstallDependenceCommandTypes;
(function (unInstallDependenceCommandTypes) {
    unInstallDependenceCommandTypes[unInstallDependenceCommandTypes["pnpm remove -g"] = 0] = "pnpm remove -g";
    unInstallDependenceCommandTypes[unInstallDependenceCommandTypes["pip3 uninstall -y"] = 1] = "pip3 uninstall -y";
    unInstallDependenceCommandTypes[unInstallDependenceCommandTypes["apk del"] = 2] = "apk del";
})(unInstallDependenceCommandTypes = exports.unInstallDependenceCommandTypes || (exports.unInstallDependenceCommandTypes = {}));
exports.DependenceModel = _1.sequelize.define('Dependence', {
    name: sequelize_1.DataTypes.STRING,
    type: sequelize_1.DataTypes.NUMBER,
    timestamp: sequelize_1.DataTypes.STRING,
    status: sequelize_1.DataTypes.NUMBER,
    log: sequelize_1.DataTypes.JSON,
    remark: sequelize_1.DataTypes.STRING,
});
//# sourceMappingURL=dependence.js.map