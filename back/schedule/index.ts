import { Server, ServerCredentials } from '@grpc/grpc-js';
import { CronServiceService } from '../protos/cron';
import { addCron } from './addCron';
import { delCron } from './delCron';
import config from '../config';

const server = new Server();
server.addService(CronServiceService, { addCron, delCron });
server.bindAsync(
  `localhost:${config.cronPort}`,
  ServerCredentials.createInsecure(),
  () => {
    server.start();
  },
);
