"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("./express"));
const depInjector_1 = __importDefault(require("./depInjector"));
const logger_1 = __importDefault(require("./logger"));
const initData_1 = __importDefault(require("./initData"));
const deps_1 = __importDefault(require("./deps"));
const initTask_1 = __importDefault(require("./initTask"));
exports.default = async ({ expressApp }) => {
    await (0, depInjector_1.default)();
    logger_1.default.info('✌️ Dependency Injector loaded');
    await (0, express_1.default)({ app: expressApp });
    logger_1.default.info('✌️ Express loaded');
    await (0, initData_1.default)();
    logger_1.default.info('✌️ init data loaded');
    await (0, deps_1.default)();
    logger_1.default.info('✌️ link deps loaded');
    (0, initTask_1.default)();
    logger_1.default.info('✌️ init task loaded');
};
//# sourceMappingURL=app.js.map