import { ServerUnaryCall, sendUnaryData, status } from '@grpc/grpc-js';
import { AddCronRequest, AddCronResponse } from '../protos/cron';
import { createCronJob, CronJob } from '../shared/cronScheduler';
import { isValidCronSchedule } from '../shared/cronSchedule';
import { scheduleStacks } from './data';
import { runCron } from '../shared/runCron';
import Logger from '../loaders/logger';
import { tf } from '../shared/i18n';

// Validate the entire batch before replacing any existing jobs.
const isValidCronField = (cron: string): boolean => {
  return isValidCronSchedule(cron);
};

const addCron = (
  call: ServerUnaryCall<AddCronRequest, AddCronResponse>,
  callback: sendUnaryData<AddCronResponse>,
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
  try {
    for (const item of call.request.crons) {
      const jobs: CronJob[] = [];
      prepared.get(item.id)?.forEach((job) => job.cancel());
      prepared.set(item.id, jobs);
      for (const schedule of [
        item.schedule,
        ...(item.extra_schedules || []).map((x) => x.schedule),
      ]) {
        jobs.push(
          createCronJob(
            schedule,
            async () => {
              Logger.info('[schedule][准备运行任务] 命令: %s', item.command);
              await runCron(
                item.command,
                item,
                () => scheduleStacks.get(item.id) === jobs,
              );
            },
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

  if (call.request.replace) {
    for (const jobs of scheduleStacks.values())
      jobs.forEach((job) => job?.cancel());
    scheduleStacks.clear();
  }
  for (const [id, jobs] of prepared) {
    scheduleStacks.get(id)?.forEach((job) => job.cancel());
    scheduleStacks.set(id, jobs);
    jobs.forEach((job) => job.start());
    Logger.info(
      '[schedule][创建定时任务] 任务ID: %s, 规则数: %s',
      id,
      jobs.length,
    );
  }

  callback(null, null);
};

export { addCron };
