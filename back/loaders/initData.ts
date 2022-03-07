import DependenceService from '../services/dependence';
import { exec } from 'child_process';
import { Container } from 'typedi';
import { Crontab, CrontabModel, CrontabStatus } from '../data/cron';
import CronService from '../services/cron';
import EnvService from '../services/env';
import _ from 'lodash';
import { DependenceModel } from '../data/dependence';
import { Op } from 'sequelize';
import SystemService from '../services/system';
import ScheduleService from '../services/schedule';
import config from '../config';

export default async () => {
  const cronService = Container.get(CronService);
  const envService = Container.get(EnvService);
  const dependenceService = Container.get(DependenceService);
  const systemService = Container.get(SystemService);
  const scheduleService = Container.get(ScheduleService);

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
          if (dep) {
            await dependenceService.reInstall([dep]);
          }
        }
      }
    }
  });

  // 初始化时执行一次所有的ql repo 任务
  CrontabModel.findAll({
    where: {
      isDisabled: { [Op.ne]: 1 },
      command: {
        [Op.or]: [{ [Op.like]: `%ql repo%` }, { [Op.like]: `%ql raw%` }],
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

  // 更新2.11.3以前的脚本路径
  CrontabModel.findAll({
    where: {
      command: {
        [Op.or]: [
          { [Op.like]: `%\/${config.rootPath}\/scripts\/%` },
          { [Op.like]: `%\/${config.rootPath}\/config\/%` },
          { [Op.like]: `%\/${config.rootPath}\/log\/%` },
          { [Op.like]: `%\/${config.rootPath}\/db\/%` },
        ],
      },
    },
  }).then(async (docs) => {
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (doc) {
        if (doc.command.includes(`${config.rootPath}/scripts/`)) {
          await CrontabModel.update(
            { command: doc.command.replace(`${config.rootPath}/scripts/`, '') },
            { where: { id: doc.id } },
          );
        }
        if (doc.command.includes(`${config.rootPath}/log/`)) {
          await CrontabModel.update(
            {
              command: `${config.rootPath}/data/log/${doc.command.replace(
                `${config.rootPath}/log/`,
                '',
              )}`,
            },
            { where: { id: doc.id } },
          );
        }
        if (doc.command.includes(`${config.rootPath}/config/`)) {
          await CrontabModel.update(
            {
              command: `${config.rootPath}/data/config/${doc.command.replace(
                `${config.rootPath}/config/`,
                '',
              )}`,
            },
            { where: { id: doc.id } },
          );
        }
        if (doc.command.includes(`${config.rootPath}/db/`)) {
          await CrontabModel.update(
            {
              command: `${config.rootPath}/data/db/${doc.command.replace(
                `${config.rootPath}/db/`,
                '',
              )}`,
            },
            { where: { id: doc.id } },
          );
        }
      }
    }
  });

  // 初始化保存一次ck和定时任务数据
  await cronService.autosave_crontab();
  await envService.set_envs();

  // 运行删除日志任务
  const data = await systemService.getLogRemoveFrequency();
  if (data && data.info && data.info.frequency) {
    const cron = {
      id: data.id,
      name: '删除日志',
      command: `ql rmlog ${data.info.frequency}`,
    };
    await scheduleService.createIntervalTask(cron, {
      days: data.info.frequency,
      runImmediately: true,
    });
  }
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
