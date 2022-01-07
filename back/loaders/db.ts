import DataStore from 'nedb';
import config from '../config';
import Logger from './logger';
import fs from 'fs';
import { fileExist } from '../config/util';
import { EnvModel } from '../data/env';
import { CrontabModel } from '../data/cron';
import { DependenceModel } from '../data/dependence';
import { AppModel } from '../data/open';
import { AuthModel } from '../data/auth';
import { sequelize } from '../data';

interface Dbs {
  cronDb: DataStore;
  dependenceDb: DataStore;
  envDb: DataStore;
  appDb: DataStore;
  authDb: DataStore;
}

const db: Dbs = {} as any;

async function truncateDb() {
  return new Promise(async (resolve) => {
    const files = [
      config.cronDbFile,
      config.dependenceDbFile,
      config.envDbFile,
      config.appDbFile,
      config.authDbFile,
    ];

    for (const file of files) {
      const _fileExist = await fileExist(file);
      if (_fileExist && fs.statSync(file).size >= 1024 * 1024 * 500) {
        fs.truncateSync(file, 1024 * 1024 * 500);
      }
    }
    resolve(null);
  });
}
export default async () => {
  try {
    await truncateDb();

    db.cronDb = new DataStore({ filename: config.cronDbFile, autoload: true });
    db.dependenceDb = new DataStore({
      filename: config.dependenceDbFile,
      autoload: true,
    });
    db.envDb = new DataStore({ filename: config.envDbFile, autoload: true });
    db.appDb = new DataStore({ filename: config.appDbFile, autoload: true });
    db.authDb = new DataStore({ filename: config.authDbFile, autoload: true });

    // compaction data file
    db.cronDb.persistence.compactDatafile();
    db.envDb.persistence.compactDatafile();
    db.dependenceDb.persistence.compactDatafile();
    db.appDb.persistence.compactDatafile();
    db.authDb.persistence.compactDatafile();

    try {
      await sequelize.sync({ alter: true });
    } catch (error) {
      console.log(error);
    }

    // migrate db to sqlite
    setTimeout(async () => {
      try {
        const count = await CrontabModel.count();
        if (count !== 0) {
          return;
        }
        db.cronDb.find({}).exec(async (err, docs) => {
          await CrontabModel.bulkCreate(docs);
        });

        db.dependenceDb.find({}).exec(async (err, docs) => {
          await DependenceModel.bulkCreate(docs);
        });

        db.envDb.find({}).exec(async (err, docs) => {
          await EnvModel.bulkCreate(docs);
        });

        db.appDb.find({}).exec(async (err, docs) => {
          await AppModel.bulkCreate(docs);
        });

        db.authDb.find({}).exec(async (err, docs) => {
          await AuthModel.bulkCreate(docs);
        });
      } catch (error) {
        console.log(error);
      }
    }, 5000);

    Logger.info('✌️ DB loaded');
  } catch (error) {
    Logger.info('✌️ DB load failed');
    Logger.info(error);
  }
};

export const dbs: Dbs = db;
