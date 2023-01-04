import expressLoader from './express';
import depInjectorLoader from './depInjector';
import Logger from './logger';
import initData from './initData';
import { Application } from 'express';
import linkDeps from './deps';
import initTask from './initTask';

export default async ({ expressApp }: { expressApp: Application }) => {
  await depInjectorLoader();
  Logger.info('✌️ Dependency Injector loaded');

  await expressLoader({ app: expressApp });
  Logger.info('✌️ Express loaded');

  await initData();
  Logger.info('✌️ init data loaded');

  await linkDeps();
  Logger.info('✌️ link deps loaded');

  initTask();
  Logger.info('✌️ init task loaded');
};
