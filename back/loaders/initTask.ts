import { Container } from 'typedi';
import _ from 'lodash';
import SystemService from '../services/system';
import ScheduleService from '../services/schedule';
import SubscriptionService from '../services/subscription';

export default async () => {
  const systemService = Container.get(SystemService);
  const scheduleService = Container.get(ScheduleService);
  const subscriptionService = Container.get(SubscriptionService);

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

  // 运行所有订阅
  const subs = await subscriptionService.list();
  for (const sub of subs) {
    await subscriptionService.handleTask(
      sub,
      !sub.is_disabled,
      true,
      !sub.is_disabled,
    );
  }
};
