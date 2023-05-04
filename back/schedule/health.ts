import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { HealthCheckRequest, HealthCheckResponse } from '../protos/health';
import { exec } from 'child_process';
import config from '../config';
import { promiseExec } from '../config/util';

const check = async (
  call: ServerUnaryCall<HealthCheckRequest, HealthCheckResponse>,
  callback: sendUnaryData<HealthCheckResponse>,
) => {
  switch (call.request.service) {
    case 'cron':
      const res = await promiseExec(
        `curl -sf http://localhost:${config.port}/api/system`,
      );

      if (res.includes('200')) {
        return callback(null, { status: 1 });
      }
      const errLog = await promiseExec(
        `tail -n 300 ~/.pm2/logs/panel-error.log`,
      );
      return callback(new Error(errLog));

    default:
      return callback(null, { status: 1 });
  }
};

export { check };
