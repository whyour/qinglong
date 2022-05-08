import { Container } from 'typedi';
import _ from 'lodash';
import SystemService from '../services/system';
import ScheduleService from '../services/schedule';

export default async () => {
  const systemService = Container.get(SystemService);
  const scheduleService = Container.get(ScheduleService);

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
