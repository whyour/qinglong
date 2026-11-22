import { t } from '../../shared/i18n';
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

function acceptsSlot(
  parsed: ReturnType<typeof parseCronSchedule>,
  tasks: ScheduledTask[],
  index: number,
  date: Date,
) {
  if (tasks.length === 1) return true;
  // Preserve cron-parser 4's day/weekday OR semantics, including its
  // month-dependent full-day range and the global nth-week constraint.
  if (parsed.nthDay && Math.ceil(date.getDate() / 7) !== parsed.nthDay)
    return false;
  if (index === 1) return !tasks[0].match(date);
  const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return parsed.dayCount < monthDays[date.getMonth()] || tasks[1].match(date);
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
  const dispatch = async (index: number, date: Date, missed: boolean) => {
    if (cancelled || !started || !acceptsSlot(parsed, tasks, index, date))
      return;
    if (missed) {
      options.logger.warn(
        t('[schedule][补执行迟到任务] 任务: %s, 计划时间: %s'),
        options.name,
        date.toISOString(),
      );
    }
    try {
      await callback(date);
    } catch (error) {
      options.logger.error(
        t('[schedule][定时回调失败] 任务: %s, 错误: %s'),
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

// node-cron 4.6.0 exposes getNextRuns only from the wall clock. Its pinned
// inline matcher also accepts an explicit cursor, needed for previews and recovery.
export function upcomingSlots(
  schedule: string,
  after: number,
  count = 1,
  through?: number,
): number[] {
  const parsed = parseCronSchedule(schedule);
  const tasks: ScheduledTask[] = [];
  try {
    const matchers = parsed.patterns.map((pattern) => {
      const task = createTask(pattern, () => {});
      tasks.push(task);
      return (
        task as ScheduledTask & {
          timeMatcher: {
            getNextMatch(date: Date): Date;
            expressions: number[][];
          };
        }
      ).timeMatcher;
    });
    const next = matchers.map((matcher) =>
      matcher.getNextMatch(new Date(after)),
    );
    // All calendar branches share their clock fields. For bounded audit ranges,
    // resolve each matching minute once, including the matcher's DST choice.
    const seconds =
      through == null
        ? []
        : [...new Set(matchers[0].expressions[0])].sort((a, b) => a - b);
    const slots: number[] = [];
    let horizon = after + 366 * 100 * 86400000;
    while (slots.length < count) {
      const time = Math.min(...next.map(Number));
      if (through != null && time > through) break;
      if (!Number.isFinite(time) || time > horizon)
        throw new Error('No matching calendar date');
      let accepted = false;
      next.forEach((date, index) => {
        if (+date !== time) return;
        const valid = acceptsSlot(parsed, tasks, index, date);
        accepted ||= valid;
        // Both branches share the clock fields. Rejection applies to the
        // entire local day, including schedules that fire every second.
        const cursor = new Date(time);
        if (!valid) cursor.setHours(23, 59, 59, 999);
        else if (through != null) cursor.setTime(time - (time % 60000) + 59999);
        next[index] = matchers[index].getNextMatch(cursor);
      });
      if (accepted) {
        if (through == null) slots.push(time);
        else
          for (const second of seconds) {
            const slot = time - (time % 60000) + second * 1000;
            if (slot >= time && slot <= through && slots.length < count)
              slots.push(slot);
          }
        horizon = time + 366 * 100 * 86400000;
      }
    }
    return slots;
  } finally {
    tasks.forEach((task) => task.destroy());
  }
}
