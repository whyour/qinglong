import DataStore from 'nedb';
import config from '../config';
import Logger from './logger';
import { fileExist } from '../config/util';
import { EnvModel } from '../data/env';
import { CrontabModel } from '../data/cron';
import { DependenceModel } from '../data/dependence';
import { AppModel } from '../data/open';
import { AuthModel } from '../data/auth';
import { sequelize } from '../data';

export default async () => {
  try {
    const crondbExist = await fileExist(config.cronDbFile);
    const dependenceDbExist = await fileExist(config.dependenceDbFile);
    const envDbExist = await fileExist(config.envDbFile);
    const appDbExist = await fileExist(config.appDbFile);
    const authDbExist = await fileExist(config.authDbFile);

    const cronCount = await CrontabModel.count();
    const dependenceCount = await DependenceModel.count();
    const envCount = await EnvModel.count();
    const appCount = await AppModel.count();
    const authCount = await AuthModel.count();
    if (crondbExist && cronCount === 0) {
      const cronDb = new DataStore({
        filename: config.cronDbFile,
        autoload: true,
      });
      cronDb.persistence.compactDatafile();
      cronDb.find({}).exec(async (err, docs) => {
        await CrontabModel.bulkCreate(docs, { ignoreDuplicates: true });
      });
    }

    if (dependenceDbExist && dependenceCount === 0) {
      const dependenceDb = new DataStore({
        filename: config.dependenceDbFile,
        autoload: true,
      });
      dependenceDb.persistence.compactDatafile();
      dependenceDb.find({}).exec(async (err, docs) => {
        await DependenceModel.bulkCreate(docs, { ignoreDuplicates: true });
      });
    }

    if (envDbExist && envCount === 0) {
      const envDb = new DataStore({
        filename: config.envDbFile,
        autoload: true,
      });
      envDb.persistence.compactDatafile();
      envDb.find({}).exec(async (err, docs) => {
        await EnvModel.bulkCreate(docs, { ignoreDuplicates: true });
      });
    }

    if (appDbExist && appCount === 0) {
      const appDb = new DataStore({
        filename: config.appDbFile,
        autoload: true,
      });
      appDb.persistence.compactDatafile();
      appDb.find({}).exec(async (err, docs) => {
        await AppModel.bulkCreate(docs, { ignoreDuplicates: true });
      });
    }

    if (authDbExist && authCount === 0) {
      const authDb = new DataStore({
        filename: config.authDbFile,
        autoload: true,
      });
      authDb.persistence.compactDatafile();
      authDb.find({}).exec(async (err, docs) => {
        await AuthModel.bulkCreate(docs, { ignoreDuplicates: true });
      });
    }

    try {
      await sequelize.sync({ alter: true });
    } catch (error) {
      console.log(error);
    }

    Logger.info('✌️ DB loaded');
  } catch (error) {
    Logger.info('✌️ DB load failed');
    Logger.info(error);
  }
};
