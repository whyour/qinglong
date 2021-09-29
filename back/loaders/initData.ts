import { exec } from 'child_process';
import { Container } from 'typedi';
import { Crontab, CrontabStatus } from '../data/cron';
import CronService from '../services/cron';
import EnvService from '../services/env';

const initData = [
  {
    name: '更新面板',
    command: `ql update`,
    schedule: `${randomSchedule(60, 1)} ${randomSchedule(
      6,
      1,
    ).toString()} * * *`,
    isDisabled: 1,
  },
  {
    name: '删除日志',
    command: 'ql rmlog 7',
    schedule: '30 7 */7 * *',
    isDisabled: 1,
  },
];

export default async () => {
  const cronService = Container.get(CronService);
  const envService = Container.get(EnvService);
  const cronDb = cronService.getDb();
  const envDb = cronService.getDb();

  // compaction data file
  cronDb.persistence.compactDatafile();
  envDb.persistence.compactDatafile();

  cronDb.count({}, async (err, count) => {
    if (count === 0) {
      const data = initData.map((x: any) => {
        const tab = new Crontab(x);
        tab.created = new Date().valueOf();
        tab.saved = false;
        if (tab.name === '更新面板') {
          tab.isSystem = 1;
        } else {
          tab.isSystem = 0;
        }
        return tab;
      });
      cronDb.insert(data);
      await cronService.autosave_crontab();
    }
  });

  // 初始化更新所有任务状态为空闲
  cronDb.update(
    { status: { $in: [CrontabStatus.running, CrontabStatus.queued] } },
    { $set: { status: CrontabStatus.idle } },
    { multi: true },
  );

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
