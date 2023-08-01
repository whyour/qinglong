import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { AddCronRequest, AddCronResponse } from '../protos/cron';
import nodeSchedule from 'node-schedule';
import { scheduleStacks } from './data';
import { runCron } from '../shared/runCron';
import { QL_PREFIX, TASK_PREFIX } from '../config/const';
import Logger from '../loaders/logger';
import dayjs from 'dayjs';

const addCron = (
  call: ServerUnaryCall<AddCronRequest, AddCronResponse>,
  callback: sendUnaryData<AddCronResponse>,
) => {
  for (const item of call.request.crons) {
    const { id, schedule, command } = item;
    if (scheduleStacks.has(id)) {
      scheduleStacks.get(id)?.cancel();
    }

    let cmdStr = command.trim();
    if (!cmdStr.startsWith(TASK_PREFIX) && !cmdStr.startsWith(QL_PREFIX)) {
      cmdStr = `${TASK_PREFIX}${cmdStr}`;
    }

    scheduleStacks.set(
      id,
      nodeSchedule.scheduleJob(id, schedule, async () => {
        Logger.info(
          `当前时间: ${dayjs().format(
            'YYYY-MM-DD HH:mm:ss',
          )}，运行命令: ${cmdStr}`,
        );
        runCron(`ID=${id} ${cmdStr}`);
      }),
    );
  }

  callback(null, null);
};

export { addCron };
