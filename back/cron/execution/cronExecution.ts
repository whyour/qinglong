import { randomUUID } from 'crypto';
import dayjs from 'dayjs';
import fs from 'fs/promises';
import path from 'path';
import {
  FindOptions,
  Op,
  Transaction,
  col,
  col as colFn,
  where,
} from 'sequelize';
import type { Logger } from 'winston';
import config from '../../config/index';
import { getUniqPath, killTask } from '../../config/util';
import { Crontab, CrontabModel, CrontabStatus } from '../../data/cron';
import {
  executionAssociation,
  executionModel,
} from '../../data/executionModels';
import {
  InstanceStatus,
  RunningInstanceModel,
} from '../../data/runningInstance';
import { asError, observeChildProcess } from '../../shared/childProcess';
import { resolveFileAccess } from '../../shared/fileAccess';
import { t } from '../../shared/i18n';
import { resolveLogPath } from '../../shared/logPath';
import { logStreamManager } from '../../shared/logStreamManager';
import { TriggerHistory, TriggerState } from '../history';
import { shellValue } from '../scheduling/cronScheduling';
import { releaseCronCommand, spawnCronCommand } from './cronCommandProcess';
import taskLimit from './cronLimit';
import {
  finishStoppedTree,
  hasLiveCronProcess,
  pidNamespaceOwner,
  systemOwner,
  verifyCronProcess,
} from './cronProcess';

type BatchStopSnapshot = {
  docs: Array<
    Pick<
      Crontab,
      | 'id'
      | 'status'
      | 'pid'
      | 'log_path'
      | 'queued_token'
      | 'last_execution_time'
    >
  >;
  instances: Array<{ id?: number; cron_id: number; pid?: number }>;
  cancelled: string[];
  missingPids?: number[];
  missingTargets?: string[];
  identityConflict: boolean;
};

type StopResult = { code: number; message: string; data?: { outcome: string } };

// Boundary to the existing service facade; no dependency on CronService itself.
export interface CronExecutionHost {
  getDb(query: FindOptions<Crontab>['where']): Promise<Crontab>;
  makeCommand(tab: Crontab, realTime?: boolean): string;
  runSingle(
    cronId: number,
    expectedToken?: string,
    triggerId?: string,
    submitted?: Crontab,
  ): Promise<number | void>;
  stopInstance(cronId: number, instanceId: number): Promise<StopResult>;
  stop(ids: number[], requestId?: string): Promise<void>;
}

export class CronExecution {
  constructor(private logger: Logger, private host: CronExecutionHost) {}

  public async run(ids: number[], source: 'manual' | 'boot' = 'manual') {
    const token = randomUUID();
    const database = CrontabModel.sequelize!;
    const history = new TriggerHistory(database);
    const submission = await database.transaction(async (transaction) => {
      const rows = await CrontabModel.findAll({
        where: { id: ids },
        transaction,
      });
      const accepted: Crontab[] = [];
      const triggers: Array<{
        taskId: number;
        triggerId: string;
        state: 'queued' | 'skipped';
        reason: 'overlap' | null;
      }> = [];
      for (const row of rows) {
        const id = row.id!;
        const trigger = token + '-' + id;
        await history.enqueue(
          trigger,
          id,
          source,
          null,
          Date.now(),
          transaction,
        );
        if (
          !row.allow_multiple_instances &&
          (hasLiveCronProcess(row.status, row.pid) ||
            (await history.isRunning(id, transaction)))
        ) {
          await history.finish(
            trigger,
            'skipped',
            'overlap',
            null,
            transaction,
          );
          triggers.push({
            taskId: id,
            triggerId: trigger,
            state: 'skipped',
            reason: 'overlap',
          });
        } else {
          accepted.push(row.get({ plain: true }));
          await database.query(
            'INSERT INTO CronManualSubmissions(trigger_id,token,snapshot) VALUES ($id,$token,$snapshot)',
            {
              transaction,
              bind: {
                id: trigger,
                token,
                snapshot: JSON.stringify(row.get({ plain: true })),
              },
            },
          );
          triggers.push({
            taskId: id,
            triggerId: trigger,
            state: 'queued',
            reason: null,
          });
        }
      }
      await CrontabModel.update(
        { status: CrontabStatus.queued, queued_token: token },
        {
          where: { id: accepted.map((row) => row.id!) },
          transaction,
        },
      );
      return { queued: accepted, triggers };
    });
    for (const row of submission.queued) {
      const id = row.id!;
      void this.host
        .runSingle(id, token, token + '-' + id, row)
        .catch((err) => this.logger.error(String(err)));
    }
    return submission.triggers;
  }

  public async recoverQueued() {
    const rows = await executionModel(
      CrontabModel.sequelize!,
      'CronManualSubmissions',
    ).findAll({
      attributes: ['trigger_id', 'token', 'snapshot'],
      include: [
        {
          association: executionAssociation(
            CrontabModel.sequelize!,
            'submissionTrigger',
          ),
          attributes: [],
          required: true,
          where: {
            state: 'queued',
            [Op.or]: [{ stop_requested: null }, { stop_requested: 0 }],
          },
        },
      ],
      order: [
        [col('trigger.queued_at'), 'ASC'],
        [col('trigger.id'), 'ASC'],
      ],
      raw: true,
    });
    for (const row of rows) {
      const snapshot: Crontab = JSON.parse(row.snapshot);
      void this.host
        .runSingle(snapshot.id!, row.token, row.trigger_id, snapshot)
        .catch((error) => this.logger.error(String(error)));
    }
  }

  private readonly stoppingBatches = new Map<string, Promise<void>>();

  public async stop(ids: number[], requestId?: string) {
    if (!ids.length && !requestId) return;
    const targets = [...new Set(ids)].sort((a, b) => a - b);
    const cronIds = JSON.stringify(targets);
    if (!requestId) return this.stopBatch(targets, cronIds);
    const key = requestId + '/' + cronIds;
    const pending = this.stoppingBatches.get(key);
    if (pending) return pending;
    // The database arbitrates different payloads and competing workers.
    const done = this.stopBatch(targets, cronIds, requestId).finally(() =>
      this.stoppingBatches.delete(key),
    );
    this.stoppingBatches.set(key, done);
    return done;
  }

  private async stopBatch(ids: number[], cronIds: string, requestId?: string) {
    const database = CrontabModel.sequelize!;
    const history = new TriggerHistory(database);
    const snapshot = await database.transaction(
      { type: Transaction.TYPES.IMMEDIATE },
      async (transaction): Promise<BatchStopSnapshot | null> => {
        if (requestId) {
          const [existing] = await executionModel(
            database,
            'CronStopBatches',
          ).findAll({
            attributes: ['cron_ids', 'snapshot', 'status_code'],
            where: { request_id: requestId },
            transaction,
            raw: true,
          });
          if (existing) {
            if (existing.cron_ids !== cronIds)
              throw Object.assign(
                new Error('Idempotency-Key already used for different tasks'),
                { status: 409 },
              );
            if (existing.status_code === 409)
              throw Object.assign(new Error(t('实例不存在或已停止')), {
                status: 409,
              });
            return existing.snapshot ? JSON.parse(existing.snapshot) : null;
          }
        }
        const docs = await CrontabModel.findAll({
          attributes: [
            'id',
            'status',
            'pid',
            'log_path',
            'queued_token',
            'last_execution_time',
          ],
          where: { id: ids },
          transaction,
          raw: true,
        });
        const cancelled = await history.cancelQueuedInTransaction(
          ids,
          transaction,
        );
        const instances = await RunningInstanceModel.findAll({
          attributes: ['id', 'cron_id', 'pid'],
          where: { cron_id: ids, status: InstanceStatus.running },
          transaction,
          raw: true,
        });
        const { missingTargets, identityConflict } =
          await this.attachLegacyStopTargets(
            docs,
            instances,
            history,
            transaction,
          );
        for (const instance of instances) {
          if (instance.pid)
            await history.queueInstanceStop(
              instance.id!,
              instance.cron_id,
              instance.pid,
              transaction,
            );
        }
        for (const doc of docs) {
          if (doc.status === CrontabStatus.queued) {
            await CrontabModel.update(
              {
                status: CrontabStatus.idle,
                pid: null,
                queued_token: null,
              } as any,
              {
                where: { id: doc.id, status: CrontabStatus.queued },
                transaction,
              },
            );
          }
        }
        const batch = {
          docs,
          cancelled,
          instances,
          missingTargets,
          identityConflict,
        };
        if (requestId) {
          await executionModel(database, 'CronStopBatches').create(
            {
              request_id: requestId,
              cron_ids: cronIds,
              snapshot: JSON.stringify(batch),
            },
            { transaction, silent: true, hooks: false, validate: false },
          );
        }
        return batch;
      },
    );
    if (!snapshot) return;
    const {
      docs,
      cancelled,
      instances,
      missingPids,
      missingTargets,
      identityConflict,
    } = snapshot;
    if (cancelled.length)
      process.send?.({ type: 'cancel-queued-triggers', ids: cancelled });
    const stopped = new Set(missingTargets);
    let failure: Error | undefined;
    for (const instance of instances) {
      try {
        const result = await this.host.stopInstance(
          instance.cron_id,
          instance.id!,
        );
        if (result.code === 409)
          failure ??= Object.assign(new Error(result.message), { status: 409 });
        if (
          instance.pid &&
          'data' in result &&
          result.data?.outcome === 'stopped'
        )
          stopped.add(instance.cron_id + '/' + instance.pid);
      } catch (error) {
        failure ??= asError(error);
      }
    }
    for (const doc of docs) {
      if (
        doc.status !== CrontabStatus.running ||
        (doc.pid &&
          !missingPids?.includes(doc.pid) &&
          !stopped.has(doc.id + '/' + doc.pid))
      )
        continue;
      const remaining = await RunningInstanceModel.count({
        where: { cron_id: doc.id, status: InstanceStatus.running },
      });
      if (remaining) continue;
      await CrontabModel.update(
        { status: CrontabStatus.idle, pid: null, queued_token: null } as any,
        {
          where: {
            id: doc.id,
            status: CrontabStatus.running,
            [Op.and]: [
              where(colFn('queued_token'), {
                [Op.eq]: doc.queued_token ?? null,
              }),
              where(colFn('pid'), { [Op.eq]: doc.pid ?? null }),
              where(colFn('log_path'), { [Op.eq]: doc.log_path ?? null }),
            ],
          },
        },
      );
    }
    if (failure) throw failure;
    // Retain the key after success. Even a much later retry must never take a new snapshot.
    if (requestId)
      await executionModel(database, 'CronStopBatches').update(
        { snapshot: null, status_code: identityConflict ? 409 : 200 },
        {
          where: { request_id: requestId, snapshot: { [Op.not]: null } },
          silent: true,
          hooks: false,
          validate: false,
        },
      );
    if (identityConflict)
      throw Object.assign(new Error(t('实例不存在或已停止')), { status: 409 });
  }

  // Older databases may have a PID or command receipt without an instance.
  // Attach verified targets before releasing the stop snapshot transaction.
  private async attachLegacyStopTargets(
    docs: BatchStopSnapshot['docs'],
    instances: BatchStopSnapshot['instances'],
    history: TriggerHistory,
    transaction: Transaction,
  ) {
    const commands = await history.activeCommands(
      docs.map((doc) => doc.id!),
      transaction,
    );
    const registered = new Set(
      instances.map((row) => row.cron_id + '/' + row.pid),
    );
    const registeredPids = new Set(instances.map((row) => row.pid));
    const legacy = new Map<
      string,
      {
        pid: number;
        cronId: number;
        trigger?: string;
        identity?: string;
        started?: number;
        log?: string;
      }
    >();
    for (const doc of docs) {
      const key = doc.id + '/' + doc.pid;
      if (
        doc.status === CrontabStatus.running &&
        doc.pid &&
        !registered.has(key)
      )
        legacy.set(key, {
          pid: doc.pid,
          cronId: doc.id!,
          started: doc.last_execution_time,
          log: doc.log_path,
        });
    }
    for (const command of commands) {
      const pid = Number(command.command_identity!.split(':')[1]);
      const key = command.cron_id + '/' + pid;
      if (!registered.has(key))
        legacy.set(key, {
          pid,
          cronId: command.cron_id,
          trigger: command.id,
          identity: command.command_identity!,
          started: Math.floor(command.started_at! / 1000),
          log: command.log_path ?? undefined,
        });
    }
    let identityConflict = false;
    const missingTargets: string[] = [];
    for (const target of legacy.values()) {
      const { pid } = target;
      // A different task already owns this PID in the snapshot.
      if (registeredPids.has(pid)) {
        identityConflict = true;
        continue;
      }
      let identity: string;
      try {
        identity = systemOwner(pid);
        verifyCronProcess(pid, target.cronId, target.identity, target.started);
      } catch (error) {
        if (
          ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code!)
        )
          missingTargets.push(target.cronId + '/' + pid);
        else if ((error as { status?: number }).status === 409)
          identityConflict = true;
        else throw error;
        continue;
      }
      const row = await RunningInstanceModel.create(
        {
          cron_id: target.cronId,
          pid,
          status: InstanceStatus.running,
          started_at: target.started || dayjs().unix(),
          log_path: target.log,
        },
        { transaction },
      );
      if (target.trigger)
        await executionModel(CrontabModel.sequelize!, 'CronTriggers').update(
          { instance_id: row.id, process_identity: identity },
          {
            where: { id: target.trigger, state: 'running' },
            transaction,
            silent: true,
            hooks: false,
            validate: false,
          },
        );
      await history.queueInstanceStop(
        row.id!,
        target.cronId,
        pid,
        transaction,
        identity,
      );
      instances.push({ id: row.id, cron_id: target.cronId, pid });
    }
    return { missingTargets, identityConflict };
  }

  public async resumePendingStops(
    history: TriggerHistory,
    requests: Awaited<ReturnType<TriggerHistory['pendingStops']>>,
    batches: Awaited<ReturnType<TriggerHistory['pendingStopBatches']>> = [],
  ) {
    for (const row of requests) {
      try {
        const result = await this.host.stopInstance(
          row.cron_id,
          row.instance_id,
        );
        if (result.code !== 200) this.logger.warn(result.message);
      } catch (error) {
        this.logger.error(
          t('[panel][停止实例失败] 实例ID: %s, PID: %s, 错误: %s'),
          row.instance_id,
          row.pid,
          asError(error).message,
        );
      }
    }
    for (const batch of batches) {
      try {
        await this.host.stop(JSON.parse(batch.cron_ids), batch.request_id);
      } catch (error) {
        this.logger.error(asError(error).message);
      }
    }
    await history.recoverSystemOwners();
  }

  private readonly stoppingInstances = new Map<
    string,
    Promise<{ code: number; message: string; data?: { outcome: string } }>
  >();

  public stopInstance(cronId: number, instanceId: number) {
    const key = `${cronId}/${instanceId}`;
    const pending = this.stoppingInstances.get(key);
    if (pending) return pending;
    const stop = this.stopOneInstance(cronId, instanceId).finally(() =>
      this.stoppingInstances.delete(key),
    );
    this.stoppingInstances.set(key, stop);
    return stop;
  }

  private async stopOneInstance(cronId: number, instanceId: number) {
    const ended = {
      code: 200,
      data: { outcome: 'ended' },
      message: t('实例已结束'),
    };
    const stopped = {
      code: 200,
      data: { outcome: 'stopped' },
      message: t('实例已停止'),
    };
    const history = new TriggerHistory(CrontabModel.sequelize!);
    const instance = await RunningInstanceModel.findOne({
      where: { id: instanceId, cron_id: cronId },
    });
    if (!instance) {
      await executionModel(CrontabModel.sequelize!, 'CronStopRequests').destroy(
        { where: { instance_id: instanceId, cron_id: cronId }, hooks: false },
      );
      return { code: 404, message: t('实例不存在或已停止') };
    }
    const pending = await history.pendingStop(instanceId);
    const savedTargets: string[] = pending?.targets
      ? JSON.parse(pending.targets)
      : [];
    const settle = () =>
      history.stopVerifiedInstance(instanceId, (transaction) =>
        this.settleLegacyStop(instanceId, cronId, instance.pid, transaction),
      );
    const finishClaim = async (claim: NonNullable<typeof pending>) => {
      await finishStoppedTree(
        claim.targets ? JSON.parse(claim.targets) : [],
        claim.signalled_at,
      );
      return (await settle()) ? stopped : ended;
    };
    const releaseUnsignalled = async (recoverEnded = false) => {
      const claimed = await history.forgetStop(
        instanceId,
        recoverEnded
          ? async (tx) => {
              await history.recoverSystemOwners(cronId, tx, instanceId);
              if (
                (await history.instanceStopRequested(instanceId, tx)) ===
                undefined
              )
                await this.settleLegacyStop(
                  instanceId,
                  cronId,
                  instance.pid,
                  tx,
                  InstanceStatus.unknown,
                );
            }
          : undefined,
      );
      if (claimed) return finishClaim(claimed);
    };
    if (pending?.signalled) return finishClaim(pending);
    if (instance.status !== InstanceStatus.running) {
      if (savedTargets.length) await finishStoppedTree(savedTargets);
      const claimed = pending && (await releaseUnsignalled());
      return (
        claimed ??
        (instance.status === InstanceStatus.stopped ? stopped : ended)
      );
    }
    // A cold restart destroys the old process tree. The same numeric PIDs
    // may already belong to another execution, even when script and log match.
    if (
      pending?.namespace_owner &&
      pending.namespace_owner !== pidNamespaceOwner()
    ) {
      return (await releaseUnsignalled(true)) ?? ended;
    }
    if (!instance.pid || instance.pid < 1) {
      return { code: 409, message: t('实例不存在或已停止') };
    }
    let identity =
      pending?.root_identity ||
      (await history.instanceIdentity(instanceId)) ||
      savedTargets.find((birth) => birth.startsWith(`crond:${instance.pid}:`));
    const verify = () =>
      verifyCronProcess(instance.pid!, cronId, identity, instance.started_at, {
        logPath: instance.log_path,
      });
    if (
      !identity &&
      (await RunningInstanceModel.count({
        where: {
          id: { [Op.ne]: instanceId },
          status: InstanceStatus.running,
          pid: instance.pid,
        },
      }))
    ) {
      const claimed = await releaseUnsignalled();
      return claimed ?? { code: 409, message: t('实例不存在或已停止') };
    }
    try {
      identity = verify() ?? identity;
      // Traversing the process tree is asynchronous. Persist the individual
      // request before traversal so a restart here also resumes this stop.
      if (!pending || (!pending.root_identity && identity))
        await history.queueInstanceStop(
          instanceId,
          cronId,
          instance.pid,
          undefined,
          identity ?? undefined,
        );
      await killTask(instance.pid, true, verify, (signal, targets) =>
        history.requestInstanceStop(instanceId, instance.pid!, signal, targets),
      );
      return (await settle()) ? stopped : ended;
    } catch (error) {
      const cause = (error as NodeJS.ErrnoException).code;
      if (cause === 'ESRCH' || cause === 'PID_REUSED') {
        if (savedTargets.length) await finishStoppedTree(savedTargets);
        const claimed = await releaseUnsignalled(true);
        if (claimed) return claimed;
        const latest = await RunningInstanceModel.findOne({
          where: { id: instanceId, cron_id: cronId },
        });
        if (latest?.status === InstanceStatus.stopped) return stopped;
        if (latest?.status === InstanceStatus.running) {
          const requested = await history.instanceStopRequested(instanceId);
          if (requested) return stopped;
          if (cause === 'PID_REUSED' || requested === undefined)
            return { code: 409, message: t('实例不存在或已停止') };
        }
        return ended;
      }
      if ((error as { status?: number }).status === 409) {
        if (savedTargets.length) await finishStoppedTree(savedTargets);
        const claimed = await releaseUnsignalled();
        return claimed ?? { code: 409, message: t('实例不存在或已停止') };
      }
      this.logger.error(
        t('[panel][停止实例失败] 实例ID: %s, PID: %s, 错误: %s'),
        instanceId,
        instance.pid,
        error,
      );
      throw error;
    }
  }

  private async settleLegacyStop(
    instanceId: number,
    cronId: number,
    pid: number | undefined,
    transaction: Transaction,
    status = InstanceStatus.stopped,
  ) {
    const [updated] = await RunningInstanceModel.update(
      { status, finished_at: dayjs().unix() },
      {
        where: {
          id: instanceId,
          cron_id: cronId,
          status: InstanceStatus.running,
        },
        transaction,
      },
    );

    if (!updated) {
      const latest = await RunningInstanceModel.findOne({
        where: { id: instanceId, cron_id: cronId },
        transaction,
      });
      return latest?.status === InstanceStatus.stopped;
    }

    // Check if there are still other running instances for this cron
    const otherRunning = await RunningInstanceModel.count({
      where: { cron_id: cronId, status: InstanceStatus.running },
      transaction,
    });
    if (otherRunning === 0) {
      await CrontabModel.update(
        { status: CrontabStatus.idle, pid: null } as any,
        {
          where: { id: cronId, status: CrontabStatus.running, pid },
          transaction,
        },
      );
    }
    return status === InstanceStatus.stopped;
  }

  public async runSingle(
    cronId: number,
    expectedToken?: string,
    triggerId?: string,
    submitted?: Crontab,
  ): Promise<number | void> {
    return taskLimit.manualRunWithCronLimit(
      async () => {
        let absolutePath: string | undefined;
        let logPath: string | undefined;
        let queuedLogPath: string | null | undefined;
        let queuedToken: string | null = null;
        let claimed = false;
        const history = new TriggerHistory(CrontabModel.sequelize!);
        let state: TriggerState = 'skipped';
        let reason: string | null = 'changed';
        let exitCode: number | null = null;
        try {
          const cron = await this.host.getDb({ id: cronId });
          const independent = Boolean(
            triggerId &&
              submitted?.allow_multiple_instances &&
              cron.allow_multiple_instances,
          );
          if (
            !independent &&
            (cron.status !== CrontabStatus.queued ||
              (expectedToken !== undefined &&
                cron.queued_token !== expectedToken))
          )
            return;
          queuedLogPath = cron.log_path ?? null;
          if (
            submitted &&
            (submitted.recovery_from !== cron.recovery_from ||
              submitted.isDisabled !== cron.isDisabled ||
              submitted.command !== cron.command)
          ) {
            queuedToken = expectedToken ?? null;
            return;
          }
          queuedToken = cron.queued_token ?? null;
          const { id, command, log_name } = cron;
          if (log_name === '/dev/null') {
            logPath = '/dev/null';
          } else {
            const uniqPath = log_name
              ? path.relative(
                  config.logPath,
                  resolveLogPath(config.logPath, log_name),
                )
              : await getUniqPath(command, `${id}`);
            const logTime = dayjs().format('YYYY-MM-DD-HH-mm-ss-SSS');
            // Different tasks can share a script/log directory and start in
            // the same millisecond. Every launch needs its own log identity.
            // The submission token can also be shared by different tasks.
            logPath = `${uniqPath}/${logTime}-${randomUUID()}.log`;
            absolutePath = resolveFileAccess(config.logPath, [logPath]);
            if (!absolutePath)
              throw new Error('Log path is outside the log directory');
            await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          }
          const outputPath = absolutePath;
          if (triggerId && submitted) {
            const claim = await history.claimManual(
              triggerId,
              submitted,
              expectedToken!,
              independent,
            );
            if (claim !== 'started') {
              reason = claim;
              queuedToken = expectedToken!;
              return;
            }
          }
          const launchCommand = `real_log_path=${shellValue(
            logPath,
          )} no_delay=true ${this.host.makeCommand(cron, true)}`;
          // Let the independent supervisor own the log, while the command keeps
          // writing to a drained pipe even if the worker dies or the log fills up.
          const supervisedLog = Boolean(triggerId && outputPath);
          const cp = spawnCronCommand(
            launchCommand,
            triggerId,
            undefined,
            outputPath,
          );
          // Install observers before the first await: very short children may already exit.
          const { completed } = observeChildProcess(cp, {
            onStart: async () => {
              try {
                if (
                  triggerId &&
                  !(await history.bindCommand(triggerId, cp.pid!, logPath))
                )
                  throw new Error('Task was cancelled before startup');
                const [count] = await CrontabModel.update(
                  {
                    status: CrontabStatus.running,
                    pid: cp.pid,
                    log_path: logPath,
                    ...(!triggerId && {
                      last_execution_time: dayjs().unix(),
                      last_running_time: null,
                    }),
                  },
                  {
                    where: {
                      id,
                      ...(independent
                        ? {}
                        : {
                            status: CrontabStatus.queued,
                            [Op.and]: [
                              where(colFn('queued_token'), {
                                [Op.eq]: queuedToken,
                              }),
                              where(colFn('log_path'), {
                                [Op.eq]: queuedLogPath,
                              }),
                            ],
                          }),
                    },
                  },
                );
                if (count !== 1)
                  throw new Error(
                    'Task was stopped or superseded before startup',
                  );
                claimed = true;
                if (triggerId) {
                  if (await history.shouldStop(triggerId)) cp.stdin.end();
                  else await releaseCronCommand(cp);
                }
              } catch (error) {
                if (triggerId) cp.stdin.destroy();
                else if (cp.pid) await killTask(cp.pid, true);
                throw error;
              }
            },
            onStdout:
              outputPath && !supervisedLog
                ? (message) => logStreamManager.write(outputPath, message)
                : undefined,
            onStderr: supervisedLog
              ? async (message) => {
                  this.logger.error(
                    '[panel][Command supervisor] Task ID: %s, %s',
                    id,
                    message.trim(),
                  );
                }
              : outputPath
              ? (message) => logStreamManager.write(outputPath, message)
              : undefined,
          });
          const result = await completed;
          state = result.signal
            ? 'stopped'
            : result.error || result.code !== 0
            ? 'failed'
            : 'finished';
          reason = result.error ? 'spawn' : result.signal || null;
          exitCode = result.code;
          if (result.error) {
            this.logger.error(
              t('[panel][执行任务失败] 任务ID: %s, 错误: %s'),
              id,
              result.error.message,
            );
          }
          this.logger.info(
            t('[panel][执行任务结束] 任务ID: %s, 退出码: %j'),
            id,
            result.code,
          );
          return { ...cron, pid: cp.pid, ...result } as any;
        } catch (error) {
          state = 'failed';
          reason = 'spawn';
          this.logger.error(
            t('[panel][创建任务失败] 任务ID: %s, 错误: %s'),
            cronId,
            asError(error).message,
          );
        } finally {
          try {
            if (absolutePath) await logStreamManager.closeStream(absolutePath);
          } catch (error) {
            this.logger.error(
              t('[panel][关闭任务日志失败] %s'),
              asError(error).message,
            );
          }
          try {
            // Do not overwrite a newer run's state or its script-reported exit code.
            await CrontabModel.update(
              {
                status: CrontabStatus.idle,
                pid: null,
                queued_token: null,
              } as any,
              {
                where: {
                  id: cronId,
                  [Op.and]: where(colFn('queued_token'), {
                    [Op.eq]: queuedToken,
                  }),
                  [Op.or]: [
                    ...(queuedLogPath !== undefined && !claimed
                      ? [
                          {
                            status: CrontabStatus.queued,
                            [Op.and]: where(colFn('log_path'), {
                              [Op.eq]: queuedLogPath,
                            }),
                          },
                        ]
                      : []),
                    ...(claimed && logPath
                      ? [{ log_path: logPath, status: CrontabStatus.running }]
                      : []),
                  ],
                },
              },
            );
          } catch (error) {
            this.logger.error(
              t('[panel][清理任务状态失败] %s'),
              asError(error).message,
            );
          }
          if (triggerId)
            await history.complete(triggerId, state, reason, exitCode);
        }
      },
      undefined,
      {
        id: triggerId,
        name: submitted?.name || submitted?.command || String(cronId),
      },
      CrontabModel.sequelize,
    );
  }
}
