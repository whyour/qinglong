import DependenceService from '../services/dependence';
import { exec } from 'child_process';
import { Container } from 'typedi';
import { Crontab, CrontabModel, CrontabStatus } from '../data/cron';
import CronService from '../services/cron';
import EnvService from '../services/env';
import { DependenceModel, DependenceStatus } from '../data/dependence';
import { Op } from 'sequelize';
import config from '../config';
import { CrontabViewModel, CronViewType } from '../data/cronView';
import { initPosition } from '../data/env';
import { AuthDataType, SystemModel } from '../data/system';
import SystemService from '../services/system';

export default async () => {
  const cronService = Container.get(CronService);
  const envService = Container.get(EnvService);
  const dependenceService = Container.get(DependenceService);
  const systemService = Container.get(SystemService);

  // 初始化增加系统配置
  await SystemModel.upsert({ type: AuthDataType.systemConfig });
  await SystemModel.upsert({ type: AuthDataType.notification });

  const installDependencies = () => {
    // 初始化时安装所有处于安装中，安装成功，安装失败的依赖
    DependenceModel.findAll({
      where: {},
      order: [
        ['type', 'DESC'],
        ['createdAt', 'DESC'],
      ],
      raw: true,
    }).then(async (docs) => {
      await DependenceModel.update(
        { status: DependenceStatus.queued, log: [] },
        { where: { id: docs.map((x) => x.id!) } },
      );
      setTimeout(() => {
        dependenceService.installDependenceOneByOne(docs);
      }, 5000);
    });
  };

  // 初始化更新 linux/python/nodejs 镜像源配置
  const systemConfig = await systemService.getSystemConfig();
  if (systemConfig.info?.pythonMirror) {
    systemService.updatePythonMirror({
      pythonMirror: systemConfig.info?.pythonMirror,
    });
  }
  if (systemConfig.info?.linuxMirror) {
    systemService.updateLinuxMirror(
      {
        linuxMirror: systemConfig.info?.linuxMirror,
      },
      undefined,
      () => installDependencies(),
    );
  } else {
    installDependencies();
  }
  if (systemConfig.info?.nodeMirror) {
    systemService.updateNodeMirror({
      nodeMirror: systemConfig.info?.nodeMirror,
    });
  }

  // 初始化新增默认全部任务视图
  CrontabViewModel.findAll({
    where: { type: CronViewType.系统, name: '全部任务' },
    raw: true,
  }).then((docs) => {
    if (docs.length === 0) {
      CrontabViewModel.create({
        name: '全部任务',
        type: CronViewType.系统,
        position: initPosition / 2,
      });
    }
  });

  // 初始化更新所有任务状态为空闲
  await CrontabModel.update({ status: CrontabStatus.idle }, { where: {} });

  // 初始化时执行一次所有的 ql repo 任务
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
              command: `${config.dataPath}/log/${doc.command.replace(
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
              command: `${config.dataPath}/config/${doc.command.replace(
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
              command: `${config.dataPath}/db/${doc.command.replace(
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
};
