import { resolveFileAccess } from './fileAccess';

export function assertSubscriptionAlias(alias: string): void {
  if (
    typeof alias !== 'string' ||
    alias.length > 200 ||
    !/^[\p{L}\p{N}_.-]+$/u.test(alias) ||
    alias === '.' ||
    alias === '..'
  ) {
    throw Object.assign(new Error('Invalid subscription alias'), {
      status: 400,
    });
  }
}

export function resolveSubscriptionPath(
  root: string,
  alias: string,
  suffix = '',
): string {
  // The prefix is reserved for the existing global SSH key feature.
  assertSubscriptionAlias(
    alias.startsWith('~global_') ? alias.slice(8) : alias,
  );
  const target = resolveFileAccess(root, [alias + suffix]);
  if (!target)
    throw Object.assign(new Error('Invalid subscription path'), {
      status: 400,
    });
  return target;
}
