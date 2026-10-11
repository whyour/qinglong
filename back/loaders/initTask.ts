import { Container } from 'typedi';
import SystemService from '../services/system';
import ScheduleService, { ScheduleTaskType } from '../services/schedule';
import SubscriptionService from '../services/subscription';
import SshKeyService from '../services/sshKey';
import config from '../config';
import { fileExist } from '../config/util';
import { join } from 'path';
import { t } from '../shared/i18n';
import Logger from './logger';
import { assertSubscriptionAlias } from '../shared/subscriptionPath';

export default async () => {
  const systemService = Container.get(SystemService);
  const scheduleService = Container.get(ScheduleService);
  const subscriptionService = Container.get(SubscriptionService);
  const sshKeyService = Container.get(SshKeyService);

  // 生成内置token
  let tokenCommand = `ts-node-transpile-only ${join(
    config.rootPath,
    'back/token.ts',
  )}`;
  const tokenFile = join(config.rootPath, 'static/build/token.js');

  if (await fileExist(tokenFile)) {
    tokenCommand = `node ${tokenFile}`;
  }
  tokenCommand += ' --renew';
  const cron = {
    id: NaN,
    name: t('生成token'),
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
  if (data && data.info) {
    if (data.info.logRemoveFrequency) {
      const rmlogCron = {
        id: data.id as number,
        name: t('删除日志'),
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

    systemService.updateTimezone(data.info);
    
    // Apply global SSH key if configured
    if (data.info.globalSshKey) {
      await sshKeyService.addGlobalSSHKey(data.info.globalSshKey, 'global');
    }
  }

  await subscriptionService.setSshConfig();
  const subs = await subscriptionService.list();
  for (const sub of subs) {
    try {
      const doc = sub.get({ plain: true });
      assertSubscriptionAlias(doc.alias);
      await subscriptionService.handleTask(doc, !sub.is_disabled);
    } catch (error) {
      Logger.warn('跳过订阅 %s 的无效定时配置: %s', sub.id, error);
    }
  }
};
