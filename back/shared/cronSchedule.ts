import cronParser from 'cron-parser-v4';
import { ScheduleType } from '../interface/schedule';

// Keep validation aligned with node-schedule's locked cron-parser version.
// cron-parser 5 accepts syntax (e.g. H) that the scheduler cannot execute.
export function isValidCronSchedule(schedule: unknown): schedule is string {
  if (typeof schedule !== 'string' || !schedule.trim()) return false;
  try {
    return cronParser.parseExpression(schedule).hasNext();
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
  return [cron.schedule, ...(cron.extra_schedules || []).map((x) => x.schedule)]
    .filter((schedule) => !isValidCronSchedule(schedule));
}
