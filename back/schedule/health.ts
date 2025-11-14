import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { HealthCheckRequest, HealthCheckResponse } from '../protos/health';
import config from '../config';
import { promiseExec } from '../config/util';

const check = async (
  call: ServerUnaryCall<HealthCheckRequest, HealthCheckResponse>,
  callback: sendUnaryData<HealthCheckResponse>,
) => {
  switch (call.request.service) {
    case 'cron':
      const res = await promiseExec(
        `curl -s --noproxy '*' http://0.0.0.0:${config.port}/api/system`,
      );

      if (res.includes('200')) {
        return callback(null, { status: 1 });
      }

      const qinglongErrLog = await promiseExec(
        `tail -n 300 ~/.pm2/logs/qinglong-error.log`,
      );
      return callback(
        new Error(`${qinglongErrLog || ''}\n${res}`.trim()),
      );

    default:
      return callback(null, { status: 1 });
  }
};

export { check };
