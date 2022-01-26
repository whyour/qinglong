import { Sequelize } from 'sequelize';
import config from '../config/index';

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: `${config.dbPath}database.sqlite`,
  logging: false,
  pool: {
    max: 6,
    min: 0,
    idle: 30000,
  },
});

export type ResponseType<T> = { code: number; data?: T; message?: string };
