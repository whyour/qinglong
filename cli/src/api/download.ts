import { open, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { resolve } from 'node:path';

// Never overwrite an existing file; remove only a file created by this call.
export async function saveResponse(
  response: Response,
  output: string,
): Promise<Record<string, unknown>> {
  const path = resolve(output);
  const handle = await open(path, 'wx', 0o600);
  try {
    if (!response.body) throw new Error('Missing response body');
    const stream = handle.createWriteStream();
    await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), stream);
    return { code: 200, data: { path, bytes: stream.bytesWritten } };
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}
