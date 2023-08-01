import pLimit from 'p-limit';
import os from 'os';
import { AuthDataType, AuthModel } from '../data/auth';

class TaskLimit {
  private oneLimit = pLimit(1);
  private updateLogLimit = pLimit(1);
  private cpuLimit = pLimit(Math.max(os.cpus().length, 4));

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
