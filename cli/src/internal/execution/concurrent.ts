import fs from 'node:fs/promises';
import { createReadStream, writeSync } from 'node:fs';
import path from 'node:path';

// Preserve legacy account-order output while all account processes run concurrently.
// Spool to private files instead of retaining output buffers in the parent process.
export async function orderedConcurrent<T>(
  root: string,
  accounts: number[],
  invoke: (account: number, output: (chunk: Buffer) => void) => Promise<T>,
  output: (chunk: Buffer) => void,
): Promise<T[]> {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, '.concurrent-'));
  try {
    const results = await Promise.allSettled(
      accounts.map(async (account, index) => {
        const file = await fs.open(
          path.join(directory, `${index}.log`),
          'wx',
          0o600,
        );
        try {
          return await invoke(account, (chunk) => {
            let offset = 0;
            while (offset < chunk.length)
              offset += writeSync(file.fd, chunk, offset);
          });
        } finally {
          await file.close();
        }
      }),
    );
    // Wait for every writer even if one child could not start, then preserve its
    // peers' diagnostics before surfacing that failure.
    for (let index = 0; index < accounts.length; index++) {
      const filename = path.join(directory, `${index}.log`);
      if (!(await fs.stat(filename).catch(() => undefined))) continue;
      for await (const chunk of createReadStream(filename))
        output(chunk as Buffer);
    }
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return results.map((result) => (result as PromiseFulfilledResult<T>).value);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
