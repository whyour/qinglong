import { Container } from 'typedi';
import SystemService from '../services/system';
import ScheduleService, { ScheduleTaskType } from '../services/schedule';
import SubscriptionService from '../services/subscription';
import config from '../config';
import { fileExist } from '../config/util';
import { join } from 'path';

export default async () => {
  const systemService = Container.get(SystemService);
  const scheduleService = Container.get(ScheduleService);
  const subscriptionService = Container.get(SubscriptionService);

  // 生成内置token
  let tokenCommand = `ts-node-transpile-only ${join(
    config.rootPath,
    'back/token.ts',
  )}`;
  const tokenFile = join(config.rootPath, 'static/build/token.js');

  if (await fileExist(tokenFile)) {
    tokenCommand = `node ${tokenFile}`;
  }
  const cron = {
    id: NaN,
    name: '生成token',
    command: tokenCommand,
    runOrigin: 'system',
  } as ScheduleTaskType;
  await scheduleService.cancelIntervalTask(cron);
  scheduleService.createIntervalTask(
    cron,
    {
      days: 28,
    },
    true,
  );

  // 运行删除日志任务
  const data = await systemService.getSystemConfig();
  if (data && data.info && data.info.logRemoveFrequency) {
    const rmlogCron = {
      id: data.id as number,
      name: '删除日志',
      command: `ql rmlog ${data.info.logRemoveFrequency}`,
      runOrigin: 'system' as const,
    };
    await scheduleService.cancelIntervalTask(rmlogCron);
    scheduleService.createIntervalTask(
      rmlogCron,
      {
        days: data.info.logRemoveFrequency,
      },
      true,
    );
  }

  await subscriptionService.setSshConfig();
};
