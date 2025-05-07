import expressLoader from './express';
import depInjectorLoader from './depInjector';
import Logger from './logger';
import initData from './initData';
import { Application } from 'express';
import linkDeps from './deps';
import initTask from './initTask';
import initFile from './initFile';

export default async ({ app }: { app: Application }) => {
  depInjectorLoader();
  Logger.info('✌️ Dependency loaded');

  await linkDeps();
  Logger.info('✌️ Link deps loaded');

  initFile();
  Logger.info('✌️ Init file loaded');

  await initData();
  Logger.info('✌️ Init data loaded');

  initTask();
  Logger.info('✌️ Init task loaded');

  expressLoader({ app });
  Logger.info('✌️ Express loaded');
};
