import { Sequelize } from 'sequelize';
import config from '../config/index';

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: `${config.dbPath}database.sqlite`,
  logging: false,
  pool: {
    max: 5,
    min: 0,
    idle: 30000,
  },
});
