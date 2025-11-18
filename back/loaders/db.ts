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
    const migrations = [
      {
        table: 'CrontabViews',
        column: 'filterRelation',
        type: 'VARCHAR(255)',
      },
      { table: 'Subscriptions', column: 'proxy', type: 'VARCHAR(255)' },
      { table: 'CrontabViews', column: 'type', type: 'NUMBER' },
      { table: 'Subscriptions', column: 'autoAddCron', type: 'NUMBER' },
      { table: 'Subscriptions', column: 'autoDelCron', type: 'NUMBER' },
      { table: 'Crontabs', column: 'sub_id', type: 'NUMBER' },
      { table: 'Crontabs', column: 'extra_schedules', type: 'JSON' },
      { table: 'Crontabs', column: 'task_before', type: 'TEXT' },
      { table: 'Crontabs', column: 'task_after', type: 'TEXT' },
      { table: 'Crontabs', column: 'log_name', type: 'VARCHAR(255)' },
      {
        table: 'Crontabs',
        column: 'allow_multiple_instances',
        type: 'NUMBER',
      },
      { table: 'Envs', column: 'isPinned', type: 'NUMBER' },
    ];

    for (const migration of migrations) {
      try {
        await sequelize.query(
          `alter table ${migration.table} add column ${migration.column} ${migration.type}`,
        );
      } catch (error) {
        // Column already exists or other error, continue
      }
    }

    Logger.info('✌️ DB loaded');
  } catch (error) {
    Logger.error('✌️ DB load failed', error);
  }
};
