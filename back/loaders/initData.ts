import DependenceService from '../services/dependence';
import { exec } from 'child_process';
import { Container } from 'typedi';
import { Crontab, CrontabModel, CrontabStatus } from '../data/cron';
import CronService from '../services/cron';
import EnvService from '../services/env';
import _ from 'lodash';
import { DependenceModel } from '../data/dependence';
import { Op } from 'sequelize';

export default async () => {
  const cronService = Container.get(CronService);
  const envService = Container.get(EnvService);
  const dependenceService = Container.get(DependenceService);

  // 初始化更新所有任务状态为空闲
  await CrontabModel.update(
    { status: CrontabStatus.idle },
    { where: { status: [CrontabStatus.running, CrontabStatus.queued] } },
  );

  // 初始化时安装所有处于安装中，安装成功，安装失败的依赖
  DependenceModel.findAll({ where: {} }).then(async (docs) => {
    const groups = _.groupBy(docs, 'type');
    for (const key in groups) {
      if (Object.prototype.hasOwnProperty.call(groups, key)) {
        const group = groups[key];
        const depIds = group.map((x) => x.id);
        for (const dep of depIds) {
          await dependenceService.reInstall([dep]);
        }
      }
    }
  });

  // 初始化时执行一次所有的ql repo 任务
  CrontabModel.findAll({
    where: {
      isDisabled: { [Op.ne]: 1 },
      command: {
        [Op.or]: [{ [Op.like]: `%ql repo%` }, { [Op.like]: `%$ql raw%` }],
      },
    },
  }).then((docs) => {
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (doc) {
        exec(doc.command);
      }
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
