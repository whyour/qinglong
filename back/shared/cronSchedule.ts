import CronExpressionParser from 'cron-parser';
import { validate } from 'node-cron';
import { ScheduleType } from '../interface/schedule';

const aliases: Record<string, string> = {
  '@yearly': '0 0 0 1 1 *',
  '@monthly': '0 0 0 1 * *',
  '@weekly': '0 0 0 * * 0',
  '@daily': '0 0 0 * * *',
  '@hourly': '0 0 * * * *',
};

export interface CronSchedule {
  patterns: string[];
  dayCount: number;
  nthDay: number;
}

// Validation and registration repeatedly see identical rules in large snapshots.
// Cache only immutable syntax, never dates or running tasks, and bound user input.
const scheduleCache = new Map<string, CronSchedule>();

// Canonicalize legacy shorthand, aliases, names and numeric-start steps before
// node-cron sees them. Keep the old accepted syntax boundary (no H or bare /N).
export function parseCronSchedule(schedule: unknown): CronSchedule {
  if (typeof schedule !== 'string' || !schedule.trim()) {
    throw new Error('Invalid cron schedule');
  }
  let source = schedule.trim();
  const cacheKey = source;
  const cached = scheduleCache.get(cacheKey);
  if (cached) return cached;
  if (source.startsWith('@')) {
    if (!Object.hasOwn(aliases, source)) throw new Error('Invalid cron alias');
    source = aliases[source];
  }
  let parts = source.split(/\s+/);
  if (
    parts.length > 6 ||
    parts.some((part) => /(^|,)\//.test(part) || /H(?:\(|\/|$)/i.test(part))
  ) {
    throw new Error('Unsupported cron syntax');
  }
  parts = [
    ...['0', '*', '*', '*', '*', '*'].slice(0, 6 - parts.length),
    ...parts,
  ];
  if (
    parts.some(
      (part, index) => index !== 3 && index !== 5 && part.includes('?'),
    )
  ) {
    throw new Error('Question mark is only valid in day fields');
  }
  const expression = CronExpressionParser.parse(parts.join(' '));
  if (!expression.hasNext())
    throw new Error('Cron schedule has no next execution');
  const normalized = expression.stringify(true).replace(/\?/g, '*').split(' ');
  const dayCount = expression.fields.dayOfMonth.values.length;
  const weekCount = expression.fields.dayOfWeek.values.length;
  const patterns =
    dayCount < 31 && weekCount < 8
      ? [
          [...normalized.slice(0, 5), '*'].join(' '),
          [...normalized.slice(0, 3), '*', ...normalized.slice(4)].join(' '),
        ]
      : [normalized.join(' ')];
  if (!patterns.every((pattern) => validate(pattern))) {
    throw new Error('Unsupported cron schedule');
  }
  const parsed = {
    patterns,
    dayCount,
    nthDay: expression.fields.dayOfWeek.nthDay,
  };
  Object.freeze(patterns);
  Object.freeze(parsed);
  if (scheduleCache.size >= 512)
    scheduleCache.delete(scheduleCache.keys().next().value);
  scheduleCache.set(cacheKey, parsed);
  return parsed;
}

export function isValidCronSchedule(schedule: unknown): schedule is string {
  try {
    parseCronSchedule(schedule);
    return true;
  } catch {
    return false;
  }
}

export function getInvalidCronSchedules(cron: {
  schedule?: string;
  extra_schedules?: Array<{ schedule: string }>;
}): unknown[] {
  if (
    cron.schedule?.startsWith(ScheduleType.ONCE) ||
    cron.schedule?.startsWith(ScheduleType.BOOT)
  ) {
    return [];
  }
  return [
    cron.schedule,
    ...(cron.extra_schedules || []).map((x) => x.schedule),
  ].filter((schedule) => !isValidCronSchedule(schedule));
}
