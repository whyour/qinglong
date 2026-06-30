import { ServerUnaryCall, sendUnaryData, status } from '@grpc/grpc-js';
import { AddCronRequest, AddCronResponse } from '../protos/cron';
import nodeSchedule from 'node-schedule';
import { scheduleStacks } from './data';
import { runCron } from '../shared/runCron';
import Logger from '../loaders/logger';
import { tf } from '../shared/i18n';

/**
 * 预校验 cron 表达式，检测 node-schedule 会拒绝但 cron-parser 会接受的 pattern。
 * node-schedule 对 bare /N（字段以 / 开头，如前无星号/数字前缀的 /6）返回 null，
 * 提前拦截避免走 scheduleJob 后才发现无效。
 */
const isValidCronField = (cron: string): boolean => {
  // 检测 bare /N 模式：字段以 / 开头如 "/6"，或空格后紧跟 "/6"
  // node-schedule 会对这种字段返回 null
  if (/\s\/\d/.test(cron) || /^\/\d/.test(cron)) {
    return false;
  }
  // 检测 ? 字符：Quartz cron 语法，node-schedule 在大多数位置返回 null
  // cron-parser 接受但 node-schedule 拒绝，提前拦截
  if (/\?/.test(cron)) {
    return false;
  }
  return true;
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
          '任务ID %s: 无效的 cron 表达式 "%s"（不支持裸 /N 步长和 ? 字符）',
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
              '任务ID %s (extra_schedule): 无效的 cron 表达式 "%s"（不支持裸 /N 步长和 ? 字符）',
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
