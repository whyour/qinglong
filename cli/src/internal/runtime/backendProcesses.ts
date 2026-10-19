import fs from 'node:fs/promises';
import path from 'node:path';
const { armv6ServerArgs } = require('../maintenance/nodeRuntime.cjs') as {
  armv6ServerArgs: readonly string[];
};

// Linux preserves argv boundaries in cmdline. Resolve relative entrypoints from
// each process's cwd, not from the operator's cwd or a broad ps substring match.
export async function findDirectBackendPids(
  entry: string,
  procRoot = '/proc',
): Promise<number[]> {
  const expected = await fs
    .realpath(entry)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  if (!expected) return [];
  const matches: number[] = [];
  for (const name of await fs.readdir(procRoot)) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
    const directory = path.join(procRoot, name);
    try {
      const command = await fs.readFile(
        path.join(directory, 'cmdline'),
        'utf8',
      );
      const args = command.split('\0');
      if (args.at(-1) === '') args.pop();
      // Accept only the two launch shapes we own. Never treat eval, preload or
      // application arguments containing this path as a running backend.
      const scriptIndex =
        args.length === 2
          ? 1
          : args.length === armv6ServerArgs.length + 2 &&
            armv6ServerArgs.every((flag, i) => args[i + 1] === flag)
          ? args.length - 1
          : -1;
      if (scriptIndex < 0 || !/^node(?:\d+)?$/.test(path.basename(args[0]!)))
        continue;
      const script = args[scriptIndex]!;
      if (!script) continue;
      const absolute = path.isAbsolute(script)
        ? script
        : path.resolve(await fs.realpath(path.join(directory, 'cwd')), script);
      if ((await fs.realpath(absolute)) === expected) matches.push(pid);
    } catch (error) {
      // Processes may exit while enumerating; foreign users can deny inspection.
      if (
        !['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
  }
  return matches;
}
