"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const typedi_1 = require("typedi");
const winston_1 = __importDefault(require("winston"));
const dependence_1 = require("../data/dependence");
const child_process_1 = require("child_process");
const sock_1 = __importDefault(require("./sock"));
const sequelize_1 = require("sequelize");
const util_1 = require("../config/util");
const dayjs_1 = __importDefault(require("dayjs"));
let DependenceService = class DependenceService {
    constructor(logger, sockService) {
        this.logger = logger;
        this.sockService = sockService;
    }
    async create(payloads) {
        const tabs = payloads.map((x) => {
            const tab = new dependence_1.Dependence(Object.assign(Object.assign({}, x), { status: dependence_1.DependenceStatus.installing }));
            return tab;
        });
        const docs = await this.insert(tabs);
        this.installDependenceOneByOne(docs);
        return docs;
    }
    async insert(payloads) {
        const docs = await dependence_1.DependenceModel.bulkCreate(payloads);
        return docs;
    }
    async update(payload) {
        const { id } = payload, other = __rest(payload, ["id"]);
        const doc = await this.getDb({ id });
        const tab = new dependence_1.Dependence(Object.assign(Object.assign(Object.assign({}, doc), other), { status: dependence_1.DependenceStatus.installing }));
        const newDoc = await this.updateDb(tab);
        this.installDependenceOneByOne([newDoc]);
        return newDoc;
    }
    async updateDb(payload) {
        await dependence_1.DependenceModel.update(payload, { where: { id: payload.id } });
        return await this.getDb({ id: payload.id });
    }
    async remove(ids, force = false) {
        await dependence_1.DependenceModel.update({ status: dependence_1.DependenceStatus.removing, log: [] }, { where: { id: ids } });
        const docs = await dependence_1.DependenceModel.findAll({ where: { id: ids } });
        this.installDependenceOneByOne(docs, false, force);
        return docs;
    }
    async removeDb(ids) {
        await dependence_1.DependenceModel.destroy({ where: { id: ids } });
    }
    async dependencies({ searchValue, type }, sort = { position: -1 }, query = {}) {
        let condition = Object.assign(Object.assign({}, query), { type: dependence_1.DependenceTypes[type] });
        if (searchValue) {
            const encodeText = encodeURIComponent(searchValue);
            const reg = {
                [sequelize_1.Op.or]: [
                    { [sequelize_1.Op.like]: `%${searchValue}%` },
                    { [sequelize_1.Op.like]: `%${encodeText}%` },
                ],
            };
            condition = Object.assign(Object.assign({}, condition), { name: reg });
        }
        try {
            const result = await this.find(condition);
            return result;
        }
        catch (error) {
            throw error;
        }
    }
    installDependenceOneByOne(docs, isInstall = true, force = false) {
        (0, util_1.concurrentRun)(docs.map((dep) => async () => await this.installOrUninstallDependencies([dep], isInstall, force)), 1);
    }
    async reInstall(ids) {
        await dependence_1.DependenceModel.update({ status: dependence_1.DependenceStatus.installing, log: [] }, { where: { id: ids } });
        const docs = await dependence_1.DependenceModel.findAll({ where: { id: ids } });
        this.installDependenceOneByOne(docs);
        return docs;
    }
    async find(query, sort) {
        const docs = await dependence_1.DependenceModel.findAll({ where: Object.assign({}, query) });
        return docs;
    }
    async getDb(query) {
        const doc = await dependence_1.DependenceModel.findOne({ where: Object.assign({}, query) });
        return doc && doc.get({ plain: true });
    }
    async updateLog(ids, log) {
        const doc = await dependence_1.DependenceModel.findOne({ where: { id: ids } });
        const newLog = (doc === null || doc === void 0 ? void 0 : doc.log) ? [...doc.log, log] : [log];
        await dependence_1.DependenceModel.update({ log: newLog }, { where: { id: ids } });
    }
    installOrUninstallDependencies(dependencies, isInstall = true, force = false) {
        return new Promise(async (resolve) => {
            if (dependencies.length === 0) {
                resolve(null);
                return;
            }
            const socketMessageType = !force
                ? 'installDependence'
                : 'uninstallDependence';
            const depNames = dependencies.map((x) => x.name).join(' ');
            const depRunCommand = (isInstall
                ? dependence_1.InstallDependenceCommandTypes
                : dependence_1.unInstallDependenceCommandTypes)[dependencies[0].type];
            const actionText = isInstall ? '安装' : '删除';
            const depIds = dependencies.map((x) => x.id);
            const startTime = (0, dayjs_1.default)();
            const message = `开始${actionText}依赖 ${depNames}，开始时间 ${startTime.format('YYYY-MM-DD HH:mm:ss')}\n\n`;
            this.sockService.sendMessage({
                type: socketMessageType,
                message,
                references: depIds,
            });
            await this.updateLog(depIds, message);
            const cp = (0, child_process_1.spawn)(`${depRunCommand} ${depNames}`, { shell: '/bin/bash' });
            cp.stdout.on('data', async (data) => {
                this.sockService.sendMessage({
                    type: socketMessageType,
                    message: data.toString(),
                    references: depIds,
                });
                await this.updateLog(depIds, data.toString());
            });
            cp.stderr.on('data', async (data) => {
                this.sockService.sendMessage({
                    type: socketMessageType,
                    message: data.toString(),
                    references: depIds,
                });
                await this.updateLog(depIds, data.toString());
            });
            cp.on('error', async (err) => {
                this.sockService.sendMessage({
                    type: socketMessageType,
                    message: JSON.stringify(err),
                    references: depIds,
                });
                await this.updateLog(depIds, JSON.stringify(err));
                resolve(null);
            });
            cp.on('close', async (code) => {
                const endTime = (0, dayjs_1.default)();
                const isSucceed = code === 0;
                const resultText = isSucceed ? '成功' : '失败';
                const message = `\n依赖${actionText}${resultText}，结束时间 ${endTime.format('YYYY-MM-DD HH:mm:ss')}，耗时 ${endTime.diff(startTime, 'second')} 秒`;
                this.sockService.sendMessage({
                    type: socketMessageType,
                    message,
                    references: depIds,
                });
                await this.updateLog(depIds, message);
                let status = null;
                if (isSucceed) {
                    status = isInstall
                        ? dependence_1.DependenceStatus.installed
                        : dependence_1.DependenceStatus.removed;
                }
                else {
                    status = isInstall
                        ? dependence_1.DependenceStatus.installFailed
                        : dependence_1.DependenceStatus.removeFailed;
                }
                await dependence_1.DependenceModel.update({ status }, { where: { id: depIds } });
                // 如果删除依赖成功或者强制删除
                if ((isSucceed || force) && !isInstall) {
                    this.removeDb(depIds);
                }
                resolve(null);
            });
        });
    }
};
DependenceService = __decorate([
    (0, typedi_1.Service)(),
    __param(0, (0, typedi_1.Inject)('logger')),
    __metadata("design:paramtypes", [winston_1.default.Logger, sock_1.default])
], DependenceService);
exports.default = DependenceService;
//# sourceMappingURL=dependence.js.map