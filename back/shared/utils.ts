import { lock } from 'proper-lockfile';
import { writeFile, open } from 'fs/promises';
import { fileExist } from '../config/util';

export async function writeFileWithLock(
  path: string,
  content: string | Buffer,
  options: Parameters<typeof writeFile>[2] = {},
) {
  if (typeof options === 'string') {
    options = { encoding: options };
  }
  if (!(await fileExist(path))) {
    const fileHandle = await open(path, 'w');
    fileHandle.close();
  }
  const release = await lock(path, {
    retries: {
      retries: 10,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 3000,
    },
  });
  await writeFile(path, content, { encoding: 'utf8', ...options });
  await release();
}
