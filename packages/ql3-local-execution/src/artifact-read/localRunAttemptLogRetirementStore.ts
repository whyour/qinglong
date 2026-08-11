import { constants, type Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  normalizeRunAttemptLogRetentionCandidate,
  type RunAttemptLogCapacitySource,
  type RunAttemptLogRetentionCandidate,
  type RunAttemptLogRetirementStore,
  type RunAttemptLogRetirementStoreResult,
} from '@qinglong/runtime-core/run-attempt-log-retention';
import type {
  RunAttemptLogReadIdentity,
  RunAttemptLogTruncationView,
} from '@qinglong/runtime-core/run-attempt-log-read';

const LOCAL_ARTIFACT_ID = /^local-[a-f0-9]{30}$/;
const MAXIMUM_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAXIMUM_FACT_BYTES = 1024;

export class LocalRunAttemptLogRetirementError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'unsafe_path'
      | 'integrity_mismatch',
    options?: ErrorOptions,
  ) {
    super(`Local Run Attempt log retirement failed: ${reason}`, options);
    this.name = 'LocalRunAttemptLogRetirementError';
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

function artifactRoot(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    throw new LocalRunAttemptLogRetirementError('invalid_configuration');
  }
  return path.resolve(value);
}

function assertOwnedDirectory(stat: Stats): void {
  const uid = currentUid();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    throw new LocalRunAttemptLogRetirementError('unsafe_path');
  }
}

function assertOwnedFile(stat: Stats, maximumBytes: number): void {
  const uid = currentUid();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    (uid !== undefined && stat.uid !== uid) ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 0 ||
    stat.size > maximumBytes
  ) {
    throw new LocalRunAttemptLogRetirementError('unsafe_path');
  }
}

async function optionalOwnedDirectory(directory: string): Promise<boolean> {
  try {
    assertOwnedDirectory(await fs.lstat(directory));
    return true;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    if (error instanceof LocalRunAttemptLogRetirementError) throw error;
    throw new LocalRunAttemptLogRetirementError('unsafe_path', {
      cause: error,
    });
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
    throw new LocalRunAttemptLogRetirementError('unsafe_path', {
      cause: error,
    });
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactFact(
  value: unknown,
  expected: Readonly<RunAttemptLogReadIdentity>,
): Readonly<RunAttemptLogTruncationView> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalRunAttemptLogRetirementError('integrity_mismatch');
  }
  const fact = value as Record<string, unknown>;
  if (
    Object.keys(fact).sort().join(',') !==
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
    throw new LocalRunAttemptLogRetirementError('integrity_mismatch');
  }
  return Object.freeze({
    truncated: fact.quotaReached,
    maximumBytes: fact.maximumBytes as number,
    observedAtMs: fact.observedAtMs as number,
  });
}

async function readFact(
  factPath: string,
  expected: Readonly<RunAttemptLogReadIdentity>,
): Promise<
  Readonly<{
    truncation: Readonly<RunAttemptLogTruncationView>;
    stat?: Stats;
  }>
> {
  const handle = await openPrivateFile(factPath);
  if (!handle) {
    return Object.freeze({
      truncation: Object.freeze({ truncated: 'unknown' as const }),
    });
  }
  try {
    const before = await handle.stat();
    assertOwnedFile(before, MAXIMUM_FACT_BYTES);
    if (before.size < 2) {
      throw new LocalRunAttemptLogRetirementError('integrity_mismatch');
    }
    const content = Buffer.allocUnsafe(before.size);
    try {
      let read = 0;
      while (read < content.byteLength) {
        const result = await handle.read(
          content,
          read,
          content.byteLength - read,
          read,
        );
        if (result.bytesRead < 1) {
          throw new LocalRunAttemptLogRetirementError('integrity_mismatch');
        }
        read += result.bytesRead;
      }
      const after = await handle.stat();
      assertOwnedFile(after, MAXIMUM_FACT_BYTES);
      if (!sameFile(before, after) || before.size !== after.size) {
        throw new LocalRunAttemptLogRetirementError('integrity_mismatch');
      }
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(content);
      return Object.freeze({
        truncation: exactFact(JSON.parse(decoded), expected),
        stat: before,
      });
    } catch (error) {
      if (error instanceof LocalRunAttemptLogRetirementError) throw error;
      throw new LocalRunAttemptLogRetirementError('integrity_mismatch', {
        cause: error,
      });
    } finally {
      content.fill(0);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function assertPathStillMatches(
  filePath: string,
  expected: Stats,
  maximumBytes: number,
): Promise<void> {
  try {
    const current = await fs.lstat(filePath);
    assertOwnedFile(current, maximumBytes);
    if (!sameFile(current, expected)) {
      throw new LocalRunAttemptLogRetirementError('integrity_mismatch');
    }
  } catch (error) {
    if (error instanceof LocalRunAttemptLogRetirementError) throw error;
    throw new LocalRunAttemptLogRetirementError('unsafe_path', {
      cause: error,
    });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export class LocalRunAttemptLogRetirementStore
  implements RunAttemptLogRetirementStore
{
  private readonly root: string;

  constructor(artifactRootPath: string) {
    this.root = artifactRoot(artifactRootPath);
  }

  async retire(
    raw: Readonly<RunAttemptLogRetentionCandidate>,
  ): Promise<Readonly<RunAttemptLogRetirementStoreResult>> {
    const candidate = normalizeRunAttemptLogRetentionCandidate(raw);
    if (
      candidate.executorType !== 'local_process' ||
      !LOCAL_ARTIFACT_ID.test(candidate.logArtifactId)
    ) {
      throw new LocalRunAttemptLogRetirementError('integrity_mismatch');
    }
    if (!(await optionalOwnedDirectory(this.root))) {
      return Object.freeze({
        disposition: 'already_absent' as const,
        byteLength: 0,
        truncation: Object.freeze({ truncated: 'unknown' as const }),
      });
    }
    const directory = path.join(
      this.root,
      candidate.logArtifactId.slice('local-'.length, 'local-'.length + 2),
    );
    if (!(await optionalOwnedDirectory(directory))) {
      return Object.freeze({
        disposition: 'already_absent' as const,
        byteLength: 0,
        truncation: Object.freeze({ truncated: 'unknown' as const }),
      });
    }

    const target = path.join(directory, `${candidate.logArtifactId}.log`);
    const factPath = path.join(
      directory,
      `.${candidate.logArtifactId}.log.truncated.json`,
    );
    const fact = await readFact(factPath, candidate);
    const handle = await openPrivateFile(target);
    if (!handle) {
      if (fact.stat) {
        await assertPathStillMatches(factPath, fact.stat, MAXIMUM_FACT_BYTES);
        await fs.unlink(factPath);
        await syncDirectory(directory);
      }
      return Object.freeze({
        disposition: 'already_absent' as const,
        byteLength: 0,
        truncation: fact.truncation,
      });
    }
    try {
      const before = await handle.stat();
      assertOwnedFile(before, MAXIMUM_ARTIFACT_BYTES);
      await assertPathStillMatches(target, before, MAXIMUM_ARTIFACT_BYTES);
      if (fact.stat) {
        await assertPathStillMatches(factPath, fact.stat, MAXIMUM_FACT_BYTES);
      }
      await fs.unlink(target);
      if (fact.stat) await fs.unlink(factPath);
      await syncDirectory(directory);
      return Object.freeze({
        disposition: 'deleted' as const,
        byteLength: before.size,
        truncation: fact.truncation,
      });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

export class LocalRunAttemptLogCapacityProbe
  implements RunAttemptLogCapacitySource
{
  private readonly root: string;

  constructor(artifactRootPath: string) {
    this.root = artifactRoot(artifactRootPath);
  }

  async inspect() {
    let current = this.root;
    while (true) {
      try {
        const stat = await fs.statfs(current, { bigint: true });
        return Object.freeze({
          availableBytes: stat.bavail * stat.bsize,
          totalBytes: stat.blocks * stat.bsize,
        });
      } catch (error) {
        if (!isCode(error, 'ENOENT')) {
          throw new LocalRunAttemptLogRetirementError('unsafe_path', {
            cause: error,
          });
        }
        const parent = path.dirname(current);
        if (parent === current) {
          throw new LocalRunAttemptLogRetirementError('unsafe_path', {
            cause: error,
          });
        }
        current = parent;
      }
    }
  }
}
