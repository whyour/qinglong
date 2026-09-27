import { ServerUnaryCall, sendUnaryData, status } from '@grpc/grpc-js';
import { AddCronRequest, AddCronResponse } from '../protos/cron';
import nodeSchedule from 'node-schedule';
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
        tf(
          '任务ID %s: 无效的 cron 表达式 "%s"',
          String(id),
          schedule,
        ),
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

  // Recovery replaces the whole snapshot, including deletions and disabled jobs.
  // Validation above must finish before touching the previous schedule.
  if (call.request.replace) {
    for (const jobs of scheduleStacks.values()) {
      for (const job of jobs) job?.cancel();
    }
    scheduleStacks.clear();
  }

  // ===== 第二遍：注册所有任务 =====
  for (const item of call.request.crons) {
    const { id, schedule, command, extra_schedules, name } = item;

    // 取消该 id 已有的旧任务
    if (scheduleStacks.has(id)) {
      scheduleStacks.get(id)?.forEach((x) => x.cancel());
    }

    Logger.info(
      '[schedule][创建定时任务] 任务ID: %s, 名称: %s, cron: %s, 执行命令: %s',
      id,
      name,
      schedule,
      command,
    );

    if (extra_schedules?.length) {
      extra_schedules.forEach((x) => {
        Logger.info(
          '[schedule][创建定时任务] 任务ID: %s, 名称: %s, cron: %s, 执行命令: %s',
          id,
          name,
          x.schedule,
          command,
        );
      });
    }

    const mainJob = nodeSchedule.scheduleJob(id, schedule, async () => {
      Logger.info(`[schedule][准备运行任务] 命令: ${command}`);
      runCron(command, item);
    });

    if (!mainJob) {
      Logger.warn(
        '[schedule][创建定时任务] scheduleJob 返回 null（不符合预期，已通过预校验）: 任务ID: %s, cron: %s',
        id,
        schedule,
      );
    }

    const extraJobs = extra_schedules?.length
      ? extra_schedules.map((x) => {
          const job = nodeSchedule.scheduleJob(id, x.schedule, async () => {
            Logger.info(`[schedule][准备运行任务] 命令: ${command}`);
            runCron(command, item);
          });
          if (!job) {
            Logger.warn(
              '[schedule][创建定时任务] scheduleJob 返回 null（不符合预期，已通过预校验）: 任务ID: %s, cron: %s',
              id,
              x.schedule,
            );
          }
          return job;
        })
      : [];

    // 过滤 null（兜底保护，正常情况下预校验已拦截）
    const jobs = [mainJob, ...extraJobs].filter((x) => x != null);
    if (jobs.length > 0) {
      scheduleStacks.set(id, jobs);
    }
  }

  callback(null, null);
};

export { addCron };
