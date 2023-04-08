import { Server, ServerCredentials } from '@grpc/grpc-js';
import { CronServiceService } from '../protos/cron';
import { addCron } from './addCron';
import { delCron } from './delCron';
import config from '../config';
import Logger from '../loaders/logger';

const server = new Server();
server.addService(CronServiceService, { addCron, delCron });
server.bindAsync(
  `localhost:${config.cronPort}`,
  ServerCredentials.createInsecure(),
  () => {
    server.start();
    Logger.debug(`✌️ 定时服务启动成功！`);
  },
);
