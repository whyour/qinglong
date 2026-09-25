import { translate } from '../../shared/i18n/index';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../runtime/process';
import { fail } from '../../shared/errors';

// Legacy random_delay substitutes literal spaces with ERE alternatives.
// Preserve the host grep engine and locale rather than translating ERE to JS.
export async function matchesDelayExtension(
  filename: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<boolean> {
  const extensions = env.RandomDelayFileExtensions ?? 'js';
  if (!extensions) return true;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-delay-'));
  try {
    const listing = path.join(directory, 'filename');
    await fs.writeFile(listing, filename + '\n', { mode: 0o600 });
    const pattern = `\\.${extensions.replace(/ /g, '$|\\.')}$`;
    const result = await runProcess(
      'grep',
      ['-qE', '-e', pattern, '--', listing],
      {
        env,
        signal,
        timeoutMs: 10000,
      },
    );
    if (signal?.aborted)
      throw Object.assign(new Error(translate(env, '任务延迟过滤已取消。')), {
        name: 'AbortError',
        code: 'ABORT_ERR',
      });
    // Original `if ! grep` skips delay for both no match and invalid patterns.
    if (result.code === 0) return true;
    if (result.code === 1 || result.code === 2) return false;
    fail(translate(env, '任务延迟过滤失败（退出码 %s）。', result.code));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
