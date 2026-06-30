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
  Logger.info('[boot] Dependency loaded');

  await linkDeps();
  Logger.info('[boot] Link deps loaded');

  await initFile();
  Logger.info('[boot] Init file loaded');

  await initData();
  Logger.info('[boot] Init data loaded');

  initTask();
  Logger.info('[boot] Init task loaded');

  expressLoader({ app });
  Logger.info('[boot] Express loaded');
};
