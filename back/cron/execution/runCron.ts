import { hasLiveCronProcess } from './cronProcess';
import { EventEmitter } from 'events';
import PQueue from 'p-queue-cjs';
import { triggerHistory, TriggerState } from '../history';
import { t } from '../../shared/i18n';
import { spawnCronCommand, releaseCronCommand } from './cronCommandProcess';
import taskLimit from './cronLimit';
import Logger from '../../loaders/logger';
import { ICron } from '../../protos/cron';
import { CrontabModel, CrontabStatus } from '../../data/cron';
import {
  RunningInstanceModel,
  InstanceStatus,
} from '../../data/runningInstance';
import dayjs from 'dayjs';
import { observeChildProcess, asError } from '../../shared/childProcess';

const waiting = new Map<string, () => void>();
// A backlog of missed timers can otherwise open hundreds of competing SQLite
// writer transactions on wake. Only serialize history writes, never commands.
const historyWrites = new PQueue({ concurrency: 1 });
export function cancelWaitingTriggers(ids: string[]) {
  for (const id of ids) waiting.get(id)?.();
}

export async function runCron(
  cmd: string,
  cron: ICron,
  isCurrent: () => boolean = () => true,
  trigger?: { id: string; time: number; source: 'node' | 'recovery' },
): Promise<number | void> {
  const history = trigger && triggerHistory();
  const queuedAt = Date.now();
  if (trigger && history) {
    const cronId = Number(cron.id);
    const admitted = await historyWrites.add(() =>
      cron.skip_if_pending
        ? history.enqueueUnlessPending(
            trigger.id,
            cronId,
            trigger.source,
            trigger.time,
            queuedAt,
            cron.recovery_from,
          )
        : history.enqueue(
            trigger.id,
            cronId,
            trigger.source,
            trigger.time,
            queuedAt,
          ),
    );
    if (!admitted) return;
  }
  let reason = 'capacity';
  let state: TriggerState = 'skipped';
  let exitCode: number | null = null;
  let claimed = false;
  const deadline = cron.max_queue_wait
    ? queuedAt + cron.max_queue_wait * 1000
    : Infinity;
  let timer: NodeJS.Timeout | undefined;
  const expiry = trigger ? new EventEmitter() : undefined;
  const alive = () => isCurrent() && Date.now() < deadline;
  if (trigger && expiry && Number.isFinite(deadline)) {
    timer = setTimeout(() => {
      reason = 'queue_timeout';
      taskLimit.removeQueuedCron(cron.id, execute);
      expiry.emit('expired');
    }, Math.max(0, deadline - Date.now()));
    timer.unref();
  }
  const execute = async () => {
    if (trigger) waiting.delete(trigger.id);
    reason = 'changed';
    try {
      if (!alive()) {
        reason = isCurrent() ? 'queue_timeout' : 'changed';
        return;
      }
      let multiple = false;
      // A single-instance trigger must not interrupt work already in progress.
      try {
        const existingCron = await CrontabModel.findOne({
          where: { id: Number(cron.id) },
        });

        // A mutation may commit while this queued run is reading the database.
        if (!isCurrent() || !existingCron || existingCron.isDisabled) return;

        // Default to single instance mode (0) for backward compatibility
        multiple = existingCron.allow_multiple_instances === 1;

        if (!multiple) {
          // A queued manual run is an active reservation, even if its stored PID
          // belongs to a previous execution.
          if (
            existingCron.status === CrontabStatus.queued &&
            existingCron.pid
          ) {
            Logger.info(
              '[schedule][Skip queued single-instance task] Task ID: %s, PID: %s',
              cron.id,
              existingCron.pid,
            );
            reason = 'overlap';
            return;
          }
          if (
            existingCron.status === CrontabStatus.running &&
            existingCron.pid
          ) {
            if (hasLiveCronProcess(existingCron.status, existingCron.pid)) {
              Logger.info(
                '[schedule][Skip active single-instance task] Task ID: %s, PID: %s',
                cron.id,
                existingCron.pid,
              );
              reason = 'overlap';
              return;
            }

            // Capture old instance IDs before releasing the stale cron state so
            // a concurrent replacement cannot have its instance marked stopped.
            const staleInstances = await RunningInstanceModel.findAll({
              attributes: ['id'],
              where: {
                cron_id: Number(cron.id),
                pid: existingCron.pid,
                status: InstanceStatus.running,
              },
            });
            if (!isCurrent()) return;
            const [recovered] = await CrontabModel.update(
              {
                status: CrontabStatus.idle,
                pid: null,
                queued_token: null,
              } as any,
              {
                where: {
                  id: Number(cron.id),
                  pid: existingCron.pid,
                  status: CrontabStatus.running,
                  ...(existingCron.log_path !== undefined
                    ? { log_path: existingCron.log_path }
                    : {}),
                  ...(existingCron.queued_token !== undefined
                    ? { queued_token: existingCron.queued_token }
                    : {}),
                  ...(existingCron.last_execution_time !== undefined
                    ? { last_execution_time: existingCron.last_execution_time }
                    : {}),
                  ...(existingCron.isDisabled !== undefined
                    ? { isDisabled: existingCron.isDisabled }
                    : {}),
                  allow_multiple_instances: 0,
                },
              },
            );
            if (recovered !== 1) return;
            const staleIds = staleInstances.map((instance) => instance.id!);
            if (staleIds.length) {
              await RunningInstanceModel.update(
                { status: InstanceStatus.stopped, finished_at: dayjs().unix() },
                { where: { id: staleIds, status: InstanceStatus.running } },
              );
            }
            Logger.info(
              '[schedule][Recovered stale single-instance task] Task ID: %s, PID: %s',
              cron.id,
              existingCron.pid,
            );
          }
        }
      } catch (error) {
        Logger.error(
          t('[schedule][检查已运行任务失败] 任务ID: %s, 错误: %s'),
          cron.id,
          error,
        );
        throw error;
      }

      // Invalidation can happen during the asynchronous database check.
      if (!isCurrent()) return;
      Logger.info(
        t('[schedule][开始执行任务] 参数 %s'),
        JSON.stringify({
          ...cron,
          command: cmd,
        }),
      );
      clearTimeout(timer);
      if (Date.now() >= deadline) {
        reason = 'queue_timeout';
        return;
      }
      if (trigger) {
        claimed = await history!.start(trigger.id, Date.now(), multiple);
        if (!claimed) {
          reason = 'overlap';
          return;
        }
      }
      if (!isCurrent() || Date.now() >= deadline) {
        reason = isCurrent() ? 'queue_timeout' : 'changed';
        return;
      }
      let saveStart: Promise<void> | undefined;
      const cp = spawnCronCommand(
        cmd,
        trigger?.id,
        trigger && history
          ? (at) => {
              saveStart = history
                .recordCommandStart(trigger.id, at)
                .catch((error) => {
                  Logger.warn(
                    '[schedule] Could not record command start: %s',
                    asError(error).message,
                  );
                });
            }
          : undefined,
      );

      let denied: string | undefined;
      const { completed } = observeChildProcess(cp, {
        onStart: async () => {
          if (!trigger) return;
          try {
            if (
              (await history!.bindCommand(trigger.id, cp.pid!)) &&
              !(await history!.shouldStop(trigger.id))
            ) {
              if (!alive()) denied = isCurrent() ? 'queue_timeout' : 'changed';
              else await releaseCronCommand(cp);
            }
          } finally {
            cp.stdin.end();
          }
        },
        onStderr: async (message) => {
          Logger.info(
            t('[schedule][任务标准错误] 命令: %s, 信息: %s'),
            cmd,
            message,
          );
        },
      });
      const result = await completed;
      await saveStart;
      if (denied) {
        reason = denied;
        return;
      }
      state = result.signal
        ? 'stopped'
        : result.error || result.code !== 0
        ? 'failed'
        : 'finished';
      reason = result.error ? 'spawn' : result.signal || '';
      exitCode = result.code;
      if (result.error) {
        Logger.error(
          t('[schedule][执行任务失败] 命令: %s, 错误: %s'),
          cmd,
          result.error.message,
        );
      }
      Logger.info(
        t('[schedule][执行任务结束] 任务ID: %s, 退出码: %j'),
        cron.id,
        result.code,
      );
      return { ...cron, command: cmd, pid: cp.pid, ...result } as any;
    } catch (error) {
      state = 'failed';
      reason = 'spawn';
      Logger.error(
        t('[schedule][创建任务失败] 命令: %s, 错误: %s'),
        cmd,
        asError(error).message,
      );
    } finally {
      taskLimit.removeQueuedCron(cron.id, execute);
    }
  };
  try {
    if (trigger && expiry)
      waiting.set(trigger.id, () => {
        taskLimit.removeQueuedCron(cron.id, execute);
        expiry.emit('expired');
      });
    return await taskLimit.runWithCronLimit(
      cron,
      execute,
      undefined,
      isCurrent,
      () => {
        reason = 'pending';
      },
      expiry,
      trigger?.id,
      CrontabModel.sequelize,
    );
  } finally {
    clearTimeout(timer);
    if (trigger) waiting.delete(trigger.id);
    if (trigger && history) {
      const outcomeReason =
        state === 'skipped' && !isCurrent() ? 'changed' : reason;
      const finishedAt = Date.now();
      await historyWrites.add(
        () =>
          state === 'skipped' && !claimed
            ? history.skipQueued(trigger.id, outcomeReason, finishedAt)
            : history.complete(
                trigger.id,
                state,
                outcomeReason || null,
                exitCode,
                finishedAt,
              ),
        { priority: 1 },
      );
    }
  }
}
