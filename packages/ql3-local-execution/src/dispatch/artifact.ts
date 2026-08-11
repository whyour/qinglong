import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LocalDispatchCandidate } from '@qinglong/runtime-core/local-dispatch';
import { normalizeLocalDispatchCandidate } from '@qinglong/runtime-core/local-dispatch';

export const MIN_LOCAL_ARTIFACT_MAXIMUM_BYTES = 64 * 1024;
export const MAX_LOCAL_ARTIFACT_MAXIMUM_BYTES = 1024 * 1024 * 1024;
export const MAX_LOCAL_ARTIFACT_MINIMUM_FREE_BYTES = 1024 ** 4;

export interface LocalArtifactCapacityPolicy {
  readonly maximumAttemptBytes: number;
  readonly minimumFreeBytes: number;
}

export interface LocalArtifactCapacityProbe {
  inspect(directory: string): Promise<bigint>;
}

export interface PreparedLocalArtifact {
  readonly logArtifactId: string;
  readonly output: Readonly<{
    filePath: string;
    maximumBytes: number;
    logArtifactId: string;
  }>;
}

export interface LocalArtifactAllocator {
  prepare(candidate: LocalDispatchCandidate): Promise<PreparedLocalArtifact>;
}

export class LocalArtifactCapacityUnavailableError extends Error {
  readonly code = 'LOCAL_ARTIFACT_CAPACITY_UNAVAILABLE';

  constructor() {
    super('Local Artifact capacity is unavailable');
    this.name = 'LocalArtifactCapacityUnavailableError';
  }
}

export class LocalArtifactIdentityConflictError extends Error {
  readonly code = 'LOCAL_ARTIFACT_IDENTITY_CONFLICT';

  constructor() {
    super('Local Artifact identity is already occupied');
    this.name = 'LocalArtifactIdentityConflictError';
  }
}

class StatFsLocalArtifactCapacityProbe implements LocalArtifactCapacityProbe {
  async inspect(directory: string): Promise<bigint> {
    const stat = await fs.statfs(directory, { bigint: true });
    return stat.bavail * stat.bsize;
  }
}

function assertAbsoluteRoot(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    throw new TypeError('Local Artifact root is invalid');
  }
  return path.resolve(value);
}

function normalizePolicy(
  policy: LocalArtifactCapacityPolicy,
): Readonly<LocalArtifactCapacityPolicy> {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('Local Artifact capacity policy is invalid');
  }
  if (
    !Number.isSafeInteger(policy.maximumAttemptBytes) ||
    policy.maximumAttemptBytes < MIN_LOCAL_ARTIFACT_MAXIMUM_BYTES ||
    policy.maximumAttemptBytes > MAX_LOCAL_ARTIFACT_MAXIMUM_BYTES ||
    !Number.isSafeInteger(policy.minimumFreeBytes) ||
    policy.minimumFreeBytes < 0 ||
    policy.minimumFreeBytes > MAX_LOCAL_ARTIFACT_MINIMUM_FREE_BYTES
  ) {
    throw new RangeError('Local Artifact capacity policy is out of range');
  }
  return Object.freeze({ ...policy });
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError('Local Artifact directory is unsafe');
  }
  await fs.chmod(directory, 0o700);
}

export function localArtifactCapacityPolicyForProfile(
  profile: 'edge' | 'standalone',
): Readonly<LocalArtifactCapacityPolicy> {
  if (profile === 'edge') {
    return Object.freeze({
      maximumAttemptBytes: 4 * 1024 * 1024,
      minimumFreeBytes: 32 * 1024 * 1024,
    });
  }
  if (profile === 'standalone') {
    return Object.freeze({
      maximumAttemptBytes: 64 * 1024 * 1024,
      minimumFreeBytes: 256 * 1024 * 1024,
    });
  }
  throw new TypeError('Local Artifact Profile is invalid');
}

export function localArtifactId(candidate: LocalDispatchCandidate): string {
  const normalized = normalizeLocalDispatchCandidate(candidate);
  return `local-${createHash('sha256')
    .update(normalized.runId, 'utf8')
    .update('\0', 'utf8')
    .update(normalized.attemptId, 'utf8')
    .digest('hex')
    .slice(0, 30)}`;
}

export class LocalFileArtifactAllocator implements LocalArtifactAllocator {
  private readonly root: string;
  private readonly policy: Readonly<LocalArtifactCapacityPolicy>;

  constructor(
    root: string,
    policy: LocalArtifactCapacityPolicy,
    private readonly capacity: LocalArtifactCapacityProbe = new StatFsLocalArtifactCapacityProbe(),
  ) {
    this.root = assertAbsoluteRoot(root);
    this.policy = normalizePolicy(policy);
  }

  async prepare(
    candidate: LocalDispatchCandidate,
  ): Promise<PreparedLocalArtifact> {
    const normalized = normalizeLocalDispatchCandidate(candidate);
    const logArtifactId = localArtifactId(normalized);
    const shard = logArtifactId.slice(6, 8);
    const directory = path.join(this.root, shard);
    await ensurePrivateDirectory(this.root);
    const availableBytes = await this.capacity.inspect(this.root);
    const requiredBytes =
      BigInt(this.policy.minimumFreeBytes) +
      BigInt(this.policy.maximumAttemptBytes);
    if (availableBytes < requiredBytes) {
      throw new LocalArtifactCapacityUnavailableError();
    }
    await ensurePrivateDirectory(directory);
    const filePath = path.join(directory, `${logArtifactId}.log`);
    let file: fs.FileHandle | undefined;
    try {
      file = await fs.open(
        filePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== 0) {
        throw new LocalArtifactIdentityConflictError();
      }
      await file.chmod(0o600);
    } finally {
      await file?.close().catch(() => undefined);
    }
    return Object.freeze({
      logArtifactId,
      output: Object.freeze({
        filePath,
        maximumBytes: this.policy.maximumAttemptBytes,
        logArtifactId,
      }),
    });
  }
}
