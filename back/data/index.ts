import { Sequelize, Transaction } from 'sequelize';
import config from '../config/index';

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: `${config.dbPath}database.sqlite`,
  logging: false,
  retry: {
    max: 10,
    match: ['SQLITE_BUSY: database is locked'],
  },
  pool: {
    max: 5,
    min: 2,
    idle: 30000,
    acquire: 30000,
    evict: 10000,
  },
  transactionType: Transaction.TYPES.IMMEDIATE,
});

export type ResponseType<T> = { code: number; data?: T; message?: string };
