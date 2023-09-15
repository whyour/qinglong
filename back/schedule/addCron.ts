import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { AddCronRequest, AddCronResponse } from '../protos/cron';
import nodeSchedule from 'node-schedule';
import { scheduleStacks } from './data';
import { runCron } from '../shared/runCron';
import { QL_PREFIX, TASK_PREFIX } from '../config/const';
import Logger from '../loaders/logger';

const addCron = (
  call: ServerUnaryCall<AddCronRequest, AddCronResponse>,
  callback: sendUnaryData<AddCronResponse>,
) => {
  for (const item of call.request.crons) {
    const { id, schedule, command, extraSchedules } = item;
    if (scheduleStacks.has(id)) {
      scheduleStacks.get(id)?.forEach((x) => x.cancel());
    }

    let cmdStr = command.trim();
    if (!cmdStr.startsWith(TASK_PREFIX) && !cmdStr.startsWith(QL_PREFIX)) {
      cmdStr = `${TASK_PREFIX}${cmdStr}`;
    }

    Logger.info(
      '[schedule][创建定时任务], 任务ID: %s, cron: %s, 执行命令: %s',
      id,
      schedule,
      command,
    );

    if (extraSchedules?.length) {
      extraSchedules.forEach(x => {
        Logger.info(
          '[schedule][创建定时任务], 任务ID: %s, cron: %s, 执行命令: %s',
          id,
          x.schedule,
          command,
        );
      })
    }

    scheduleStacks.set(id, [
      nodeSchedule.scheduleJob(id, schedule, async () => {
        Logger.info(`[schedule][准备运行任务] 命令: ${cmdStr}`);
        runCron(`ID=${id} ${cmdStr}`);
      }),
      ...(extraSchedules?.length
        ? extraSchedules.map((x) =>
          nodeSchedule.scheduleJob(id, x.schedule, async () => {
            Logger.info(`[schedule][准备运行任务] 命令: ${cmdStr}`);
            runCron(`ID=${id} ${cmdStr}`);
          }),
        )
        : []),
    ]);
  }

  callback(null, null);
};

export { addCron };
