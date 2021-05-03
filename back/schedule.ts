import schedule from 'node-schedule';
import { exec } from 'child_process';
import Logger from './loaders/logger';
import { Container } from 'typedi';
import CronService from './services/cron';

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
          if (_schedule && _schedule.length > 5) {
            schedule.scheduleJob(task.schedule, function () {
              exec(task.command);
            });
          }
        }
      }
    });
};

run();
Logger.info(`
  ################################################
  🛡️  定时任务schedule启动成功 🛡️
  ################################################
`);
