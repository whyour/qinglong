"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("./logger"));
const path_1 = __importDefault(require("path"));
const nedb_1 = __importDefault(require("nedb"));
const env_1 = require("../data/env");
const cron_1 = require("../data/cron");
const dependence_1 = require("../data/dependence");
const open_1 = require("../data/open");
const auth_1 = require("../data/auth");
const util_1 = require("../config/util");
const subscription_1 = require("../data/subscription");
const config_1 = __importDefault(require("../config"));
exports.default = async () => {
    try {
        await cron_1.CrontabModel.sync();
        await dependence_1.DependenceModel.sync();
        await open_1.AppModel.sync();
        await auth_1.AuthModel.sync();
        await env_1.EnvModel.sync();
        await subscription_1.SubscriptionModel.sync();
        // try {
        //   const queryInterface = sequelize.getQueryInterface();
        //   await queryInterface.addIndex('Crontabs', ['command'], { unique: true });
        //   await queryInterface.addIndex('Envs', ['name', 'value'], { unique: true });
        //   await queryInterface.addIndex('Apps', ['name'], { unique: true });
        // } catch (error) { }
        // 2.10-2.11 升级
        const cronDbFile = path_1.default.join(config_1.default.rootPath, 'db/crontab.db');
        const envDbFile = path_1.default.join(config_1.default.rootPath, 'db/env.db');
        const appDbFile = path_1.default.join(config_1.default.rootPath, 'db/app.db');
        const authDbFile = path_1.default.join(config_1.default.rootPath, 'db/auth.db');
        const dependenceDbFile = path_1.default.join(config_1.default.rootPath, 'db/dependence.db');
        const crondbExist = await (0, util_1.fileExist)(cronDbFile);
        const dependenceDbExist = await (0, util_1.fileExist)(dependenceDbFile);
        const envDbExist = await (0, util_1.fileExist)(envDbFile);
        const appDbExist = await (0, util_1.fileExist)(appDbFile);
        const authDbExist = await (0, util_1.fileExist)(authDbFile);
        const cronCount = await cron_1.CrontabModel.count();
        const dependenceCount = await dependence_1.DependenceModel.count();
        const envCount = await env_1.EnvModel.count();
        const appCount = await open_1.AppModel.count();
        const authCount = await auth_1.AuthModel.count();
        if (crondbExist && cronCount === 0) {
            const cronDb = new nedb_1.default({
                filename: cronDbFile,
                autoload: true,
            });
            cronDb.persistence.compactDatafile();
            cronDb.find({}).exec(async (err, docs) => {
                await cron_1.CrontabModel.bulkCreate(docs, { ignoreDuplicates: true });
            });
        }
        if (dependenceDbExist && dependenceCount === 0) {
            const dependenceDb = new nedb_1.default({
                filename: dependenceDbFile,
                autoload: true,
            });
            dependenceDb.persistence.compactDatafile();
            dependenceDb.find({}).exec(async (err, docs) => {
                await dependence_1.DependenceModel.bulkCreate(docs, { ignoreDuplicates: true });
            });
        }
        if (envDbExist && envCount === 0) {
            const envDb = new nedb_1.default({
                filename: envDbFile,
                autoload: true,
            });
            envDb.persistence.compactDatafile();
            envDb.find({}).exec(async (err, docs) => {
                await env_1.EnvModel.bulkCreate(docs, { ignoreDuplicates: true });
            });
        }
        if (appDbExist && appCount === 0) {
            const appDb = new nedb_1.default({
                filename: appDbFile,
                autoload: true,
            });
            appDb.persistence.compactDatafile();
            appDb.find({}).exec(async (err, docs) => {
                await open_1.AppModel.bulkCreate(docs, { ignoreDuplicates: true });
            });
        }
        if (authDbExist && authCount === 0) {
            const authDb = new nedb_1.default({
                filename: authDbFile,
                autoload: true,
            });
            authDb.persistence.compactDatafile();
            authDb.find({}).exec(async (err, docs) => {
                await auth_1.AuthModel.bulkCreate(docs, { ignoreDuplicates: true });
            });
        }
        logger_1.default.info('✌️ DB loaded');
    }
    catch (error) {
        logger_1.default.info('✌️ DB load failed');
        logger_1.default.info(error);
    }
};
//# sourceMappingURL=db.js.map