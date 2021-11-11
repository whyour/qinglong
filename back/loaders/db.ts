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

async function truncateDb() {
  return new Promise((resolve) => {
    const files = [
      config.cronDbFile,
      config.dependenceDbFile,
      config.envDbFile,
      config.appDbFile,
      config.authDbFile,
    ];

    for (const file of files) {
      if (fs.statSync(file).size >= 1024 * 1024 * 500) {
        fs.truncateSync(file, 1024 * 1024 * 500);
      }
    }
    resolve(null);
  });
}
export default async () => {
  try {
    await truncateDb();

    db.cronDb = new DataStore({ filename: config.cronDbFile });
    db.dependenceDb = new DataStore({ filename: config.dependenceDbFile });
    db.envDb = new DataStore({ filename: config.envDbFile });
    db.appDb = new DataStore({ filename: config.appDbFile });
    db.authDb = new DataStore({ filename: config.authDbFile });

    // compaction data file
    db.cronDb.persistence.compactDatafile();
    db.envDb.persistence.compactDatafile();
    db.dependenceDb.persistence.compactDatafile();
    db.appDb.persistence.compactDatafile();
    db.authDb.persistence.compactDatafile();

    db.cronDb.loadDatabase((err) => {
      if (err) throw err;
    });
    db.envDb.loadDatabase((err) => {
      if (err) throw err;
    });
    db.dependenceDb.loadDatabase((err) => {
      if (err) throw err;
    });
    db.appDb.loadDatabase((err) => {
      if (err) throw err;
    });
    db.authDb.loadDatabase((err) => {
      if (err) throw err;
    });

    Logger.info('✌️ DB loaded');
  } catch (error) {
    Logger.info('✌️ DB load failed');
    Logger.info(error);
  }
};

export const dbs: Dbs = db;
