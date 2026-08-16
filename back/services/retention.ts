import fs from 'fs/promises';
import path from 'path';
import dayjs from 'dayjs';
import { Op } from 'sequelize';
import { Service } from 'typedi';
import config from '../config';
import { CrontabStatModel } from '../data/cronStats';
import { sequelize } from '../data';
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

function runningInstanceWhere(days: number) {
  const cutoff = dayjs().subtract(days, 'day').unix();
  return {
    status: { [Op.ne]: InstanceStatus.running },
    [Op.or]: [
      { finished_at: { [Op.lt]: cutoff } },
      {
        finished_at: { [Op.is]: null },
        started_at: { [Op.lt]: cutoff },
      },
    ],
  };
}

function cronStatWhere(days: number) {
  return {
    date: { [Op.lt]: dayjs().subtract(days, 'day').format('YYYY-MM-DD') },
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

  public async preview(request: StorageCleanupRequest) {
    const policy = normalizeRetentionPolicy(request);
    const dependenceCacheTypes = (request.dependenceCacheTypes || []).filter(
      isDependenceCacheType,
    );
    const [runningInstances, cronStats, dependenceCaches] = await Promise.all([
      policy.runningInstanceRetentionDays > 0
        ? RunningInstanceModel.count({
            where: runningInstanceWhere(policy.runningInstanceRetentionDays),
          })
        : 0,
      policy.cronStatRetentionDays > 0
        ? CrontabStatModel.count({
            where: cronStatWhere(policy.cronStatRetentionDays),
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
    ]);

    return {
      policy,
      runningInstances,
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
    const preview = await this.preview(request);
    const deleted = await sequelize.transaction(async (transaction) => {
      const runningInstances =
        preview.policy.runningInstanceRetentionDays > 0
          ? await RunningInstanceModel.destroy({
              where: runningInstanceWhere(
                preview.policy.runningInstanceRetentionDays,
              ),
              transaction,
            })
          : 0;
      const cronStats =
        preview.policy.cronStatRetentionDays > 0
          ? await CrontabStatModel.destroy({
              where: cronStatWhere(preview.policy.cronStatRetentionDays),
              transaction,
            })
          : 0;
      return { runningInstances, cronStats };
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
      (deleted.runningInstances || deleted.cronStats)
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
          (deleted.runningInstances || deleted.cronStats),
      ),
    };
  }
}
