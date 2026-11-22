import PQueue, { QueueAddOptions } from 'p-queue-cjs';
import os from 'os';
import type { Dependence } from '../data/dependence';
import type { IDependencyFn, ISchedule, IScheduleFn, TCron } from './interface';

class TaskLimit {
  private dependenyLimit = new PQueue({ concurrency: 1 });
  private queuedDependencyIds = new Set<number>([]);
  private updateLogLimit = new PQueue({ concurrency: 1 });
  private subscriptionLimit = new PQueue({
    concurrency: Math.max(os.cpus().length, 4),
  });
  private scriptLimit = new PQueue({
    concurrency: Math.max(os.cpus().length, 4),
  });
  private systemLimit = new PQueue({
    concurrency: Math.max(os.cpus().length, 4),
  });

  get firstDependencyId() {
    return [...this.queuedDependencyIds.values()][0];
  }

  public removeQueuedDependency(dependency: Dependence) {
    if (this.queuedDependencyIds.has(dependency.id!)) {
      this.queuedDependencyIds.delete(dependency.id!);
    }
  }

  public async runWithSubscriptionLimit<T>(
    schedule: TCron,
    fn: IScheduleFn<T>,
    options?: Partial<QueueAddOptions>,
  ): Promise<T | void> {
    fn.schedule = schedule;
    return this.subscriptionLimit.add(fn, options);
  }

  public async runWithSystemLimit<T>(
    schedule: TCron,
    fn: IScheduleFn<T>,
    options?: Partial<QueueAddOptions>,
  ): Promise<T | void> {
    fn.schedule = schedule;
    return this.systemLimit.add(fn, options);
  }

  public async runWithScriptLimit<T>(
    schedule: ISchedule,
    fn: IScheduleFn<T>,
    options?: Partial<QueueAddOptions>,
  ): Promise<T | void> {
    fn.schedule = schedule;
    return this.scriptLimit.add(fn, options);
  }

  public async waitDependencyQueueDone(): Promise<void> {
    if (this.dependenyLimit.size === 0 && this.dependenyLimit.pending === 0) {
      return;
    }
    return new Promise((resolve) => {
      const onIdle = () => {
        this.dependenyLimit.removeListener('idle', onIdle);
        resolve();
      };
      this.dependenyLimit.on('idle', onIdle);
    });
  }

  public runDependeny<T>(
    dependency: Dependence,
    fn: IDependencyFn<T>,
    options?: Partial<QueueAddOptions>,
  ): Promise<T | void> {
    this.queuedDependencyIds.add(dependency.id!);
    fn.dependency = dependency;
    return this.dependenyLimit.add(fn, options);
  }

  public updateDepLog<T>(
    fn: () => Promise<T>,
    options?: Partial<QueueAddOptions>,
  ): Promise<T | void> {
    return this.updateLogLimit.add(fn, options);
  }
}

export default new TaskLimit();
