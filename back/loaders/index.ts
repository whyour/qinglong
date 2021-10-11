import expressLoader from './express';
import dependencyInjectorLoader from './dependencyInjector';
import Logger from './logger';
import initData from './initData';
import { Application } from 'express';

export default async ({ expressApp }: { expressApp: Application }) => {
  Logger.info('✌️ DB loaded and connected!');

  await dependencyInjectorLoader({
    models: [],
  });
  Logger.info('✌️ Dependency Injector loaded');

  await expressLoader({ app: expressApp });
  Logger.info('✌️ Express loaded');

  await initData();
  Logger.info('✌️ init data loaded');
};
