import { createTask, ScheduledTask } from 'node-cron';
import { parseCronSchedule } from './cronSchedule';

interface SchedulerLogger {
  warn(message: string, ...args: unknown[]): unknown;
  error(message: string, ...args: unknown[]): unknown;
}

export interface CronJob {
  start(): void;
  cancel(): void;
}

// node-cron owns timers and calendar calculation; Qinglong owns execution
// concurrency and process lifetime. Missed in-process slots join that same queue.
export function createCronJob(
  schedule: string,
  callback: (date: Date) => unknown | Promise<unknown>,
  options: { name: string; logger: SchedulerLogger; start?: boolean },
): CronJob {
  const parsed = parseCronSchedule(schedule);
  const tasks: ScheduledTask[] = [];
  let cancelled = false;
  let started = false;
  const accepts = (index: number, date: Date) => {
    if (tasks.length === 1) return true;
    // Preserve cron-parser 4's day/weekday OR semantics, including its
    // month-dependent full-day range and the global nth-week constraint.
    if (parsed.nthDay && Math.ceil(date.getDate() / 7) !== parsed.nthDay)
      return false;
    if (index === 1) return !tasks[0].match(date);
    const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return parsed.dayCount < monthDays[date.getMonth()] || tasks[1].match(date);
  };
  const dispatch = async (index: number, date: Date, missed: boolean) => {
    if (cancelled || !started || !accepts(index, date)) return;
    if (missed) {
      options.logger.warn(
        '[schedule][补执行迟到任务] 任务: %s, 计划时间: %s',
        options.name,
        date.toISOString(),
      );
    }
    try {
      await callback(date);
    } catch (error) {
      options.logger.error(
        '[schedule][定时回调失败] 任务: %s, 错误: %s',
        options.name,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  try {
    for (const [index, pattern] of parsed.patterns.entries()) {
      const task = createTask(
        pattern,
        (context) => dispatch(index, context.date, false),
        {
          noOverlap: false,
          missedExecutionTolerance: 5000,
        },
      );
      tasks.push(task);
      task.on('execution:missed', (context) =>
        dispatch(index, context.date, true),
      );
      // Fail before an existing schedule is cancelled, including impossible dates.
      task.getNextRuns(1);
    }
  } catch (error) {
    tasks.forEach((task) => task.destroy());
    throw error;
  }
  const job: CronJob = {
    start() {
      if (started || cancelled) return;
      started = true;
      tasks.forEach((task) => task.start());
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      tasks.forEach((task) => task.destroy());
    },
  };
  if (options.start !== false) job.start();
  return job;
}
