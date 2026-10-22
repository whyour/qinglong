import config from '../config/index';
import { join } from 'path';
import { DatabaseClient } from './databaseClient';

export const database = new DatabaseClient(
  join(config.dbPath, 'database.sqlite'),
  join(config.dbPath, 'keyv.sqlite'),
);

export type ResponseType<T> = { code: number; data?: T; message?: string };
