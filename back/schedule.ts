import schedule from 'node-schedule';
import DataStore from 'nedb';
import config from './config';
import { exec } from 'child_process';
import Logger from './loaders/logger';

const db = new DataStore({ filename: config.cronDbFile, autoload: true });

const run = async () => {
  db.find({})
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
