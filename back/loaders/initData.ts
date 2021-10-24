import DependenceService from '../services/dependence';
import { exec } from 'child_process';
import { Container } from 'typedi';
import { Crontab, CrontabStatus } from '../data/cron';
import CronService from '../services/cron';
import EnvService from '../services/env';
import _ from 'lodash';

export default async () => {
  const cronService = Container.get(CronService);
  const envService = Container.get(EnvService);
  const dependenceService = Container.get(DependenceService);
  const cronDb = cronService.getDb();
  const envDb = envService.getDb();
  const dependenceDb = dependenceService.getDb();

  // compaction data file
  cronDb.persistence.compactDatafile();
  envDb.persistence.compactDatafile();
  dependenceDb.persistence.compactDatafile();

  // 初始化更新所有任务状态为空闲
  cronDb.update(
    { status: { $in: [CrontabStatus.running, CrontabStatus.queued] } },
    { $set: { status: CrontabStatus.idle } },
    { multi: true },
  );

  // 初始化时安装所有处于安装中，安装成功，安装失败的依赖
  dependenceDb.find({ status: { $in: [0, 1, 2] } }).exec((err, docs) => {
    const groups = _.groupBy(docs, 'type');
    for (const key in groups) {
      if (Object.prototype.hasOwnProperty.call(groups, key)) {
        const group = groups[key];
        dependenceService.reInstall(group.map((x) => x._id));
      }
    }
  });

  // 初始化时执行一次所有的ql repo 任务
  cronDb
    .find({
      command: /ql (repo|raw)/,
      isDisabled: { $ne: 1 },
    })
    .exec((err, docs) => {
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        if (doc) {
          exec(doc.command);
        }
      }
    });

  // patch 禁用状态字段改变
  cronDb
    .find({
      status: CrontabStatus.disabled,
    })
    .exec((err, docs) => {
      if (docs.length > 0) {
        const ids = docs.map((x) => x._id);
        cronDb.update(
          { _id: { $in: ids } },
          { $set: { status: CrontabStatus.idle, isDisabled: 1 } },
          { multi: true },
          (err) => {
            cronService.autosave_crontab();
          },
        );
      }
    });

  // 初始化保存一次ck和定时任务数据
  await cronService.autosave_crontab();
  await envService.set_envs();
};

function randomSchedule(from: number, to: number) {
  const result: any[] = [];
  const arr = [...Array(from).keys()];
  let count = arr.length;
  for (let i = 0; i < to; i++) {
    const index = ~~(Math.random() * count) + i;
    if (result.includes(arr[index])) {
      continue;
    }
    result[i] = arr[index];
    arr[index] = arr[i];
    count--;
  }
  return result;
}
