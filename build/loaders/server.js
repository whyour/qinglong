"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("./logger"));
const sock_1 = __importDefault(require("./sock"));
exports.default = async ({ server }) => {
    await (0, sock_1.default)({ server });
    logger_1.default.info('✌️ Sock loaded');
    process.on('SIGINT', () => {
        logger_1.default.info('✌️ Server need close');
        server.close(() => {
            logger_1.default.info('✌️ Server closed');
            process.exit(0);
        });
    });
};
//# sourceMappingURL=server.js.map