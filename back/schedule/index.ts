import { Server, ServerCredentials } from '@grpc/grpc-js';
import { CronService } from '../protos/cron';
import { addCron } from './addCron';
import { delCron } from './delCron';
import { HealthService } from '../protos/health';
import { check } from './health';
import config from '../config';
import Logger from '../loaders/logger';

const server = new Server();
server.addService(HealthService, { check });
server.addService(CronService, { addCron, delCron });
server.bindAsync(
  `localhost:${config.cronPort}`,
  ServerCredentials.createInsecure(),
  () => {
    server.start();
    Logger.debug(`✌️ 定时服务启动成功！`);
    process.send?.('ready');
  },
);
