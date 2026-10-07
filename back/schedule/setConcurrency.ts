import { ServerUnaryCall, sendUnaryData, status } from '@grpc/grpc-js';
import os from 'os';
import { AddCronResponse, SetConcurrencyRequest } from '../protos/cron';
import taskLimit from '../shared/pLimit';

export async function setConcurrency(
  call: ServerUnaryCall<SetConcurrencyRequest, AddCronResponse>,
  callback: sendUnaryData<AddCronResponse>,
) {
  const limit = call.request.concurrency;
  if (!Number.isInteger(limit) || limit < 0 || limit > 2147483647) {
    callback(
      Object.assign(new Error('Invalid concurrency'), {
        code: status.INVALID_ARGUMENT,
      }),
      null,
    );
    return;
  }
  try {
    await taskLimit.setCustomLimit(limit || Math.max(os.cpus().length, 4));
    callback(null, {});
  } catch (error) {
    callback(error as Error, null);
  }
}
