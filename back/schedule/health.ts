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
        `curl -s http://localhost:${config.port}/api/system`,
      );

      if (res.includes('200')) {
        return callback(null, { status: 1 });
      }

      const panelErrLog = await promiseExec(
        `tail -n 300 ~/.pm2/logs/panel-error.log`,
      );
      const scheduleErrLog = await promiseExec(
        `tail -n 300 ~/.pm2/logs/schedule-error.log`,
      );
      return callback(
        new Error(`${scheduleErrLog || ''}\n${panelErrLog || ''}\n${res}`),
      );

    default:
      return callback(null, { status: 1 });
  }
};

export { check };
