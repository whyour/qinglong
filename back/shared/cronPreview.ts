import { upcomingSlots } from './cronScheduler';

type Definition = {
  schedule?: string;
  extra_schedules?: { schedule: string }[];
  isDisabled?: number;
  saved?: boolean;
};
const cache = new Map<string, { after: number; times: number[] }>();

export function previewSchedule(
  schedule: string,
  count: number,
  now: number,
): number[] {
  const key = JSON.stringify([
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    schedule,
  ]);
  const cached = cache.get(key);
  if (cached && now >= cached.after) {
    const future = cached.times.filter((time) => time > now);
    if (future.length >= count) return future.slice(0, count);
  }
  const times = upcomingSlots(schedule, now, count);
  if (cache.size >= 512) cache.delete(cache.keys().next().value!);
  cache.set(key, { after: now, times });
  return times;
}

export function withNextRun<T extends Definition>(cron: T) {
  let nextRunTime: number | null = null;
  if (
    cron.schedule &&
    !cron.isDisabled &&
    cron.saved !== false &&
    !cron.schedule.startsWith('@once') &&
    !cron.schedule.startsWith('@boot')
  ) {
    try {
      const now = Date.now();
      nextRunTime = Math.min(
        ...[
          cron.schedule,
          ...(cron.extra_schedules || []).map((x) => x.schedule),
        ].map((rule) => previewSchedule(rule, 1, now)[0]),
      );
    } catch {
      // Legacy invalid rows remain visible and editable.
    }
  }
  return { ...cron, nextRunTime };
}
