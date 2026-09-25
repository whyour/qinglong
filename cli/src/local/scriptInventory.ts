import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { LocalContext } from './context';

// Inspect legacy top-level JS candidates without importing or executing them.
export async function listTaskScripts(
  context: LocalContext,
): Promise<{ file: string; name: string | null }[]> {
  const directory = context.paths.dir_scripts!;
  const entries = await fs
    .readdir(directory)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  const scripts: { file: string; name: string | null }[] = [];
  for (const file of entries.sort()) {
    if (!file.endsWith('.js') || file === 'sendNotify.js') continue;
    const target = path.join(directory, file);
    if (!(await fs.stat(target)).isFile()) continue;
    const input = createReadStream(target, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let name: string | null = null;
    try {
      for await (const line of lines) {
        const match = /\bnew\s+Env\s*\(\s*(['"])(.*?)\1/.exec(line);
        if (match) {
          name = match[2]!;
          break;
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
    scripts.push({ file, name });
  }
  return scripts;
}
