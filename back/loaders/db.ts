import Logger from './logger';
import { EnvModel } from '../data/env';
import { CrontabModel } from '../data/cron';
import { DependenceModel } from '../data/dependence';
import { AppModel } from '../data/open';
import { SystemModel } from '../data/system';
import { SubscriptionModel } from '../data/subscription';
import { CrontabViewModel } from '../data/cronView';
import { sequelize } from '../data';

export default async () => {
  try {
    await CrontabModel.sync();
    await DependenceModel.sync();
    await AppModel.sync();
    await SystemModel.sync();
    await EnvModel.sync();
    await SubscriptionModel.sync();
    await CrontabViewModel.sync();

    // 初始化新增字段
    try {
      await sequelize.query(
        'alter table CrontabViews add column filterRelation VARCHAR(255)',
      );
    } catch (error) {}
    try {
      await sequelize.query(
        'alter table Subscriptions add column proxy VARCHAR(255)',
      );
    } catch (error) {}
    try {
      await sequelize.query('alter table CrontabViews add column type NUMBER');
    } catch (error) {}
    try {
      await sequelize.query(
        'alter table Subscriptions add column autoAddCron NUMBER',
      );
    } catch (error) {}
    try {
      await sequelize.query(
        'alter table Subscriptions add column autoDelCron NUMBER',
      );
    } catch (error) {}
    try {
      await sequelize.query('alter table Crontabs add column sub_id NUMBER');
    } catch (error) {}
    try {
      await sequelize.query(
        'alter table Crontabs add column extra_schedules JSON',
      );
    } catch (error) {}
    try {
      await sequelize.query('alter table Crontabs add column task_before TEXT');
    } catch (error) {}
    try {
      await sequelize.query('alter table Crontabs add column task_after TEXT');
    } catch (error) {}

    console.log('✌️ DB loaded');
    Logger.info('✌️ DB loaded');
  } catch (error) {
    console.error('✌️ DB load failed');
    Logger.error(error);
  }
};
