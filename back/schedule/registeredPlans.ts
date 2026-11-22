import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import {
  AddCronRequest,
  AddCronResponse,
  DeleteCronRequest,
  DeleteCronResponse,
} from '../protos/cron';
import { addCron } from './addCron';
import { delCron } from './delCron';
import { randomUUID } from 'crypto';
import {
  saveSchedulePlan,
  confirmSchedulePlan,
} from '../cron/scheduling/scheduleAudit';

// Keep acknowledgement, publication and timer replacement in request order,
// even if the client times out and sends a replacement snapshot.
let pending = Promise.resolve();
function serialize(action: () => Promise<void>) {
  pending = pending.then(action, action);
  return pending;
}

export function registeredAdd(
  call: ServerUnaryCall<AddCronRequest, AddCronResponse>,
  callback: sendUnaryData<AddCronResponse>,
) {
  return serialize(async () => {
    const db = require('../data').sequelize;
    const token = randomUUID();
    let first = 0;
    const last = await new Promise<number>((resolve, reject) => {
      addCron(
        call,
        (error) => (error ? reject(error) : resolve(Date.now())),
        async () => {
          await saveSchedulePlan(db, call.request, undefined, token);
          first = Date.now();
        },
      );
    });
    await confirmSchedulePlan(db, token, first, last, call.request.replace);
    callback(null, null);
  }).catch((error) => callback(error));
}

export function registeredDelete(
  call: ServerUnaryCall<DeleteCronRequest, DeleteCronResponse>,
  callback: sendUnaryData<DeleteCronResponse>,
) {
  return serialize(async () => {
    const db = require('../data').sequelize;
    const token = randomUUID();
    await saveSchedulePlan(db, call.request, undefined, token);
    const first = Date.now();
    delCron(call, (error) => {
      if (error) throw error;
    });
    await confirmSchedulePlan(db, token, first, Date.now(), false);
    callback(null, null);
  }).catch((error) => callback(error));
}
