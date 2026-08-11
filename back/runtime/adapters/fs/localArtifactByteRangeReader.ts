import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { normalizeLocalArtifactReadRange } from '../../domain/artifactRead';
import { assertLocalExecutionArtifactId } from '../../domain/localExecutionArtifact';
import type {
  AvailableLocalArtifactByteRange,
  LocalArtifactByteRangeReadResult,
  LocalArtifactByteRangeReader as LocalArtifactByteRangeReaderPort,
} from '../../ports/localArtifactByteRangeReader';

export class UnsafeLocalArtifactReadTargetError extends Error {
  constructor() {
    super('Local Artifact read target is unsafe');
    this.name = 'UnsafeLocalArtifactReadTargetError';
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code
  );
}

export class LocalArtifactByteRangeReader
  implements LocalArtifactByteRangeReaderPort
{
  private readonly root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root) || root.includes('\0')) {
      throw new TypeError('Local Artifact read root must be absolute');
    }
    this.root = path.resolve(root);
  }

  async read(
    logArtifactId: string,
    requestedRange: Parameters<LocalArtifactByteRangeReaderPort['read']>[1],
  ): Promise<LocalArtifactByteRangeReadResult> {
    assertLocalExecutionArtifactId(logArtifactId);
    const range = normalizeLocalArtifactReadRange(requestedRange);
    const directory = path.join(this.root, logArtifactId.slice(6, 8));
    await this.assertDirectory(this.root);
    if (!(await this.optionalDirectory(directory)))
      return { status: 'missing' };
    const target = path.join(directory, `${logArtifactId}.log`);
    let handle;
    try {
      handle = await fs.open(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (isCode(error, 'ENOENT')) return { status: 'missing' };
      throw new UnsafeLocalArtifactReadTargetError();
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
        throw new UnsafeLocalArtifactReadTargetError();
      }
      const start = Math.min(range.offset, stat.size);
      const expected = Math.min(range.length, stat.size - start);
      const content = Buffer.allocUnsafe(expected);
      let read = 0;
      while (read < expected) {
        const result = await handle.read(
          content,
          read,
          expected - read,
          start + read,
        );
        if (result.bytesRead < 1) {
          throw new UnsafeLocalArtifactReadTargetError();
        }
        read += result.bytesRead;
      }
      const endExclusive = start + expected;
      const result: AvailableLocalArtifactByteRange = {
        status: 'available',
        content,
        start,
        endExclusive,
        totalBytes: stat.size,
        ...(endExclusive < stat.size ? { nextOffset: endExclusive } : {}),
      };
      return Object.freeze(result);
    } finally {
      await handle.close();
    }
  }

  private async assertDirectory(value: string): Promise<void> {
    try {
      const stat = await fs.lstat(value);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new UnsafeLocalArtifactReadTargetError();
      }
    } catch (error) {
      if (error instanceof UnsafeLocalArtifactReadTargetError) throw error;
      throw new UnsafeLocalArtifactReadTargetError();
    }
  }

  private async optionalDirectory(value: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(value);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new UnsafeLocalArtifactReadTargetError();
      }
      return true;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false;
      if (error instanceof UnsafeLocalArtifactReadTargetError) throw error;
      throw new UnsafeLocalArtifactReadTargetError();
    }
  }
}
