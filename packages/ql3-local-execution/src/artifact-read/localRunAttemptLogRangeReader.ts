import { constants, type Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  normalizeRunAttemptLogReadRange,
  type RunAttemptLogRangeReader,
  type RunAttemptLogRangeReadResult,
  type RunAttemptLogReadIdentity,
  type RunAttemptLogReadRange,
  type RunAttemptLogTruncationView,
} from '@qinglong/runtime-core/run-attempt-log-read';

const LOCAL_ARTIFACT_ID = /^local-[a-f0-9]{30}$/;
const MAXIMUM_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAXIMUM_FACT_BYTES = 1024;

export class LocalRunAttemptLogRangeReadError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'unsafe_path'
      | 'integrity_mismatch',
    options?: ErrorOptions,
  ) {
    super(`Local Run Attempt log range read failed: ${reason}`, options);
    this.name = 'LocalRunAttemptLogRangeReadError';
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function root(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    throw new LocalRunAttemptLogRangeReadError('invalid_configuration');
  }
  return path.resolve(value);
}

function identity(
  value: Readonly<RunAttemptLogReadIdentity>,
): Readonly<RunAttemptLogReadIdentity> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !LOCAL_ARTIFACT_ID.test(value.logArtifactId)
  ) {
    throw new LocalRunAttemptLogRangeReadError('integrity_mismatch');
  }
  return value;
}

function assertOwnedDirectory(stat: Stats): void {
  const uid = currentUid();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    throw new LocalRunAttemptLogRangeReadError('unsafe_path');
  }
}

function assertOwnedFile(stat: Stats): void {
  const uid = currentUid();
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    (uid !== undefined && stat.uid !== uid) ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 0 ||
    stat.size > MAXIMUM_ARTIFACT_BYTES
  ) {
    throw new LocalRunAttemptLogRangeReadError('unsafe_path');
  }
}

async function optionalPrivateDirectory(directory: string): Promise<boolean> {
  try {
    assertOwnedDirectory(await fs.lstat(directory));
    return true;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    if (error instanceof LocalRunAttemptLogRangeReadError) throw error;
    throw new LocalRunAttemptLogRangeReadError('unsafe_path', { cause: error });
  }
}

async function openPrivateFile(
  filePath: string,
): Promise<FileHandle | undefined> {
  try {
    return await fs.open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined;
    throw new LocalRunAttemptLogRangeReadError('unsafe_path', { cause: error });
  }
}

function exactFact(
  value: unknown,
  expected: Readonly<RunAttemptLogReadIdentity>,
): Readonly<RunAttemptLogTruncationView> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalRunAttemptLogRangeReadError('integrity_mismatch');
  }
  const fact = value as Record<string, unknown>;
  const keys = Object.keys(fact).sort();
  if (
    keys.join(',') !==
      'attemptId,logArtifactId,maximumBytes,observedAtMs,quotaReached,runId,schemaVersion' ||
    fact.schemaVersion !== 1 ||
    fact.runId !== expected.runId ||
    fact.attemptId !== expected.attemptId ||
    fact.logArtifactId !== expected.logArtifactId ||
    !Number.isSafeInteger(fact.maximumBytes) ||
    Number(fact.maximumBytes) < 64 * 1024 ||
    Number(fact.maximumBytes) > MAXIMUM_ARTIFACT_BYTES ||
    typeof fact.quotaReached !== 'boolean' ||
    !Number.isSafeInteger(fact.observedAtMs) ||
    Number(fact.observedAtMs) < 0
  ) {
    throw new LocalRunAttemptLogRangeReadError('integrity_mismatch');
  }
  return Object.freeze({
    truncated: fact.quotaReached,
    maximumBytes: fact.maximumBytes as number,
    observedAtMs: fact.observedAtMs as number,
  });
}

async function readTruncationFact(
  directory: string,
  expected: Readonly<RunAttemptLogReadIdentity>,
  signal?: AbortSignal,
): Promise<Readonly<RunAttemptLogTruncationView>> {
  if (signal?.aborted) throw signal.reason;
  const factPath = path.join(
    directory,
    `.${expected.logArtifactId}.log.truncated.json`,
  );
  const handle = await openPrivateFile(factPath);
  if (!handle) return Object.freeze({ truncated: 'unknown' as const });
  try {
    const before = await handle.stat();
    assertOwnedFile(before);
    if (before.size < 2 || before.size > MAXIMUM_FACT_BYTES) {
      throw new LocalRunAttemptLogRangeReadError('integrity_mismatch');
    }
    const content = Buffer.allocUnsafe(before.size);
    let read = 0;
    while (read < content.byteLength) {
      if (signal?.aborted) throw signal.reason;
      const result = await handle.read(
        content,
        read,
        content.byteLength - read,
        read,
      );
      if (result.bytesRead < 1) {
        throw new LocalRunAttemptLogRangeReadError('integrity_mismatch');
      }
      read += result.bytesRead;
    }
    const after = await handle.stat();
    assertOwnedFile(after);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      throw new LocalRunAttemptLogRangeReadError('integrity_mismatch');
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      return exactFact(JSON.parse(text), expected);
    } catch (error) {
      if (error instanceof LocalRunAttemptLogRangeReadError) throw error;
      throw new LocalRunAttemptLogRangeReadError('integrity_mismatch', {
        cause: error,
      });
    } finally {
      content.fill(0);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export class LocalRunAttemptLogRangeReader implements RunAttemptLogRangeReader {
  private readonly root: string;

  constructor(artifactRoot: string) {
    this.root = root(artifactRoot);
  }

  async read(
    rawIdentity: Readonly<RunAttemptLogReadIdentity>,
    rawRange: Readonly<RunAttemptLogReadRange>,
    signal?: AbortSignal,
  ): Promise<RunAttemptLogRangeReadResult> {
    const expected = identity(rawIdentity);
    const range = normalizeRunAttemptLogReadRange(rawRange);
    if (signal?.aborted) throw signal.reason;
    if (!(await optionalPrivateDirectory(this.root))) {
      return Object.freeze({ status: 'missing' as const });
    }
    const directory = path.join(
      this.root,
      expected.logArtifactId.slice('local-'.length, 'local-'.length + 2),
    );
    if (!(await optionalPrivateDirectory(directory))) {
      return Object.freeze({ status: 'missing' as const });
    }
    const target = path.join(directory, `${expected.logArtifactId}.log`);
    const handle = await openPrivateFile(target);
    if (!handle) return Object.freeze({ status: 'missing' as const });
    try {
      const before = await handle.stat();
      assertOwnedFile(before);
      const start = Math.min(range.offset, before.size);
      const expectedBytes = Math.min(range.length, before.size - start);
      const content = Buffer.allocUnsafe(expectedBytes);
      let read = 0;
      while (read < expectedBytes) {
        if (signal?.aborted) throw signal.reason;
        const result = await handle.read(
          content,
          read,
          expectedBytes - read,
          start + read,
        );
        if (result.bytesRead < 1) {
          throw new LocalRunAttemptLogRangeReadError('integrity_mismatch');
        }
        read += result.bytesRead;
      }
      const after = await handle.stat();
      assertOwnedFile(after);
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size < before.size
      ) {
        throw new LocalRunAttemptLogRangeReadError('integrity_mismatch');
      }
      const endExclusive = start + content.byteLength;
      const truncation = await readTruncationFact(directory, expected, signal);
      return Object.freeze({
        status: 'available' as const,
        content,
        start,
        endExclusive,
        totalBytes: before.size,
        ...(endExclusive < before.size ? { nextOffset: endExclusive } : {}),
        truncation,
      });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
