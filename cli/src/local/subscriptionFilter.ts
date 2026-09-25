import { translate } from '../i18n';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProcess } from './process';
import { fail } from '../errors';

// Use the installation's POSIX ERE implementation, just as legacy egrep did.
// Patterns are argv data; no shell is involved.
export async function matchSubscriptionPaths(
  files: string[],
  pattern: string | undefined,
  workspace: string,
  env: NodeJS.ProcessEnv,
): Promise<Set<string>> {
  if (!pattern) return new Set(files);
  if (files.some((file) => /[\r\n\0]/.test(file)))
    fail(translate(env, '订阅路径包含换行或空字符，无法安全过滤。'), 2);
  const listing = path.join(workspace, `filter-${randomUUID()}.list`);
  const input = files.length ? files.join('\n') + '\n' : '';
  await fs.writeFile(listing, input, { mode: 0o600, flag: 'wx' });
  try {
    const result = await runProcess(
      'grep',
      ['-E', '-e', pattern, '--', listing],
      {
        env,
        capture: true,
        maxCaptureBytes: Buffer.byteLength(input) + 1,
        timeoutMs: 10000,
      },
    );
    if (result.code === 1) return new Set();
    if (result.code === 2)
      fail(translate(env, '订阅 POSIX 正则表达式无效。'), 2);
    if (result.code !== 0)
      fail(translate(env, '订阅过滤失败（退出码 %s）。', result.code));
    return new Set(result.stdout.split('\n').filter(Boolean));
  } finally {
    await fs.rm(listing, { force: true });
  }
}
