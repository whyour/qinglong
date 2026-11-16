import { EventEmitter } from 'events';
import PQueue, { QueueAddOptions } from 'p-queue-cjs';
import os from 'os';
import type { Sequelize } from 'sequelize';
import { QueueOccupants, recordQueueAdmission } from './queueDiagnostics';
import { CronWaitQueue, CronQueueOptions } from './cronWaitQueue';
import { AuthDataType, SystemModel } from '../data/system';
import Logger from '../loaders/logger';
import { Dependence } from '../data/dependence';
import NotificationService from '../services/notify';
import { t, tf } from '../shared/i18n';
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
import { getGrpcCerts } from '../config/grpcCerts';

class TaskLimit {
  private dependenyLimit = new PQueue({ concurrency: 1 });
  private queuedDependencyIds = new Set<number>([]);
  private queuedCrons = new Map<string, ICronFn<any>[]>();
  private repeatCronNotifyMap = new Map<string, number>();
  private updateLogLimit = new PQueue({ concurrency: 1 });
  private warnSampling = (error: Error) => Logger.warn('[queue] Could not save occupancy: %s', error.message);
  private scheduledOccupants = new QueueOccupants('scheduled', () => this.cronLimit.concurrency, this.warnSampling);
  private manualOccupants = new QueueOccupants('manual', () => this.manualCronoLimit.concurrency, this.warnSampling);
  private cronLimit = new PQueue<CronWaitQueue, CronQueueOptions>({
    queueClass: CronWaitQueue,
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
  private _client: ApiClient | null = null;

  private get client(): ApiClient {
    if (!this._client) {
      const tlsConfig = getGrpcCerts();
      const creds = tlsConfig
        ? credentials.createSsl(
            Buffer.from(tlsConfig.caCert),
            Buffer.from(tlsConfig.clientKey),
            Buffer.from(tlsConfig.clientCert),
          )
        : credentials.createInsecure();
      this._client = new ApiClient(`localhost:${config.grpcPort}`, creds, {
        'grpc.enable_http_proxy': 0,
      });
    }
    return this._client;
  }

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
        t('[schedule][任务加入队列] 运行中任务数: %s, 等待中任务数: %s'),
        this.cronLimitActiveCount,
        this.cronLimitPendingCount,
      );
    });
    this.cronLimit.on('active', () => {
      Logger.info(
        t('[schedule][开始处理任务] 运行中任务数: %s, 等待中任务数: %s'),
        this.cronLimitActiveCount + 1,
        this.cronLimitPendingCount,
      );
    });
    this.cronLimit.on('completed', (param) => {
      Logger.info(t('[schedule][任务处理成功] 参数 %s'), JSON.stringify(param));
    });
    this.cronLimit.on('error', (error) => {
      Logger.error(
        t('[schedule][任务处理错误] 参数 %s'),
        JSON.stringify(error),
      );
    });
    this.cronLimit.on('next', () => {
      Logger.info(
        t('[schedule][任务处理结束] 运行中任务数: %s, 等待中任务数: %s'),
        this.cronLimitActiveCount,
        this.cronLimitPendingCount,
      );
    });
    this.cronLimit.on('idle', () => {
      Logger.info(t(`[schedule][任务队列] 空闲中...`));
    });
  }

  public removeQueuedDependency(dependency: Dependence) {
    if (this.queuedDependencyIds.has(dependency.id!)) {
      this.queuedDependencyIds.delete(dependency.id!);
    }
  }

  public removeQueuedCron(id: string, completed?: ICronFn<any>) {
    if (this.queuedCrons.has(id)) {
      const runs = this.queuedCrons.get(id);
      if (runs && runs.length > 0) {
        const remaining = completed
          ? runs.filter((run) => run !== completed)
          : runs.slice(0, -1);
        if (remaining.length) this.queuedCrons.set(id, remaining);
        else this.queuedCrons.delete(id);
      }
    }
  }

  public get cronConcurrency() {
    return this.manualCronoLimit.concurrency;
  }

  public async setCustomLimit(limit?: number) {
    if (limit) {
      this.cronLimit.concurrency = limit;
      this.manualCronoLimit.concurrency = limit;
      this.scheduledOccupants.refresh();
      this.manualOccupants.refresh();
      return;
    }
    await SystemModel.sync();
    const doc = await SystemModel.findOne({
      where: { type: AuthDataType.systemConfig },
    });
    if (doc?.info?.cronConcurrency) {
      await this.setCustomLimit(doc.info.cronConcurrency);
    }
  }

  public async runWithCronLimit<T>(
    cron: TCron,
    fn: ICronFn<T>,
    options?: Partial<QueueAddOptions>,
    isCurrent: () => boolean = () => true,
    onPending?: () => void,
    waitingSignal?: EventEmitter,
    triggerId?: string,
    db?: Sequelize,
  ): Promise<T | void> {
    if (!isCurrent()) return;
    fn.cron = cron;
    fn.isCurrent = isCurrent;
    // Invalidated snapshots must not consume the new revision's repeat budget.
    const runs = this.queuedCrons
      .get(cron.id)
      ?.filter((run) => run.isCurrent?.() !== false);
    if (cron.skip_if_pending && runs?.length) {
      onPending?.();
      return;
    }
    const result = runs?.length ? [...runs, fn] : [fn];
    const repeatTimes = this.repeatCronNotifyMap.get(cron.id) || 0;
    if (result?.length > 5) {
      if (repeatTimes < 3) {
        this.repeatCronNotifyMap.set(cron.id, repeatTimes + 1);
        this.client.systemNotify(
          {
            title: t('任务重复运行'),
            content: tf(
              '任务：%s，命令：%s，定时：%s，处于运行中的超过 %d 个，请检查定时设置',
              cron.name || '',
              cron.command || '',
              cron.schedule || '',
              5,
            ),
          },
          (err, res) => {
            if (err) {
              Logger.error(
                t('[schedule][任务重复运行] 通知失败 %s'),
                JSON.stringify(err),
              );
            }
          },
        );
      }
      Logger.warn(t('[schedule][任务重复运行] 参数 %s'), JSON.stringify(cron));
      return;
    }
    this.queuedCrons.set(cron.id, result);
    const run = this.trackAdmission(this.scheduledOccupants, this.cronLimit.concurrency, fn,
      { id: triggerId, name: cron.name || cron.id }, db);
    if (!waitingSignal) return this.cronLimit.add(run, options);
    return new Promise<T | void>((resolve, reject) => {
      this.cronLimit.add(run, { ...options, waitingSignal, onRemoved: () => { this.scheduledOccupants.forget(triggerId); resolve(); } }).then(resolve, reject);
    });
  }

  private trackAdmission<T>(pool: QueueOccupants, limit: number, fn: () => Promise<T>, occupant: { id?: string; name: string }, db?: Sequelize) {
    const admission = pool.admission(limit);
    if (occupant.id && admission && db) {
      pool.watch(occupant.id, db);
      void recordQueueAdmission(db, occupant.id, admission)
        .catch(error => Logger.warn('[queue] Failed to record wait reason: %s', error.message));
    }
    return pool.track(fn, occupant, db);
  }

  public async manualRunWithCronLimit<T>(
    fn: () => Promise<T>,
    options?: Partial<QueueAddOptions>,
    occupant: { id?: string; name: string } = { name: '—' },
    db?: Sequelize,
  ): Promise<T | void> {
    return this.manualCronoLimit.add(this.trackAdmission(this.manualOccupants, this.manualCronoLimit.concurrency, fn, occupant, db), options);
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
