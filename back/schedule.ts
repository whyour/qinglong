import schedule from 'node-schedule';
import express from 'express';
import { exec } from 'child_process';
import Logger from './loaders/logger';
import { Container } from 'typedi';
import CronService from './services/cron';
import { CrontabStatus } from './data/cron';
import config from './config';

const app = express();

const run = async () => {
  const cronService = Container.get(CronService);
  const cronDb = cronService.getDb();

  cronDb
    .find({})
    .sort({ created: 1 })
    .exec((err, docs) => {
      if (err) {
        Logger.error(err);
        process.exit(1);
      }

      if (docs && docs.length > 0) {
        for (let i = 0; i < docs.length; i++) {
          const task = docs[i];
          const _schedule = task.schedule && task.schedule.split(' ');
          if (
            _schedule &&
            _schedule.length > 5 &&
            task.status !== CrontabStatus.disabled &&
            !task.isDisabled
          ) {
            schedule.scheduleJob(task.schedule, function () {
              let command = task.command as string;
              if (!command.includes('task ') && !command.includes('ql ')) {
                command = `task ${command}`;
              }
              exec(command);
            });
          }
        }
      }
    });
};

app
  .listen(config.cronPort, () => {
    run();
    Logger.info(`
      ################################################
      🛡️  Schedule listening on port: ${config.cronPort} 🛡️
      ################################################
    `);
  })
  .on('error', (err) => {
    Logger.error(err);
    process.exit(1);
  });
