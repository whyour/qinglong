import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { AddCronRequest, AddCronResponse } from '../protos/cron';
import nodeSchedule from 'node-schedule';
import { scheduleStacks } from './data';
import { runCron } from '../shared/runCron';
import Logger from '../loaders/logger';

const addCron = (
  call: ServerUnaryCall<AddCronRequest, AddCronResponse>,
  callback: sendUnaryData<AddCronResponse>,
) => {
  for (const item of call.request.crons) {
    const { id, schedule, command, extra_schedules, name } = item;
    if (scheduleStacks.has(id)) {
      scheduleStacks.get(id)?.forEach((x) => x.cancel());
    }

    Logger.info(
      '[schedule][创建定时任务], 任务ID: %s, 名称: %s, cron: %s, 执行命令: %s',
      id,
      name,
      schedule,
      command,
    );

    if (extra_schedules?.length) {
      extra_schedules.forEach((x) => {
        Logger.info(
          '[schedule][创建定时任务], 任务ID: %s, 名称: %s, cron: %s, 执行命令: %s',
          id,
          name,
          x.schedule,
          command,
        );
      });
    }

    scheduleStacks.set(id, [
      nodeSchedule.scheduleJob(id, schedule, async () => {
        Logger.info(`[schedule][准备运行任务] 命令: ${command}`);
        runCron(command, item);
      }),
      ...(extra_schedules?.length
        ? extra_schedules.map((x) =>
            nodeSchedule.scheduleJob(id, x.schedule, async () => {
              Logger.info(`[schedule][准备运行任务] 命令: ${command}`);
              runCron(command, item);
            }),
          )
        : []),
    ]);
  }

  callback(null, null);
};

export { addCron };
