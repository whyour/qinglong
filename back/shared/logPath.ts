import { resolveFileAccess } from './fileAccess';

/** Check stored paths too: old database rows are not trusted input. */
export function resolveLogPath(root: string, value: string): string {
  const target = resolveFileAccess(root, [value]);
  if (!target)
    throw Object.assign(new Error('Log path is outside the log directory'), {
      status: 400,
    });
  return target;
}
