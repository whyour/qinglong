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
      Logger.debug(`✌️ Back server launched on port ${config.port}`);
    })
    .on('error', (err) => {
      Logger.error(err);
      process.exit(1);
    });

  await require('./loaders/server').default({ server });
}

function initEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';
  // 声明QL_DIR环境变量
  let qlHomePath = path.join(__dirname, '../../');
  // 生产环境
  if (qlHomePath.endsWith('/static/')) {
    qlHomePath = path.join(qlHomePath, '../');
  }
  process.env.QL_DIR = qlHomePath;
}

initEnv();
startServer();
