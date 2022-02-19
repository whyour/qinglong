import Logger from './logger';
import { EnvModel } from '../data/env';
import { CrontabModel } from '../data/cron';
import { DependenceModel } from '../data/dependence';
import { AppModel } from '../data/open';
import { AuthModel } from '../data/auth';
import { sequelize } from '../data';

export default async () => {
  try {
    await sequelize.sync();
    await CrontabModel.sync();
    await DependenceModel.sync();
    await AppModel.sync();
    await AuthModel.sync();
    await EnvModel.sync();

    // try {
    //   const queryInterface = sequelize.getQueryInterface();
    //   await queryInterface.addIndex('Crontabs', ['command'], { unique: true });
    //   await queryInterface.addIndex('Envs', ['name', 'value'], { unique: true });
    //   await queryInterface.addIndex('Apps', ['name'], { unique: true });
    // } catch (error) {

    // }

    Logger.info('✌️ DB loaded');
  } catch (error) {
    Logger.info('✌️ DB load failed');
    Logger.info(error);
  }
};
