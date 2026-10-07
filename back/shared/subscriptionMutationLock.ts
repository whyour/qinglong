import lockfile from 'proper-lockfile';
import path from 'path';
import config from '../config';

// Protect subscription storage ownership from the first database read through
// cleanup. Creation and URL/branch updates must use the same cross-process lock.
export async function withSubscriptionMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const target = `${path.resolve(config.scriptPath)}.subscriptions`;
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(target, {
      realpath: false,
      stale: 30000,
      update: 10000,
      retries: { retries: 50, factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
  } catch (cause) {
    throw Object.assign(
      new Error('Subscription configuration is busy', { cause }),
      { status: 503 },
    );
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}
