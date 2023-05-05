import express from 'express';
import Logger from './loaders/logger';
import config from './config';
import { HealthClient } from './protos/health';
import { credentials } from '@grpc/grpc-js';

const app = express();
const client = new HealthClient(
  `localhost:${config.cronPort}`,
  credentials.createInsecure(),
);

app.get('/api/health', (req, res) => {
  client.check({ service: 'cron' }, (err, response) => {
    if (err) {
      return res.status(500).send({ error: err });
    }
    return res.status(200).send({ data: response });
  });
});

app
  .listen(config.publicPort, async () => {
    await require('./loaders/sentry').default({ expressApp: app });
    await require('./loaders/db').default();

    Logger.debug(`✌️ 公共服务启动成功！`);
    process.send?.('ready');
  })
  .on('error', (err) => {
    Logger.error(err);
    process.exit(1);
  });
