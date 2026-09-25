import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:os';

const storage = new AsyncLocalStorage<AbortSignal>();
// Match the six signals handled by the retained 2.x task.sh entrypoint.
export const commandSignals = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGQUIT',
  'SIGALRM',
  'SIGTSTP',
] as const;

export function commandSignal(
  reason: unknown,
): (typeof commandSignals)[number] {
  return commandSignals.find((name) => name === reason) ?? 'SIGTERM';
}

export const operationSignal = (): AbortSignal | undefined =>
  storage.getStore();

export function interruptedCode(signal?: AbortSignal): number | undefined {
  if (!signal?.aborted) return undefined;
  const reason: unknown = signal.reason;
  const name = commandSignal(reason);
  return 128 + constants.signals[name];
}

export async function cancellableOperation<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!signal) return operation();
  signal.throwIfAborted();
  const result = await storage.run(signal, operation);
  signal.throwIfAborted();
  return result;
}

export async function withCommandCancellation(
  operation: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  const listeners = commandSignals.map((name) => {
    const listener = () => controller.abort(name);
    process.on(name, listener);
    return { name, listener };
  });
  try {
    return await operation(controller.signal);
  } finally {
    for (const { name, listener } of listeners) process.off(name, listener);
  }
}

// Recovery must finish even after the operation that triggered it was cancelled.
export function withoutCancellation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return storage.exit(operation);
}

export function requestCancellation(timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const parent = operationSignal();
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  const timeout = setTimeout(
    () => controller.abort(new Error('Request timed out.')),
    timeoutMs,
  );
  timeout.unref();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    },
  };
}
