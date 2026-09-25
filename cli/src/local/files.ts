import { translate } from '../i18n';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../errors';

export function within(
  root: string,
  relative: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const target = path.resolve(root, relative);
  const relation = path.relative(root, target);
  if (
    !relation ||
    relation === '..' ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  )
    fail(translate(environment, '路径必须位于其管理目录内部。'), 2);
  return target;
}

export async function regularFiles(root: string): Promise<string[]> {
  const pending = [''];
  const result: string[] = [];
  while (pending.length) {
    const relative = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, relative), {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) pending.push(name);
      else if (entry.isFile()) result.push(name);
    }
  }
  return result.sort();
}

export async function atomicWrite(
  target: string,
  contents: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, contents, { mode, flag: 'wx' });
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
