import Logger from './logger';
import { database } from '../data';
import { initialSchema } from '../data/schema';
import { migrateSchema } from '../shared/schemaMigrations';

export default async () => {
  try {
    await database.transaction(async () => {
      for (const sql of initialSchema) await database.query(sql);
      await migrateSchema(database);
    });
    Logger.info('[boot] DB loaded');
  } catch (error) {
    Logger.error('[boot] DB load failed', error);
    throw error;
  }
};
