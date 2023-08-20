import expressLoader from './express';
import depInjectorLoader from './depInjector';
import Logger from './logger';
import initData from './initData';
import { Application } from 'express';
import linkDeps from './deps';
import initTask from './initTask';

export default async ({ expressApp }: { expressApp: Application }) => {
  try {
    depInjectorLoader();
    Logger.info('✌️ Dependency Injector loaded');
    console.log('✌️ Dependency Injector loaded');
  
    expressLoader({ app: expressApp });
    Logger.info('✌️ Express loaded');
    console.log('✌️ Express loaded');
  
    await initData();
    Logger.info('✌️ init data loaded');
    console.log('✌️ init data loaded');
  
    await linkDeps();
    Logger.info('✌️ link deps loaded');
    console.log('✌️ link deps loaded');
  
    initTask();
    Logger.info('✌️ init task loaded');
    console.log('✌️ init task loaded');
  } catch (error) {
    Logger.error(`✌️ depInjectorLoader expressLoader initData linkDeps failed, ${error}`);
    console.error(`✌️ depInjectorLoader expressLoader initData linkDeps failed ${error}`);
  }
};
