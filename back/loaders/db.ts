import Logger from './logger';
import path from 'path';
import DataStore from 'nedb';
import { EnvModel } from '../data/env';
import { CrontabModel } from '../data/cron';
import { DependenceModel } from '../data/dependence';
import { AppModel } from '../data/open';
import { AuthModel } from '../data/auth';
import { fileExist } from '../config/util';
import { SubscriptionModel } from '../data/subscription';
import { CrontabViewModel } from '../data/cronView';
import config from '../config';
import { sequelize } from '../data'

export default async () => {
  try {
    await CrontabModel.sync();
    await DependenceModel.sync();
    await AppModel.sync();
    await AuthModel.sync();
    await EnvModel.sync();
    await SubscriptionModel.sync();
    await CrontabViewModel.sync();

    // 初始化新增字段
    try {
      await sequelize.query('alter table CrontabViews add column filterRelation VARCHAR(255)')
    } catch (error) {}
    try {
      await sequelize.query('alter table Subscriptions add column proxy VARCHAR(255)')
    } catch (error) {}

    // 2.10-2.11 升级
    const cronDbFile = path.join(config.rootPath, 'db/crontab.db');
    const envDbFile = path.join(config.rootPath, 'db/env.db');
    const appDbFile = path.join(config.rootPath, 'db/app.db');
    const authDbFile = path.join(config.rootPath, 'db/auth.db');
    const dependenceDbFile = path.join(config.rootPath, 'db/dependence.db');
    const crondbExist = await fileExist(cronDbFile);
    const dependenceDbExist = await fileExist(dependenceDbFile);
    const envDbExist = await fileExist(envDbFile);
    const appDbExist = await fileExist(appDbFile);
    const authDbExist = await fileExist(authDbFile);

    const cronCount = await CrontabModel.count();
    const dependenceCount = await DependenceModel.count();
    const envCount = await EnvModel.count();
    const appCount = await AppModel.count();
    const authCount = await AuthModel.count();
    if (crondbExist && cronCount === 0) {
      const cronDb = new DataStore({
        filename: cronDbFile,
        autoload: true,
      });
      cronDb.persistence.compactDatafile();
      cronDb.find({}).exec(async (err, docs) => {
        await CrontabModel.bulkCreate(docs, { ignoreDuplicates: true });
      });
    }

    if (dependenceDbExist && dependenceCount === 0) {
      const dependenceDb = new DataStore({
        filename: dependenceDbFile,
        autoload: true,
      });
      dependenceDb.persistence.compactDatafile();
      dependenceDb.find({}).exec(async (err, docs) => {
        await DependenceModel.bulkCreate(docs, { ignoreDuplicates: true });
      });
    }

    if (envDbExist && envCount === 0) {
      const envDb = new DataStore({
        filename: envDbFile,
        autoload: true,
      });
      envDb.persistence.compactDatafile();
      envDb.find({}).exec(async (err, docs) => {
        await EnvModel.bulkCreate(docs, { ignoreDuplicates: true });
      });
    }

    if (appDbExist && appCount === 0) {
      const appDb = new DataStore({
        filename: appDbFile,
        autoload: true,
      });
      appDb.persistence.compactDatafile();
      appDb.find({}).exec(async (err, docs) => {
        await AppModel.bulkCreate(docs, { ignoreDuplicates: true });
      });
    }

    if (authDbExist && authCount === 0) {
      const authDb = new DataStore({
        filename: authDbFile,
        autoload: true,
      });
      authDb.persistence.compactDatafile();
      authDb.find({}).exec(async (err, docs) => {
        await AuthModel.bulkCreate(docs, { ignoreDuplicates: true });
      });
    }

    Logger.info('✌️ DB loaded');
  } catch (error) {
    Logger.info('✌️ DB load failed');
    Logger.info(error);
  }
};
