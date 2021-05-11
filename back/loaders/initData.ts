import { Container } from 'typedi';
import { Crontab, CrontabStatus } from '../data/cron';
import CronService from '../services/cron';

const initData = [
  {
    name: '更新面板',
    command: `sleep ${randomSchedule(60, 1)} && ql update`,
    schedule: `${randomSchedule(60, 1)} ${randomSchedule(
      24,
      7,
    ).toString()} * * *`,
    status: CrontabStatus.idle,
  },
  {
    name: '删除日志',
    command: 'ql rmlog 7',
    schedule: '30 7 */7 * *',
    status: CrontabStatus.idle,
  },
  {
    name: '互助码',
    command: 'ql code',
    schedule: '30 7 * * *',
    status: CrontabStatus.idle,
  },
];

export default async () => {
  const cronService = Container.get(CronService);
  const cronDb = cronService.getDb();

  cronDb.count({}, async (err, count) => {
    const data = initData.map((x) => {
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
    if (count === 0) {
      cronDb.insert(data);
      await cronService.autosave_crontab();
    }
  });
};

function randomSchedule(from: number, to: number) {
  const result = [];
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
