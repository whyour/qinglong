"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const typedi_1 = require("typedi");
const winston_1 = __importDefault(require("winston"));
const config_1 = __importDefault(require("../config"));
const fs = __importStar(require("fs"));
const auth_1 = require("../data/auth");
const notify_1 = __importDefault(require("./notify"));
const schedule_1 = __importDefault(require("./schedule"));
const child_process_1 = require("child_process");
const sock_1 = __importDefault(require("./sock"));
const got_1 = __importDefault(require("got"));
let SystemService = class SystemService {
    constructor(logger, scheduleService, sockService) {
        this.logger = logger;
        this.scheduleService = scheduleService;
        this.sockService = sockService;
    }
    async getLogRemoveFrequency() {
        const doc = await this.getDb({ type: auth_1.AuthDataType.removeLogFrequency });
        return doc || {};
    }
    async updateAuthDb(payload) {
        await auth_1.AuthModel.upsert(Object.assign({}, payload));
        const doc = await this.getDb({ type: payload.type });
        return doc;
    }
    async getDb(query) {
        const doc = await auth_1.AuthModel.findOne({ where: Object.assign({}, query) });
        return doc && doc.get({ plain: true });
    }
    async updateNotificationMode(notificationInfo) {
        const code = Math.random().toString().slice(-6);
        const isSuccess = await this.notificationService.testNotify(notificationInfo, '青龙', `【蛟龙】测试通知 https://t.me/jiao_long`);
        if (isSuccess) {
            const result = await this.updateAuthDb({
                type: auth_1.AuthDataType.notification,
                info: Object.assign({}, notificationInfo),
            });
            return { code: 200, data: Object.assign(Object.assign({}, result), { code }) };
        }
        else {
            return { code: 400, message: '通知发送失败，请检查参数' };
        }
    }
    async updateLogRemoveFrequency(frequency) {
        const oDoc = await this.getLogRemoveFrequency();
        const result = await this.updateAuthDb(Object.assign(Object.assign({}, oDoc), { type: auth_1.AuthDataType.removeLogFrequency, info: { frequency } }));
        const cron = {
            id: result.id,
            name: '删除日志',
            command: `ql rmlog ${frequency}`,
        };
        await this.scheduleService.cancelIntervalTask(cron);
        if (frequency > 0) {
            await this.scheduleService.createIntervalTask(cron, {
                days: frequency,
                runImmediately: true,
            });
        }
        return { code: 200, data: Object.assign({}, cron) };
    }
    async checkUpdate() {
        try {
            const versionRegx = /.*export const version = \'(.*)\'\;/;
            const logRegx = /.*export const changeLog = \`((.*\n.*)+)\`;/;
            const currentVersionFile = fs.readFileSync(config_1.default.versionFile, 'utf8');
            const currentVersion = currentVersionFile.match(versionRegx)[1];
            let lastVersion = '';
            let lastLog = '';
            try {
                const result = await got_1.default.get(config_1.default.lastVersionFile, {
                    timeout: 6000,
                    retry: 0,
                });
                const lastVersionFileContent = result.body;
                lastVersion = lastVersionFileContent.match(versionRegx)[1];
                lastLog = lastVersionFileContent.match(logRegx)
                    ? lastVersionFileContent.match(logRegx)[1]
                    : '';
            }
            catch (error) { }
            return {
                code: 200,
                data: {
                    hasNewVersion: this.checkHasNewVersion(currentVersion, lastVersion),
                    lastVersion,
                    lastLog,
                },
            };
        }
        catch (error) {
            return {
                code: 400,
                message: error.message,
            };
        }
    }
    checkHasNewVersion(curVersion, lastVersion) {
        const curArr = curVersion.split('.').map((x) => parseInt(x, 10));
        const lastArr = lastVersion.split('.').map((x) => parseInt(x, 10));
        if (curArr[0] < lastArr[0]) {
            return true;
        }
        if (curArr[0] === lastArr[0] && curArr[1] < lastArr[1]) {
            return true;
        }
        if (curArr[0] === lastArr[0] &&
            curArr[1] === lastArr[1] &&
            curArr[2] < lastArr[2]) {
            return true;
        }
        return false;
    }
    async updateSystem() {
        const cp = (0, child_process_1.spawn)('ql -l update', { shell: '/bin/bash' });
        this.sockService.sendMessage({
            type: 'updateSystemVersion',
            message: `开始更新系统`,
        });
        cp.stdout.on('data', (data) => {
            this.sockService.sendMessage({
                type: 'updateSystemVersion',
                message: data.toString(),
            });
        });
        cp.stderr.on('data', (data) => {
            this.sockService.sendMessage({
                type: 'updateSystemVersion',
                message: data.toString(),
            });
        });
        cp.on('error', (err) => {
            this.sockService.sendMessage({
                type: 'updateSystemVersion',
                message: JSON.stringify(err),
            });
        });
        return { code: 200 };
    }
    async notify({ title, content }) {
        const isSuccess = await this.notificationService.notify(title, content);
        if (isSuccess) {
            return { code: 200, message: '通知发送成功' };
        }
        else {
            return { code: 400, message: '通知发送失败，请检查系统设置/通知配置' };
        }
    }
};
__decorate([
    (0, typedi_1.Inject)((type) => notify_1.default),
    __metadata("design:type", notify_1.default)
], SystemService.prototype, "notificationService", void 0);
SystemService = __decorate([
    (0, typedi_1.Service)(),
    __param(0, (0, typedi_1.Inject)('logger')),
    __metadata("design:paramtypes", [winston_1.default.Logger, schedule_1.default,
        sock_1.default])
], SystemService);
exports.default = SystemService;
//# sourceMappingURL=system.js.map