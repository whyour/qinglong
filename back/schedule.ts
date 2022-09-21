import schedule from 'node-schedule';
import express from 'express';
import { exec } from 'child_process';
import Logger from './loaders/logger';
import { CrontabModel, CrontabStatus } from './data/cron';
import config from './config';

const app = express();

const run = async () => {
  CrontabModel.findAll({ where: {} })
    .then((docs) => {
      if (docs && docs.length > 0) {
        for (let i = 0; i < docs.length; i++) {
          const task = docs[i];
          const _schedule = task.schedule && task.schedule.split(/ +/);
          if (
            _schedule &&
            _schedule.length > 5 &&
            task.status !== CrontabStatus.disabled &&
            !task.isDisabled &&
            task.schedule
          ) {
            schedule.scheduleJob(task.schedule, function () {
              let command = task.command as string;
              if (!command.includes('task ') && !command.includes('ql ')) {
                command = `task ${command}`;
              }
              exec(`ID=${task.id} ${command}`);
            });
          }
        }
      }
    })
    .catch((err) => {
      Logger.error(err);
      process.exit(1);
    });
};

app
  .listen(config.cronPort, async () => {
    await require('./loaders/sentry').default({ expressApp: app });
    await require('./loaders/db').default();

    await run();
    Logger.debug('定时任务服务启动成功！');
  })
  .on('error', (err) => {
    Logger.error(err);
    process.exit(1);
  });
