import fs from 'fs/promises';
import path from 'path';
import dayjs from 'dayjs';
import { literal, Op } from 'sequelize';
import { Service } from 'typedi';
import config from '../config';
import { CrontabStatModel } from '../data/cronStats';
import { sequelize } from '../data';
import { TriggerHistory } from '../shared/triggerHistory';
import { prunedExitMigrationId } from '../shared/schemaMigrations';
import { InstanceStatus, RunningInstanceModel } from '../data/runningInstance';
import { AuthDataType, SystemModel } from '../data/system';
import {
  DependenceCacheType,
  getDirectorySize,
  isDependenceCacheType,
  normalizeRetentionPolicy,
  RetentionPolicy,
} from '../shared/retention';

export interface StorageCleanupRequest extends RetentionPolicy {
  dependenceCacheTypes?: DependenceCacheType[];
  compactDatabase?: boolean;
}

function runningInstanceWhere(cutoffMs: number) {
  const cutoff = cutoffMs / 1000;
  return {
    status: { [Op.ne]: InstanceStatus.running },
    id: { [Op.notIn]: literal(`(SELECT instance_id FROM CronTriggers WHERE instance_id IS NOT NULL
      AND (exit_pending=1 OR state IN ('queued','running') OR finished_at IS NULL OR observed_at >= ${cutoffMs} OR finished_at >= ${cutoffMs}))`) },
    [Op.or]: [
      { finished_at: { [Op.lt]: cutoff } },
      {
        finished_at: { [Op.is]: null },
        started_at: { [Op.lt]: cutoff },
      },
    ],
  };
}

function retentionCutoffs(policy: RetentionPolicy) {
  const now = dayjs();
  return {
    history: now.subtract(policy.runningInstanceRetentionDays, 'day').startOf('second').valueOf(),
    firstDay: now.subtract(policy.cronStatRetentionDays, 'day').format('YYYY-MM-DD'),
  };
}

@Service()
export default class RetentionService {
  public async updatePolicy(policy: Partial<RetentionPolicy>) {
    const normalized = normalizeRetentionPolicy(policy);
    const systemConfig = await SystemModel.findOne({
      where: { type: AuthDataType.systemConfig },
    });
    if (!systemConfig) {
      throw new Error('System config not found');
    }
    await SystemModel.update(
      {
        info: {
          ...systemConfig.info,
          ...normalized,
        },
      },
      { where: { id: systemConfig.id } },
    );
    return normalized;
  }

  public async preview(request: StorageCleanupRequest, cutoffs = retentionCutoffs(normalizeRetentionPolicy(request))) {
    const policy = normalizeRetentionPolicy(request);
    const dependenceCacheTypes = (request.dependenceCacheTypes || []).filter(
      isDependenceCacheType,
    );
    const [runningInstances, cronStats, dependenceCaches, triggers] = await Promise.all([
      policy.runningInstanceRetentionDays > 0
        ? RunningInstanceModel.count({
            where: runningInstanceWhere(cutoffs.history),
          })
        : 0,
      policy.cronStatRetentionDays > 0
        ? CrontabStatModel.count({
            where: { date: { [Op.lt]: cutoffs.firstDay } },
          })
        : 0,
      Promise.all(
        dependenceCacheTypes.map(async (type) => ({
          type,
          bytes: await getDirectorySize(
            path.join(config.dependenceCachePath, type),
          ),
        })),
      ),
      policy.runningInstanceRetentionDays > 0
        ? new TriggerHistory(sequelize).countExpired(cutoffs.history)
        : 0,
    ]);

    return {
      policy,
      runningInstances,
      triggers,
      cronStats,
      dependenceCaches,
      dependenceCacheBytes: dependenceCaches.reduce(
        (total, cache) => total + cache.bytes,
        0,
      ),
      compactDatabase: Boolean(request.compactDatabase),
    };
  }

  public async cleanup(request: StorageCleanupRequest) {
    const cutoffs = retentionCutoffs(normalizeRetentionPolicy(request));
    const preview = await this.preview(request, cutoffs);
    const deleted = await sequelize.transaction(async (transaction) => {
      const history = new TriggerHistory(sequelize);
      if (preview.policy.runningInstanceRetentionDays || preview.policy.cronStatRetentionDays) {
        await history.replayPublishedExits(transaction);
      }
      const runningInstances =
        preview.policy.runningInstanceRetentionDays > 0
          ? await RunningInstanceModel.destroy({
              where: runningInstanceWhere(cutoffs.history),
              transaction,
            })
          : 0;
      let cronStats = 0;
      if (preview.policy.cronStatRetentionDays > 0) {
        const firstDay = cutoffs.firstDay;
        cronStats = await CrontabStatModel.destroy({ where: { date: { [Op.lt]: firstDay } }, transaction });
        await sequelize.query(`INSERT INTO CronStatRetention(id,first_day) VALUES (1,$firstDay)
          ON CONFLICT(id) DO UPDATE SET first_day=MAX(first_day,excluded.first_day)`,
          { bind: { firstDay }, transaction });
        await sequelize.query(`DELETE FROM CronPrunedUnknownRuns WHERE last_possible_day <
          (SELECT first_day FROM CronStatRetention WHERE id=1)`, { transaction });
      }
      const triggers = preview.policy.runningInstanceRetentionDays > 0
        ? await history.deleteExpired(cutoffs.history, transaction)
        : 0;
      if (preview.policy.runningInstanceRetentionDays || preview.policy.cronStatRetentionDays) {
        // An unbound receipt's day can be wrong. A later bound receipt still
        // needs the execution-to-task link even after both visible histories expire.
        // A writer can also win the lock before an interrupted upgrade retries.
        // Keep its bound bookings until the proof-copy transaction has committed.
        await sequelize.query(`DELETE FROM CronLegacyExitBookings WHERE day <
          (SELECT first_day FROM CronStatRetention WHERE id=1)
          AND NOT EXISTS (SELECT 1 FROM CronTriggers WHERE id=CronLegacyExitBookings.trigger_id)
          AND ((bound=1 AND EXISTS (SELECT 1 FROM SchemaMigrations WHERE id=$proofMigration))
            OR (bound=0 AND NOT EXISTS (SELECT 1 FROM Crontabs WHERE id=CronLegacyExitBookings.cron_id)))`,
          { bind: { proofMigration: prunedExitMigrationId }, transaction });
      }
      return { runningInstances, cronStats, triggers };
    });

    const dependenceCaches = [];
    for (const cache of preview.dependenceCaches) {
      await fs.rm(path.join(config.dependenceCachePath, cache.type), {
        recursive: true,
        force: true,
      });
      dependenceCaches.push(cache);
    }

    if (
      request.compactDatabase &&
      (deleted.runningInstances || deleted.cronStats || deleted.triggers)
    ) {
      await sequelize.query('VACUUM');
    }

    return {
      deleted: {
        ...deleted,
        dependenceCaches,
        dependenceCacheBytes: preview.dependenceCacheBytes,
      },
      compactedDatabase: Boolean(
        request.compactDatabase &&
          (deleted.runningInstances || deleted.cronStats || deleted.triggers),
      ),
    };
  }
}
