import { FindOptions } from 'sequelize';
import { Crontab, CrontabModel, CrontabStatus } from '../../data/cron';
import {
  RunningInstanceModel,
  InstanceStatus,
} from '../../data/runningInstance';
import config from '../../config/index';
import { fileExist } from '../../shared/utils';
import fs from 'fs/promises';
import path from 'path';
import { logAttributes } from './cronViews';
import { TriggerQueries } from './triggerQueries';
import { resolveLogPath } from '../../shared/logPath';
import { LogChunk, LogReadOptions, readLogChunk } from '../../shared/logReader';
import { t } from '../../shared/i18n';

export type CronLogOptions = LogReadOptions & {
  previousPath?: string;
  triggerId?: string;
  instanceId?: number;
};

export type CronLogResult = LogChunk & {
  status: string;
  logPath?: string;
  triggerId?: string;
};

// The caller supplies its existing task lookup so missing-task behavior stays
// compatible. Trigger and instance reads are scoped to the requested task.
export class CronLogReader {
  constructor(
    private loadCron: (
      id: number,
      attributes?: FindOptions['attributes'],
    ) => Promise<Crontab>,
  ) {}

  public async log(
    id: number,
    options: CronLogOptions = {},
  ): Promise<CronLogResult> {
    let doc: Pick<Crontab, 'status' | 'log_path' | 'log_name'> & {
      logTriggerId?: string;
    };
    if (options.instanceId !== undefined) {
      const instance = await RunningInstanceModel.findOne({
        where: { id: options.instanceId, cron_id: id },
        attributes: ['status', 'log_path'],
        raw: true,
      });
      doc = {
        status:
          instance?.status === InstanceStatus.running
            ? CrontabStatus.running
            : CrontabStatus.idle,
        log_path: instance?.log_path,
      };
    } else if (options.triggerId) {
      const [trigger] = await new TriggerQueries(
        CrontabModel.sequelize!,
      ).visibleTriggers(id, [options.triggerId]);
      // A retained viewer must never fall back to a sibling if its receipt was removed.
      doc = {
        logTriggerId: options.triggerId,
        log_path: trigger?.log_path ?? undefined,
        status:
          trigger?.state === 'running'
            ? CrontabStatus.running
            : trigger?.state === 'queued'
            ? CrontabStatus.queued
            : CrontabStatus.idle,
      };
    } else {
      doc = await this.loadCron(id, logAttributes);
    }
    const triggerId = doc.logTriggerId ?? undefined;
    if (doc.log_name === '/dev/null' || doc.log_path === '/dev/null') {
      return {
        content: t('日志设置为忽略'),
        status: 'ignored',
        triggerId,
        offset: 0,
        nextOffset: 0,
        total: 0,
        truncated: false,
      };
    }
    if (typeof doc.status === 'number' && doc.status === CrontabStatus.queued) {
      // The next run has reserved a slot but has not published its own path yet.
      return {
        triggerId,
        content: '',
        status: 'running',
        offset: 0,
        nextOffset: 0,
        total: 0,
        truncated: false,
      };
    }
    const absolutePath = doc.log_path
      ? resolveLogPath(config.logPath, doc.log_path)
      : '';
    const logFileExist = doc.log_path && (await fileExist(absolutePath));
    if (logFileExist) {
      const changed =
        options.previousPath !== undefined &&
        options.previousPath !== doc.log_path;
      const chunk = await readLogChunk(
        absolutePath,
        changed
          ? { ...options, cursor: undefined, offset: 0, tail: !options.follow }
          : options,
      );
      const isRunning =
        typeof doc.status === 'number' &&
        [CrontabStatus.running, CrontabStatus.queued].includes(doc.status);
      return {
        ...chunk,
        triggerId,
        logPath: doc.log_path,
        status: isRunning ? 'running' : 'completed',
      };
    } else {
      const status =
        typeof doc.status === 'number' &&
        [CrontabStatus.queued, CrontabStatus.running].includes(doc.status)
          ? 'running'
          : 'notFound';
      return {
        triggerId,
        content: status === 'running' ? t('运行中...') : t('日志不存在...'),
        status,
        offset: 0,
        nextOffset: 0,
        total: 0,
        truncated: false,
      };
    }
  }

  public async logs(id: number) {
    const doc = await this.loadCron(id);
    if (!doc || !doc.log_path || doc.log_path === '/dev/null') {
      return [];
    }

    const relativeDir = path.dirname(`${doc.log_path}`);
    const dir = path.dirname(resolveLogPath(config.logPath, doc.log_path));
    const dirExist = await fileExist(dir);
    if (dirExist) {
      let files = await fs.readdir(dir);
      return (
        await Promise.all(
          files.map(async (x) => ({
            filename: x,
            directory: relativeDir.replace(config.logPath, ''),
            time: (await fs.lstat(`${dir}/${x}`)).birthtimeMs,
          })),
        )
      ).sort((a, b) => b.time - a.time);
    } else {
      return [];
    }
  }
}
