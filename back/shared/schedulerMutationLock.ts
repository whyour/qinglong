import lockfile from 'proper-lockfile';
import config from '../config';

// HTTP and gRPC both mutate cron definitions. Hold one shared lock from the
// initial DB read/write through scheduler registration (including rollback).
// Recovery takes the same lock before reading its replacement snapshot.
export async function withSchedulerMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(config.crontabFile, {
      realpath: false,
      lockfilePath: `${config.crontabFile}.scheduler.lock`,
      stale: 30000,
      update: 10000,
      retries: { retries: 50, factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
  } catch (cause) {
    throw Object.assign(
      new Error('Scheduler configuration is busy', { cause }),
      {
        status: 503,
      },
    );
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}

export function schedulerRegistrationError(message: string, cause: any): Error {
  return Object.assign(new Error(message, { cause }), {
    status: cause?.status === 503 ? 503 : 500,
  });
}
