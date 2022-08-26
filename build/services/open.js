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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const typedi_1 = require("typedi");
const winston_1 = __importDefault(require("winston"));
const util_1 = require("../config/util");
const open_1 = require("../data/open");
const uuid_1 = require("uuid");
const sequelize_1 = require("sequelize");
let OpenService = class OpenService {
    constructor(logger) {
        this.logger = logger;
    }
    async findTokenByValue(token) {
        const docs = await this.find({});
        const doc = docs.filter((x) => { var _a; return (_a = x.tokens) === null || _a === void 0 ? void 0 : _a.find((y) => y.value === token); });
        return doc[0];
    }
    async create(payload) {
        const tab = Object.assign({}, payload);
        tab.client_id = (0, util_1.createRandomString)(12, 12);
        tab.client_secret = (0, util_1.createRandomString)(24, 24);
        const doc = await this.insert(tab);
        return Object.assign(Object.assign({}, doc), { tokens: [] });
    }
    async insert(payload) {
        const doc = await open_1.AppModel.create(payload, { returning: true });
        return doc.get({ plain: true });
    }
    async update(payload) {
        const newDoc = await this.updateDb({
            name: payload.name,
            scopes: payload.scopes,
            id: payload.id,
        });
        return Object.assign(Object.assign({}, newDoc), { tokens: [] });
    }
    async updateDb(payload) {
        await open_1.AppModel.update(payload, { where: { id: payload.id } });
        return await this.getDb({ id: payload.id });
    }
    async getDb(query) {
        const doc = await open_1.AppModel.findOne({ where: query });
        return doc && doc.get({ plain: true });
    }
    async remove(ids) {
        await open_1.AppModel.destroy({ where: { id: ids } });
    }
    async resetSecret(id) {
        const tab = {
            client_secret: (0, util_1.createRandomString)(24, 24),
            tokens: [],
            id,
        };
        // const doc = await this.get(id);
        // const tab = new App({ ...doc });
        // tab.client_secret = createRandomString(24, 24);
        // tab.tokens = [];
        // const newDoc = await this.updateDb(tab);
        // return newDoc;
        const newDoc = await this.updateDb(tab);
        return newDoc;
    }
    async list(searchText = '', sort = {}, query = {}) {
        let condition = Object.assign({}, query);
        if (searchText) {
            const encodeText = encodeURIComponent(searchText);
            const reg = {
                [sequelize_1.Op.or]: [
                    { [sequelize_1.Op.like]: `%${searchText}%` },
                    { [sequelize_1.Op.like]: `%${encodeText}%` },
                ],
            };
            condition = Object.assign(Object.assign({}, condition), { name: reg });
        }
        try {
            const result = await this.find(condition);
            return result
                .filter((x) => x.name !== 'system')
                .map((x) => (Object.assign(Object.assign({}, x), { tokens: [] })));
        }
        catch (error) {
            throw error;
        }
    }
    async find(query, sort) {
        const docs = await open_1.AppModel.findAll({ where: Object.assign({}, query) });
        return docs.map((x) => x.get({ plain: true }));
    }
    async authToken({ client_id, client_secret, }) {
        let token = (0, uuid_1.v4)();
        const expiration = Math.round(Date.now() / 1000) + 2592000; // 2592000 30天
        const doc = await open_1.AppModel.findOne({ where: { client_id, client_secret } });
        if (doc) {
            const timestamp = Math.round(Date.now() / 1000);
            const invalidTokens = (doc.tokens || []).filter((x) => x.expiration >= timestamp);
            let tokens = invalidTokens;
            if (invalidTokens.length > 5) {
                tokens = [
                    ...invalidTokens.slice(0, 4),
                    Object.assign(Object.assign({}, invalidTokens[4]), { expiration }),
                ];
                token = invalidTokens[4].value;
            }
            else {
                tokens = [...invalidTokens, { value: token, expiration }];
            }
            await open_1.AppModel.update({ tokens }, { where: { client_id, client_secret } });
            return {
                code: 200,
                data: {
                    token,
                    token_type: 'Bearer',
                    expiration,
                },
            };
        }
        else {
            return { code: 400, message: 'client_id或client_seret有误' };
        }
    }
    async generateSystemToken() {
        let systemApp = (await open_1.AppModel.findOne({
            where: { name: 'system' },
        }));
        if (!systemApp) {
            systemApp = await this.create({
                name: 'system',
                scopes: ['crons', 'system'],
            });
        }
        const { data } = await this.authToken({
            client_id: systemApp.client_id,
            client_secret: systemApp.client_secret,
        });
        return Object.assign(Object.assign({}, data), { value: data.token });
    }
};
OpenService = __decorate([
    (0, typedi_1.Service)(),
    __param(0, (0, typedi_1.Inject)('logger')),
    __metadata("design:paramtypes", [winston_1.default.Logger])
], OpenService);
exports.default = OpenService;
//# sourceMappingURL=open.js.map