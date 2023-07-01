import { Container } from 'typedi';
import SystemService from '../services/system';
import ScheduleService from '../services/schedule';
import SubscriptionService from '../services/subscription';
import config from '../config';
import { fileExist } from '../config/util';
import { join } from 'path';

export default async () => {
  const systemService = Container.get(SystemService);
  const scheduleService = Container.get(ScheduleService);
  const subscriptionService = Container.get(SubscriptionService);

  // 生成内置token
  let tokenCommand = `tsx ${join(config.rootPath, 'back/token.ts')}`;
  const tokenFile = join(config.rootPath, 'static/build/token.js');

  if (await fileExist(tokenFile)) {
    tokenCommand = `node ${tokenFile}`;
  }
  const cron = {
    id: NaN,
    name: '生成token',
    command: tokenCommand,
  };
  await scheduleService.cancelIntervalTask(cron);
  scheduleService.createIntervalTask(cron, {
    days: 28,
  });

  // 运行删除日志任务
  const data = await systemService.getSystemConfig();
  if (data && data.info && data.info.frequency) {
    const rmlogCron = {
      id: data.id,
      name: '删除日志',
      command: `ql rmlog ${data.info.frequency}`,
    };
    await scheduleService.cancelIntervalTask(rmlogCron);
    scheduleService.createIntervalTask(rmlogCron, {
      days: data.info.frequency,
    });
  }

  // 运行所有订阅
  await subscriptionService.setSshConfig();
  const subs = await subscriptionService.list();
  for (const sub of subs) {
    subscriptionService.handleTask(sub, !sub.is_disabled, !sub.is_disabled);
  }
};
