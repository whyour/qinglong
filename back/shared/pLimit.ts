import pLimit from 'p-limit';
import os from 'os';
import { AuthDataType, AuthModel } from '../data/auth';
import Logger from '../loaders/logger';
import dayjs from 'dayjs';

class TaskLimit {
  private oneLimit = pLimit(1);
  private updateLogLimit = pLimit(1);
  private cpuLimit = pLimit(Math.max(os.cpus().length, 4));

  get cpuLimitActiveCount() {
    return this.cpuLimit.activeCount;
  }

  get cpuLimitPendingCount() {
    return this.cpuLimit.pendingCount;
  }

  constructor() {
    this.setCustomLimit();
  }

  public async setCustomLimit(limit?: number) {
    if (limit) {
      this.cpuLimit = pLimit(limit);
      return;
    }
    await AuthModel.sync();
    const doc = await AuthModel.findOne({
      where: { type: AuthDataType.systemConfig },
    });
    if (doc?.info?.cronConcurrency) {
      this.cpuLimit = pLimit(doc?.info?.cronConcurrency);
    }
  }

  public runWithCpuLimit<T>(fn: () => Promise<T>): Promise<T> {
    Logger.info(
      `[schedule][任务加入队列] 时间: ${dayjs().format(
        'YYYY-MM-DD HH:mm:ss',
      )}, 运行中任务数: ${this.cpuLimitActiveCount}, 等待中任务数: ${this.cpuLimitPendingCount}`,
    );
    return this.cpuLimit(fn);
  }

  public runOneByOne<T>(fn: () => Promise<T>): Promise<T> {
    return this.oneLimit(fn);
  }

  public updateDepLog<T>(fn: () => Promise<T>): Promise<T> {
    return this.updateLogLimit(fn);
  }
}

export default new TaskLimit();
