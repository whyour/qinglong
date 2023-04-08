import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { DeleteCronRequest, DeleteCronResponse } from '../protos/cron';
import { scheduleStacks } from './data';

const delCron = (
  call: ServerUnaryCall<DeleteCronRequest, DeleteCronResponse>,
  callback: sendUnaryData<DeleteCronResponse>,
) => {
  for (const id of call.request.ids) {
    if (scheduleStacks.has(id)) {
      scheduleStacks.get(id)?.cancel();
      scheduleStacks.delete(id);
    }
  }

  callback(null, null);
};

export { delCron };
