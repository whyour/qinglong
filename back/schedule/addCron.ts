import { ServerUnaryCall, sendUnaryData, status } from '@grpc/grpc-js';
import { AddCronRequest, AddCronResponse } from '../protos/cron';
import { createCronJob, CronJob } from '../shared/cronScheduler';
import { isValidCronSchedule } from '../shared/cronSchedule';
import { scheduleStacks } from './data';
import { latestMissedSlot } from '../shared/cronRecovery';
import { slotId } from '../shared/triggerHistory';
import { runCron } from '../shared/runCron';
import Logger from '../loaders/logger';
import { t, tf } from '../shared/i18n';

// Validate the entire batch before replacing any existing jobs.
const isValidCronField = (cron: string): boolean => {
  return isValidCronSchedule(cron);
};

const definitions = new WeakMap<CronJob[], string>();

const addCron = (
  call: ServerUnaryCall<AddCronRequest, AddCronResponse>,
  callback: sendUnaryData<AddCronResponse>,
  savePlan?: () => Promise<void>,
) => {
  // ===== 第一遍：预校验所有 cron 表达式 =====
  const validationErrors: string[] = [];

  for (const item of call.request.crons) {
    const { id, schedule, extra_schedules } = item;

    if (!isValidCronField(schedule)) {
      validationErrors.push(
        tf('任务ID %s: 无效的 cron 表达式 "%s"', String(id), schedule),
      );
    }

    if (extra_schedules?.length) {
      extra_schedules.forEach((x) => {
        if (!isValidCronField(x.schedule)) {
          validationErrors.push(
            tf(
              '任务ID %s (extra_schedule): 无效的 cron 表达式 "%s"',
              String(id),
              x.schedule,
            ),
          );
        }
      });
    }
  }

  if (validationErrors.length > 0) {
    const details = validationErrors.join('\n');
    const err: any = new Error(details);
    err.code = status.INVALID_ARGUMENT;
    err.details = details;
    callback(err, null);
    return;
  }

  // Prepare stopped jobs first: construction errors must preserve the old snapshot.
  const prepared = new Map<string, CronJob[]>();
  const desired = new Map(call.request.crons.map((item) => [item.id, item]));
  const recoveries: (() => Promise<void>)[] = [];
  try {
    for (const item of desired.values()) {
      const signature = JSON.stringify([item.schedule, item.command,
        (item.extra_schedules || []).map((s) => s.schedule), item.max_queue_wait || 0,
        !!item.skip_if_pending, item.catchup_seconds || 0, item.catchup_seconds || item.skip_if_pending ? item.recovery_from : 0]);
      const current = scheduleStacks.get(item.id);
      if (current && definitions.get(current) === signature) continue;
      const jobs: CronJob[] = [];
      definitions.set(jobs, signature);
      prepared.set(item.id, jobs);
      for (const [ruleIndex, schedule] of [
        item.schedule,
        ...(item.extra_schedules || []).map((x) => x.schedule),
      ].entries()) {
        const fire = async (date: Date, source: 'node' | 'recovery' = 'node') => {
          const isCurrent = () => scheduleStacks.get(item.id) === jobs;
          if (!isCurrent()) return;
          await runCron(item.command, item, isCurrent, date && {
            id: slotId(item.id, ruleIndex, schedule, +date), time: +date, source,
          });
        };
        if (call.request.replace && item.catchup_seconds && item.recovery_from) {
          recoveries.push(async () => {
            const now = Date.now();
            const since = Math.max(item.recovery_from!, now - item.catchup_seconds! * 1000);
            const time = latestMissedSlot(schedule, since, now);
            if (time !== null) await fire(new Date(time), 'recovery');
          });
        }
        jobs.push(
          createCronJob(
            schedule,
            fire,
            {
              name: `${item.id}: ${item.name || ''}`,
              logger: Logger,
              start: false,
            },
          ),
        );
      }
    }
  } catch (error) {
    for (const jobs of prepared.values()) jobs.forEach((job) => job.cancel());
    const err: any = new Error(
      error instanceof Error ? error.message : String(error),
    );
    err.code = status.INVALID_ARGUMENT;
    err.details = err.message;
    callback(err, null);
    return;
  }

  const activate = () => {
    if (call.request.replace) {
      for (const [id, jobs] of scheduleStacks) {
        if (desired.has(id)) continue;
        jobs.forEach((job) => job?.cancel());
        scheduleStacks.delete(id);
      }
    }
    for (const [id, jobs] of prepared) {
      scheduleStacks.get(id)?.forEach((job) => job.cancel());
      scheduleStacks.set(id, jobs);
      jobs.forEach((job) => job.start());
      Logger.info(
        t('[schedule][创建定时任务] 任务ID: %s, 规则数: %s'),
        id,
        jobs.length,
      );
    }

    callback(null, null);
    for (const recover of recoveries) setImmediate(() => recover().catch((err) => Logger.error(String(err))));
  };
  if (savePlan) {
    savePlan().then(activate).catch(error => {
      for (const jobs of prepared.values()) jobs.forEach(job => job.cancel());
      callback(error);
    });
  } else activate();
};

export { addCron };
