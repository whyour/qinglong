import { resolveFileAccess } from './fileAccess';
import { createHash } from 'crypto';

export function assertSubscriptionAlias(alias: string): void {
  if (
    typeof alias !== 'string' ||
    alias.length > 200 ||
    !/^[^\s\\\p{C}]+$/u.test(alias) ||
    alias.startsWith('~') ||
    alias.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw Object.assign(new Error('Invalid subscription alias'), {
      status: 400,
    });
  }
}

/** Keep ordinary SSH names and use a reserved namespace for path-like aliases.
 * The database alias and its script/log directories remain unchanged. */
export function getSubscriptionSshAlias(alias: string): string {
  assertSubscriptionAlias(alias);
  if (/^[\p{L}\p{N}_.+-]+$/u.test(alias) && !alias.endsWith('.config')) {
    return alias;
  }
  return `~sub_${createHash('sha256').update(alias).digest('hex')}`;
}

export function resolveSubscriptionPath(
  root: string,
  alias: string,
  suffix = '',
): string {
  // Internal SSH filenames cannot collide with user-supplied aliases.
  if (!/^~sub_[a-f0-9]{64}$/.test(alias)) {
    assertSubscriptionAlias(
      alias.startsWith('~global_') ? alias.slice(8) : alias,
    );
  }
  const target = resolveFileAccess(root, [alias + suffix]);
  if (!target)
    throw Object.assign(new Error('Invalid subscription path'), {
      status: 400,
    });
  return target;
}
