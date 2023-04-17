import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { AddCronRequest, AddCronResponse } from '../protos/cron';
import nodeSchedule from 'node-schedule';
import { scheduleStacks } from './data';
import { exec } from 'child_process';

const addCron = (
  call: ServerUnaryCall<AddCronRequest, AddCronResponse>,
  callback: sendUnaryData<AddCronResponse>,
) => {
  for (const item of call.request.crons) {
    const { id, schedule, command } = item;
    if (scheduleStacks.has(id)) {
      scheduleStacks.get(id)?.cancel();
    }
    scheduleStacks.set(
      id,
      nodeSchedule.scheduleJob(id, schedule, async () => {
        exec(`ID=${id} ${command}`);
      }),
    );
  }

  callback(null, null);
};

export { addCron };
