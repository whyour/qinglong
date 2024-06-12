import expressLoader from './express';
import depInjectorLoader from './depInjector';
import Logger from './logger';
import initData from './initData';
import { Application } from 'express';
import linkDeps from './deps';
import initTask from './initTask';

export default async ({ expressApp }: { expressApp: Application }) => {
  depInjectorLoader();
  Logger.info('✌️ Dependency loaded');
  console.log('✌️ Dependency loaded');

  await initData();
  Logger.info('✌️ Init data loaded');
  console.log('✌️ Init data loaded');

  await linkDeps();
  Logger.info('✌️ Link deps loaded');
  console.log('✌️ Link deps loaded');

  initTask();
  Logger.info('✌️ Init task loaded');
  console.log('✌️ Init task loaded');

  expressLoader({ app: expressApp });
  Logger.info('✌️ Express loaded');
  console.log('✌️ Express loaded');
};
