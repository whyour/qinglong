import fs from 'fs/promises';
import { createHash } from 'crypto';

export const DEFAULT_LOG_CHUNK_BYTES = 256 * 1024;
export const MAX_LOG_CHUNK_BYTES = 1024 * 1024;

// The viewer retains at most one Mi UTF-16 code units.
const CURSOR_WINDOW_BYTES = 4 * MAX_LOG_CHUNK_BYTES;

export interface LogReadOptions {
  offset?: number;
  limit?: number;
  tail?: boolean;
  follow?: boolean;
  cursor?: string;
}

export interface LogChunk {
  content: string;
  offset: number;
  nextOffset: number;
  total: number;
  truncated: boolean;
  cursor?: string;
  reset?: boolean;
}

function normalizeLimit(limit?: number) {
  if (!Number.isFinite(limit)) return DEFAULT_LOG_CHUNK_BYTES;
  return Math.min(Math.max(Math.trunc(limit!), 4), MAX_LOG_CHUNK_BYTES);
}

function isUtf8ContinuationByte(byte: number) {
  return (byte & 0xc0) === 0x80;
}

function completeUtf8End(buffer: Buffer, start: number, end: number) {
  if (end <= start) return start;

  let sequenceStart = end - 1;
  while (
    sequenceStart > start &&
    isUtf8ContinuationByte(buffer[sequenceStart])
  ) {
    sequenceStart--;
  }

  const firstByte = buffer[sequenceStart];
  const expectedLength =
    firstByte < 0x80
      ? 1
      : firstByte < 0xe0
        ? 2
        : firstByte < 0xf0
          ? 3
          : 4;
  return end - sequenceStart < expectedLength ? sequenceStart : end;
}

function logDigest(identity: string, from: number, bytes: Buffer) {
  return createHash('sha256').update(`${identity}:${from}:`).update(bytes).digest('hex');
}

export async function readLogChunk(
  filePath: string,
  options: LogReadOptions = {},
): Promise<LogChunk> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat({ bigint: true });
    const total = Number(stat.size);
    const identity = `${stat.dev}:${stat.ino}`;
    const limit = normalizeLimit(options.limit);
    const requestedOffset = Number.isFinite(options.offset)
      ? Math.max(0, Math.trunc(options.offset!))
      : undefined;
    let start = options.tail || requestedOffset === undefined
      ? Math.max(total - limit, 0)
      : Math.min(requestedOffset, total);
    const resume = options.cursor && !options.tail && requestedOffset !== undefined;
    const [fromText, digest] = resume ? options.cursor!.split('.') : [];
    let from = resume ? Number(fromText) : start;
    let reset = Boolean(resume && (
      requestedOffset !== start || !Number.isSafeInteger(from) ||
      from < 0 || from > start || start - from > CURSOR_WINDOW_BYTES
    ));
    if (reset) from = start = 0;

    // Read the previously displayed bytes and their continuation together.
    // A truncate followed by regrowth can leave both size and inode unchanged.
    const readWindow = async (position: number, end: number) => {
      const data = Buffer.allocUnsafe(Math.min(end, total) - position);
      const { bytesRead } = await handle!.read(data, 0, data.length, position);
      return data.subarray(0, bytesRead);
    };
    let window = await readWindow(from, start + limit + 3);
    if (resume && !reset) {
      const prefix = window.subarray(0, start - from);
      if (prefix.length !== start - from || logDigest(identity, from, prefix) !== digest) {
        reset = true;
        start = from = 0;
        window = await readWindow(0, limit + 3);
      }
    }
    const buffer = window.subarray(start - from);
    const bytesRead = buffer.length;
    let leadingBytes = 0;
    while (
      leadingBytes < bytesRead &&
      isUtf8ContinuationByte(buffer[leadingBytes])
    ) {
      leadingBytes++;
    }
    const offset = start + leadingBytes;
    const candidateEnd = Math.min(leadingBytes + limit, bytesRead);
    const contentEnd = completeUtf8End(buffer, leadingBytes, candidateEnd);
    const nextOffset = start + contentEnd;

    let cursor: string | undefined;
    if (options.follow || options.cursor) {
      const retainedFrom = Math.max(from, nextOffset - CURSOR_WINDOW_BYTES);
      cursor = resume && !reset && nextOffset === start ? options.cursor :
        `${retainedFrom}.${logDigest(identity, retainedFrom, window.subarray(retainedFrom - from, nextOffset - from))}`;
    }

    return {
      ...(cursor && { cursor, reset }),
      content: buffer.subarray(leadingBytes, contentEnd).toString('utf8'),
      offset,
      nextOffset,
      total,
      truncated: offset > 0 || nextOffset < total,
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {
        content: '',
        offset: 0,
        nextOffset: 0,
        total: 0,
        truncated: false,
      };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
