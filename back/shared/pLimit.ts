import PQueue, { QueueAddOptions } from 'p-queue-cjs';
import os from 'os';
import { AuthDataType, SystemModel } from '../data/system';
import Logger from '../loaders/logger';
import { Dependence } from '../data/dependence';
import NotificationService from '../services/notify';
import {
  ICronFn,
  IDependencyFn,
  ISchedule,
  IScheduleFn,
  TCron,
} from './interface';
import config from '../config';
import { credentials } from '@grpc/grpc-js';
import { ApiClient } from '../protos/api';

class TaskLimit {
  private dependenyLimit = new PQueue({ concurrency: 1 });
  private queuedDependencyIds = new Set<number>([]);
  private queuedCrons = new Map<string, ICronFn<any>[]>();
  private repeatCronNotifyMap = new Map<string, number>();
  private updateLogLimit = new PQueue({ concurrency: 1 });
  private cronLimit = new PQueue({
    concurrency: Math.max(os.cpus().length, 4),
  });
  private manualCronoLimit = new PQueue({
    concurrency: Math.max(os.cpus().length, 4),
  });
  private subscriptionLimit = new PQueue({
    concurrency: Math.max(os.cpus().length, 4),
  });
  private scriptLimit = new PQueue({
    concurrency: Math.max(os.cpus().length, 4),
  });
  private systemLimit = new PQueue({
    concurrency: Math.max(os.cpus().length, 4),
  });
  private client = new ApiClient(
    `0.0.0.0:${config.cronPort}`,
    credentials.createInsecure(),
    { 'grpc.enable_http_proxy': 0 },
  );

  get cronLimitActiveCount() {
    return this.cronLimit.pending;
  }

  get cronLimitPendingCount() {
    return this.cronLimit.size;
  }

  get firstDependencyId() {
    return [...this.queuedDependencyIds.values()][0];
  }

  private notificationService: NotificationService = new NotificationService();

  constructor() {
    this.setCustomLimit();
    this.handleEvents();
  }

  private handleEvents() {
    this.cronLimit.on('add', () => {
      Logger.info(
        `[schedule][任务加入队列] 运行中任务数: ${this.cronLimitActiveCount}, 等待中任务数: ${this.cronLimitPendingCount}`,
      );
    });
    this.cronLimit.on('active', () => {
      Logger.info(
        `[schedule][开始处理任务] 运行中任务数: ${
          this.cronLimitActiveCount + 1
        }, 等待中任务数: ${this.cronLimitPendingCount}`,
      );
    });
    this.cronLimit.on('completed', (param) => {
      Logger.info(`[schedule][任务处理成功] 参数 ${JSON.stringify(param)}`);
    });
    this.cronLimit.on('error', (error) => {
      Logger.error(`[schedule][任务处理错误] 参数 ${JSON.stringify(error)}`);
    });
    this.cronLimit.on('next', () => {
      Logger.info(
        `[schedule][任务处理结束] 运行中任务数: ${this.cronLimitActiveCount}, 等待中任务数: ${this.cronLimitPendingCount}`,
      );
    });
    this.cronLimit.on('idle', () => {
      Logger.info(`[schedule][任务队列] 空闲中...`);
    });
  }

  public removeQueuedDependency(dependency: Dependence) {
    if (this.queuedDependencyIds.has(dependency.id!)) {
      this.queuedDependencyIds.delete(dependency.id!);
    }
  }

  public removeQueuedCron(id: string) {
    if (this.queuedCrons.has(id)) {
      const runs = this.queuedCrons.get(id);
      if (runs && runs.length > 0) {
        runs.pop();
        this.queuedCrons.set(id, runs);
      }
    }
  }

  public async setCustomLimit(limit?: number) {
    if (limit) {
      this.cronLimit.concurrency = limit;
      this.manualCronoLimit.concurrency = limit;
      return;
    }
    await SystemModel.sync();
    const doc = await SystemModel.findOne({
      where: { type: AuthDataType.systemConfig },
    });
    if (doc?.info?.cronConcurrency) {
      this.cronLimit.concurrency = doc.info.cronConcurrency;
      this.manualCronoLimit.concurrency = doc.info.cronConcurrency;
    }
  }

  public async runWithCronLimit<T>(
    cron: TCron,
    fn: ICronFn<T>,
    options?: Partial<QueueAddOptions>,
  ): Promise<T | void> {
    fn.cron = cron;
    let runs = this.queuedCrons.get(cron.id);
    const result = runs?.length ? [...runs, fn] : [fn];
    const repeatTimes = this.repeatCronNotifyMap.get(cron.id) || 0;
    if (result?.length > 5) {
      if (repeatTimes < 3) {
        this.repeatCronNotifyMap.set(cron.id, repeatTimes + 1);
        this.client.systemNotify(
          {
            title: '任务重复运行',
            content: `任务：${cron.name}，命令：${cron.command}，定时：${cron.schedule}，处于运行中的超过 5 个，请检查定时设置`,
          },
          (err, res) => {
            if (err) {
              Logger.error(
                `[schedule][任务重复运行] 通知失败 ${JSON.stringify(err)}`,
              );
            }
          },
        );
      }
      Logger.warn(`[schedule][任务重复运行] 参数 ${JSON.stringify(cron)}`);
      return;
    }
    this.queuedCrons.set(cron.id, result);
    return this.cronLimit.add(fn, options);
  }

  public async manualRunWithCronLimit<T>(
    fn: () => Promise<T>,
    options?: Partial<QueueAddOptions>,
  ): Promise<T | void> {
    return this.manualCronoLimit.add(fn, options);
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
