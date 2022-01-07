import { Sequelize } from 'sequelize';
import config from '../config/index';

export const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: `${config.dbPath}database.sqlite`,
  logging: false,
});
