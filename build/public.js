"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const child_process_1 = require("child_process");
const logger_1 = __importDefault(require("./loaders/logger"));
const config_1 = __importDefault(require("./config"));
const app = (0, express_1.default)();
app.get('/api/public/panel/log', (req, res) => {
    (0, child_process_1.exec)('pm2 logs panel --lines 500 --nostream --timestamp', (err, stdout, stderr) => {
        if (err || stderr) {
            return res.send({ code: 400, message: (err && err.message) || stderr });
        }
        return res.send({ code: 200, data: stdout });
    });
});
app
    .listen(config_1.default.publicPort, async () => {
    await require('./loaders/sentry').default({ expressApp: app });
    await require('./loaders/db').default();
    logger_1.default.debug(`✌️ Back server launched on port ${config_1.default.publicPort}`);
})
    .on('error', (err) => {
    logger_1.default.error(err);
    process.exit(1);
});
//# sourceMappingURL=public.js.map