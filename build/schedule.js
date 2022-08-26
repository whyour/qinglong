"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_schedule_1 = __importDefault(require("node-schedule"));
const express_1 = __importDefault(require("express"));
const child_process_1 = require("child_process");
const logger_1 = __importDefault(require("./loaders/logger"));
const cron_1 = require("./data/cron");
const config_1 = __importDefault(require("./config"));
const app = (0, express_1.default)();
const run = async () => {
    cron_1.CrontabModel.findAll({ where: {} })
        .then((docs) => {
        if (docs && docs.length > 0) {
            for (let i = 0; i < docs.length; i++) {
                const task = docs[i];
                const _schedule = task.schedule && task.schedule.split(/ +/);
                if (_schedule &&
                    _schedule.length > 5 &&
                    task.status !== cron_1.CrontabStatus.disabled &&
                    !task.isDisabled) {
                    node_schedule_1.default.scheduleJob(task.schedule, function () {
                        let command = task.command;
                        if (!command.includes('task ') && !command.includes('ql ')) {
                            command = `task ${command}`;
                        }
                        (0, child_process_1.exec)(command);
                    });
                }
            }
        }
    })
        .catch((err) => {
        logger_1.default.error(err);
        process.exit(1);
    });
};
app
    .listen(config_1.default.cronPort, async () => {
    await require('./loaders/sentry').default({ expressApp: app });
    await require('./loaders/db').default();
    await run();
    logger_1.default.info(`
      ################################################
      🛡️  Schedule listening on port: ${config_1.default.cronPort} 🛡️
      ################################################
    `);
})
    .on('error', (err) => {
    logger_1.default.error(err);
    process.exit(1);
});
//# sourceMappingURL=schedule.js.map