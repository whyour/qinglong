import DataStore from 'nedb';
import config from '../config';
import Logger from './logger';
import fs from 'fs';

interface Dbs {
  cronDb: DataStore;
  dependenceDb: DataStore;
  envDb: DataStore;
  appDb: DataStore;
  authDb: DataStore;
}

const db: Dbs = {} as any;

async function fileExist(file: any) {
  return new Promise((resolve) => {
    try {
      fs.accessSync(file);
      resolve(true);
    } catch (error) {
      resolve(false);
    }
  });
}

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

    Logger.info('✌️ DB loaded');
  } catch (error) {
    Logger.info('✌️ DB load failed');
    Logger.info(error);
  }
};

export const dbs: Dbs = db;
