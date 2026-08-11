import Logger from './logger';
import { EnvModel } from '../data/env';
import { CrontabModel } from '../data/cron';
import { DependenceModel } from '../data/dependence';
import { AppModel } from '../data/open';
import { SystemModel } from '../data/system';
import { SubscriptionModel } from '../data/subscription';
import { CrontabViewModel } from '../data/cronView';
import { CrontabStatModel } from '../data/cronStats';
import { RunningInstanceModel } from '../data/runningInstance';
import { runMigrations } from '../migrations/runner';

export default async () => {
  try {
    await CrontabModel.sync();
    await DependenceModel.sync();
    await AppModel.sync();
    await SystemModel.sync();
    await EnvModel.sync();
    await SubscriptionModel.sync();
    await CrontabViewModel.sync();
    await CrontabStatModel.sync();
    await RunningInstanceModel.sync();
    await runMigrations();

    Logger.info('[boot] DB loaded');
  } catch (error) {
    Logger.error('[boot] DB load failed', error);
    throw error;
  }
};
