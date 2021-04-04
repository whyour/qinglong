import { Container } from 'typedi';
import { Crontab, CrontabStatus } from '../data/cron';
import CronService from '../services/cron';

const initData = [
  {
    name: '更新面板',
    command: `sleep ${randomSchedule(
      60,
      1,
    )} && git_pull >> $QL_DIR/log/git_pull.log 2>&1`,
    schedule: `${randomSchedule(60, 1)} ${randomSchedule(
      24,
      7,
    ).toString()} * * *`,
    status: CrontabStatus.idle,
  },
  {
    name: '自定义仓库',
    command: `sleep ${randomSchedule(
      60,
      1,
    )} && diy whyour hundun "quanx/jx|quanx/jd" tokens >> $QL_DIR/log/diy_pull.log 2>&1`,
    schedule: `${randomSchedule(60, 1)} ${randomSchedule(
      24,
      6,
    ).toString()} * * *`,
    status: CrontabStatus.idle,
  },
  {
    name: '自定义仓库',
    command: `sleep ${randomSchedule(
      60,
      1,
    )} && diy monk-coder dust "i-chenzhe|normal" >> $QL_DIR/log/diy_pull.log 2>&1`,
    schedule: `${randomSchedule(60, 1)} ${randomSchedule(
      24,
      6,
    ).toString()} * * *`,
    status: CrontabStatus.idle,
  },
  {
    name: '互助码导出',
    command: 'export_sharecodes',
    schedule: '48 5 * * *',
    status: CrontabStatus.idle,
  },
  {
    name: 'build面板',
    command: 'rebuild >> ${QL_DIR}/log/rebuild.log 2>&1',
    schedule: '30 7 */7 * *',
    status: CrontabStatus.disabled,
  },
  {
    name: '删除日志',
    command: 'rm_log >/dev/null 2>&1',
    schedule: '30 7 */7 * *',
    status: CrontabStatus.disabled,
  },
  {
    name: '重置密码',
    command: 'js resetpwd',
    schedule: '33 6 */7 * *',
    status: CrontabStatus.disabled,
  },
  {
    name: '运行所以脚本(慎用)',
    command: 'js runall',
    schedule: '33 6 */7 * *',
    status: CrontabStatus.disabled,
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
