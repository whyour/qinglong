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
const env_1 = require("../data/env");
const lodash_1 = __importDefault(require("lodash"));
const sequelize_1 = require("sequelize");
let EnvService = class EnvService {
    constructor(logger) {
        this.logger = logger;
    }
    async create(payloads) {
        const envs = await this.envs();
        let position = env_1.initEnvPosition;
        if (envs && envs.length > 0 && envs[envs.length - 1].position) {
            position = envs[envs.length - 1].position;
        }
        const tabs = payloads.map((x) => {
            position = position / 2;
            const tab = new env_1.Env(Object.assign(Object.assign({}, x), { position }));
            return tab;
        });
        const docs = await this.insert(tabs);
        await this.set_envs();
        return docs;
    }
    async insert(payloads) {
        const result = [];
        for (const env of payloads) {
            const doc = await env_1.EnvModel.create(env, { returning: true });
            result.push(doc);
        }
        return result;
    }
    async update(payload) {
        const newDoc = await this.updateDb(payload);
        await this.set_envs();
        return newDoc;
    }
    async updateDb(payload) {
        await env_1.EnvModel.update(Object.assign({}, payload), { where: { id: payload.id } });
        return await this.getDb({ id: payload.id });
    }
    async remove(ids) {
        await env_1.EnvModel.destroy({ where: { id: ids } });
        await this.set_envs();
    }
    async move(id, { fromIndex, toIndex, }) {
        let targetPosition;
        const isUpward = fromIndex > toIndex;
        const envs = await this.envs();
        if (toIndex === 0 || toIndex === envs.length - 1) {
            targetPosition = isUpward
                ? envs[0].position * 2
                : envs[toIndex].position / 2;
        }
        else {
            targetPosition = isUpward
                ? (envs[toIndex].position + envs[toIndex - 1].position) / 2
                : (envs[toIndex].position + envs[toIndex + 1].position) / 2;
        }
        const newDoc = await this.update({
            id,
            position: targetPosition,
        });
        return newDoc;
    }
    async envs(searchText = '', sort = { position: -1 }, query = {}) {
        let condition = Object.assign({}, query);
        if (searchText) {
            const encodeText = encodeURIComponent(searchText);
            const reg = {
                [sequelize_1.Op.or]: [
                    { [sequelize_1.Op.like]: `%${searchText}%` },
                    { [sequelize_1.Op.like]: `%${encodeText}%` },
                ],
            };
            condition = Object.assign(Object.assign({}, condition), { [sequelize_1.Op.or]: [
                    {
                        name: reg,
                    },
                    {
                        value: reg,
                    },
                    {
                        remarks: reg,
                    },
                ] });
        }
        try {
            const result = await this.find(condition, [['position', 'DESC']]);
            return result;
        }
        catch (error) {
            throw error;
        }
    }
    async find(query, sort = []) {
        const docs = await env_1.EnvModel.findAll({
            where: Object.assign({}, query),
            order: [...sort],
        });
        return docs;
    }
    async getDb(query) {
        const doc = await env_1.EnvModel.findOne({ where: Object.assign({}, query) });
        return doc && doc.get({ plain: true });
    }
    async disabled(ids) {
        await env_1.EnvModel.update({ status: env_1.EnvStatus.disabled }, { where: { id: ids } });
        await this.set_envs();
    }
    async enabled(ids) {
        await env_1.EnvModel.update({ status: env_1.EnvStatus.normal }, { where: { id: ids } });
        await this.set_envs();
    }
    async updateNames({ ids, name }) {
        await env_1.EnvModel.update({ name }, { where: { id: ids } });
        await this.set_envs();
    }
    async set_envs() {
        const envs = await this.envs('', { position: -1 }, { name: { [sequelize_1.Op.not]: null } });
        const groups = lodash_1.default.groupBy(envs, 'name');
        let env_string = '';
        for (const key in groups) {
            if (Object.prototype.hasOwnProperty.call(groups, key)) {
                const group = groups[key];
                // 忽略不符合bash要求的环境变量名称
                if (/^[a-zA-Z_][0-9a-zA-Z_]+$/.test(key)) {
                    let value = (0, lodash_1.default)(group)
                        .filter((x) => x.status !== env_1.EnvStatus.disabled)
                        .map('value')
                        .join('&')
                        .replace(/(\\)[^n]/g, '\\\\')
                        .replace(/(\\$)/, '\\\\')
                        .replace(/"/g, '\\"')
                        .trim();
                    env_string += `export ${key}="${value}"\n`;
                }
            }
        }
        fs.writeFileSync(config_1.default.envFile, env_string);
    }
};
EnvService = __decorate([
    (0, typedi_1.Service)(),
    __param(0, (0, typedi_1.Inject)('logger')),
    __metadata("design:paramtypes", [winston_1.default.Logger])
], EnvService);
exports.default = EnvService;
//# sourceMappingURL=env.js.map