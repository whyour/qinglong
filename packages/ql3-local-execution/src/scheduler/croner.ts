import type {
  LocalCronNextOccurrence,
  LocalCronSchedule,
} from '@qinglong/runtime-core/local-scheduler';

interface CronerJob {
  nextRun(after: Date): Date | null;
  stop(): void;
}

interface CronerConstructor {
  new (
    expression: string,
    options: Readonly<{
      timezone: string;
      paused: true;
      unref: true;
    }>,
  ): CronerJob;
}

export const cronerLocalNextOccurrence: LocalCronNextOccurrence = (
  schedule: LocalCronSchedule,
  afterMs: number,
): number => {
  let job: CronerJob | undefined;
  try {
    const { Cron } = require('croner') as Readonly<{
      Cron: CronerConstructor;
    }>;
    job = new Cron(schedule.expression, {
      timezone: schedule.timezone,
      paused: true,
      unref: true,
    });
    const next = job.nextRun(new Date(afterMs));
    if (!(next instanceof Date)) {
      throw new Error('cron has no next occurrence');
    }
    return next.getTime();
  } finally {
    job?.stop();
  }
};
