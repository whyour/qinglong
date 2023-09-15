import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { DeleteCronRequest, DeleteCronResponse } from '../protos/cron';
import { scheduleStacks } from './data';
import Logger from '../loaders/logger';

const delCron = (
  call: ServerUnaryCall<DeleteCronRequest, DeleteCronResponse>,
  callback: sendUnaryData<DeleteCronResponse>,
) => {
  for (const id of call.request.ids) {
    if (scheduleStacks.has(id)) {
      Logger.info(
        '[schedule][取消定时任务], 任务ID: %s',
        id,
      );
      scheduleStacks.get(id)?.forEach(x => x.cancel());
      scheduleStacks.delete(id);
    }
  }

  callback(null, null);
};

export { delCron };
