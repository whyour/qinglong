import express from 'express';
import Logger from './loaders/logger';
import config from './config';
import { HealthClient } from './protos/health';
import { credentials } from '@grpc/grpc-js';

const app = express();
const client = new HealthClient(
  `0.0.0.0:${config.cronPort}`,
  credentials.createInsecure(),
);

app.get('/api/health', (req, res) => {
  client.check({ service: 'cron' }, (err, response) => {
    if (err) {
      return res.status(200).send({ code: 500, error: err });
    }
    return res.status(200).send({ code: 200, data: response });
  });
});

app
  .listen(config.publicPort, async () => {
    await require('./loaders/sentry').default({ expressApp: app });
    await require('./loaders/db').default();

    Logger.debug(`✌️ 公共服务启动成功！`);
    console.debug(`✌️ 公共服务启动成功！`);
    process.send?.('ready');
  })
  .on('error', (err) => {
    Logger.error(err);
    console.error(err);
    process.exit(1);
  });
