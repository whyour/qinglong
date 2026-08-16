import fs from 'fs/promises';

export const DEFAULT_LOG_CHUNK_BYTES = 256 * 1024;
export const MAX_LOG_CHUNK_BYTES = 1024 * 1024;

export interface LogReadOptions {
  offset?: number;
  limit?: number;
  tail?: boolean;
}

export interface LogChunk {
  content: string;
  offset: number;
  nextOffset: number;
  total: number;
  truncated: boolean;
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

export async function readLogChunk(
  filePath: string,
  options: LogReadOptions = {},
): Promise<LogChunk> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const { size: total } = await handle.stat();
    const limit = normalizeLimit(options.limit);
    const requestedOffset = Number.isFinite(options.offset)
      ? Math.trunc(options.offset!)
      : undefined;
    const requestedStart =
      options.tail || requestedOffset === undefined
        ? Math.max(total - limit, 0)
        : Math.min(Math.max(requestedOffset, 0), total);
    const length = Math.min(limit + 3, total - requestedStart);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      length,
      requestedStart,
    );
    let leadingBytes = 0;
    while (
      leadingBytes < bytesRead &&
      isUtf8ContinuationByte(buffer[leadingBytes])
    ) {
      leadingBytes++;
    }
    const offset = requestedStart + leadingBytes;
    const candidateEnd = Math.min(leadingBytes + limit, bytesRead);
    const contentEnd = completeUtf8End(buffer, leadingBytes, candidateEnd);
    const nextOffset = requestedStart + contentEnd;

    return {
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
