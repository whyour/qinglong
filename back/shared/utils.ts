import { lock } from 'proper-lockfile';
import os from 'os';
import path from 'path';
import { writeFile, open, chmod } from 'fs/promises';
import { fileExist } from '../config/util';

function getUniqueLockPath(filePath: string) {
  const sanitizedPath = filePath
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^_/, '');
  return path.join(os.tmpdir(), `${sanitizedPath}.ql_lock`);
}

export async function writeFileWithLock(
  filePath: string,
  content: string,
  options: Parameters<typeof writeFile>[2] = {},
) {
  if (typeof options === 'string') {
    options = { encoding: options };
  }
  if (!(await fileExist(filePath))) {
    const fileHandle = await open(filePath, 'w');
    fileHandle.close();
  }
  const lockfilePath = getUniqueLockPath(filePath);

  const release = await lock(filePath, {
    retries: {
      retries: 10,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 3000,
    },
    lockfilePath,
  });
  await writeFile(filePath, content, { encoding: 'utf8', ...options });
  if (options?.mode) {
    await chmod(filePath, options.mode);
  }
  await release();
}
