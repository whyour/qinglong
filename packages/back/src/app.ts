import 'reflect-metadata'; // We need this in order to use @Decorators
import config from './config';
import express from 'express';
import Logger from './loaders/logger';
import path from 'path';

async function startServer() {
  const app = express();

  await require('./loaders/db').default();

  await require('./loaders/initFile').default();

  await require('./loaders/sentry').default({ expressApp: app });

  await require('./loaders/app').default({ expressApp: app });

  const server = app
    .listen(config.port, () => {
      Logger.debug(`✌️ 后端服务启动成功！`);
    })
    .on('error', (err) => {
      Logger.error(err);
      process.exit(1);
    });

  await require('./loaders/server').default({ server });
}

startServer();
