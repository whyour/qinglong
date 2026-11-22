import Logger from '../loaders/logger';
import { performance } from 'perf_hooks';

export async function startupStage<T>(
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.env.QL_STARTUP_TIMING !== '1') return operation();
  const started = performance.now();
  try {
    return await operation();
  } finally {
    const role = process.env.SERVICE_TYPE || 'primary';
    Logger.info(
      `[boot:timing] ${role}:${name} ${Math.round(
        performance.now() - started,
      )}ms (PID: ${process.pid})`,
    );
  }
}
