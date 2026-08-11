import type { ExecutionContext } from './execution';

export const MAX_EXECUTION_ENVIRONMENT_ENTRIES = 256;
export const MAX_EXECUTION_ENVIRONMENT_BYTES = 256 * 1024;
export const MAX_EXECUTION_ENVIRONMENT_VALUE_BYTES = 64 * 1024;

export function normalizeExecutionContext(
  context: ExecutionContext,
): ExecutionContext {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('ExecutionContext must be an object');
  }
  const environment = context.environment;
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment)
  ) {
    throw new TypeError('ExecutionContext environment must be an object');
  }
  const entries = Object.entries(environment);
  if (entries.length > MAX_EXECUTION_ENVIRONMENT_ENTRIES) {
    throw new RangeError('ExecutionContext environment has too many entries');
  }
  const cloned: Record<string, string> = Object.create(null);
  let totalBytes = 0;
  for (const [name, value] of entries) {
    if (
      name.length < 1 ||
      name.length > 255 ||
      name.includes('=') ||
      name.includes('\0') ||
      typeof value !== 'string' ||
      value.includes('\0')
    ) {
      throw new TypeError('ExecutionContext environment entry is invalid');
    }
    const valueBytes = Buffer.byteLength(value, 'utf8');
    if (valueBytes > MAX_EXECUTION_ENVIRONMENT_VALUE_BYTES) {
      throw new RangeError('ExecutionContext environment value is too large');
    }
    totalBytes += Buffer.byteLength(name, 'utf8') + valueBytes;
    if (totalBytes > MAX_EXECUTION_ENVIRONMENT_BYTES) {
      throw new RangeError('ExecutionContext environment is too large');
    }
    cloned[name] = value;
  }
  if (
    !context.output ||
    typeof context.output !== 'object' ||
    typeof context.output.write !== 'function'
  ) {
    throw new TypeError('ExecutionContext output sink is invalid');
  }
  if (
    context.signal !== undefined &&
    (!context.signal ||
      typeof context.signal !== 'object' ||
      typeof context.signal.aborted !== 'boolean' ||
      (context.signal.addEventListener !== undefined &&
        typeof context.signal.addEventListener !== 'function') ||
      (context.signal.removeEventListener !== undefined &&
        typeof context.signal.removeEventListener !== 'function'))
  ) {
    throw new TypeError('ExecutionContext signal is invalid');
  }
  return {
    environment: Object.freeze(cloned),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    output: context.output,
  };
}
