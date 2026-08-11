import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type {
  ExecutionOutputChunk,
  ExecutionOutputSink,
} from '../../domain/execution';
import {
  LocalArtifactCapacityUnavailableError,
  LocalArtifactQuotaExceededError,
  normalizeLocalArtifactCapacityPolicy,
  type LocalArtifactCapacityPolicy,
} from '../../domain/localArtifactCapacity';
import {
  localExecutionArtifactId,
  assertLocalExecutionArtifactId,
} from '../../domain/localExecutionArtifact';
import type { RunDispatchCandidate } from '../../domain/runDispatchCandidate';
import type {
  LocalExecutionArtifactAllocator,
  PreparedLocalExecutionArtifact,
} from '../../ports/localExecutionArtifactAllocator';
import type { LocalArtifactCapacityProbe } from '../../ports/localArtifactCapacityProbe';
import { LocalFileSystemCapacityProbe } from './localFileSystemCapacityProbe';
import { enableDurableLocalProcessOutput } from '../local-process/durableLocalProcessOutput';

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError('Local execution artifact directory is unsafe');
  }
  await fs.chmod(directory, 0o700);
}

class LocalFileExecutionOutput implements ExecutionOutputSink {
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;

  private remainingBytes: number;

  constructor(
    private readonly file: fs.FileHandle,
    maximumBytes: number,
    existingBytes: number,
  ) {
    this.remainingBytes = maximumBytes - existingBytes;
  }

  write(output: ExecutionOutputChunk): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Local execution artifact is closed'));
    }
    const chunk = Buffer.from(output.chunk);
    const operation = this.pending.then(async () => {
      if (this.remainingBytes <= 0) {
        throw new LocalArtifactQuotaExceededError();
      }
      const accepted = chunk.subarray(
        0,
        Math.min(chunk.length, this.remainingBytes),
      );
      let written = 0;
      while (written < accepted.length) {
        const result = await this.file.write(accepted.subarray(written));
        if (result.bytesWritten < 1) {
          throw new Error('Local execution artifact write made no progress');
        }
        written += result.bytesWritten;
        this.remainingBytes -= result.bytesWritten;
      }
      if (accepted.length !== chunk.length) {
        throw new LocalArtifactQuotaExceededError();
      }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pending.catch(() => undefined);
    await this.file.close();
  }
}

export class LocalFileExecutionArtifactAllocator
  implements LocalExecutionArtifactAllocator
{
  private readonly artifactRoot: string;
  private readonly completionReceiptRoot: string;
  private readonly policy: Readonly<LocalArtifactCapacityPolicy>;
  private readonly capacity: LocalArtifactCapacityProbe;

  constructor(
    artifactRoot: string,
    completionReceiptRoot: string,
    policy: LocalArtifactCapacityPolicy,
    capacity: LocalArtifactCapacityProbe = new LocalFileSystemCapacityProbe(),
  ) {
    if (
      !path.isAbsolute(artifactRoot) ||
      artifactRoot.includes('\0') ||
      !path.isAbsolute(completionReceiptRoot) ||
      completionReceiptRoot.includes('\0')
    ) {
      throw new TypeError('Local execution artifact roots must be absolute');
    }
    this.artifactRoot = path.resolve(artifactRoot);
    this.completionReceiptRoot = path.resolve(completionReceiptRoot);
    this.policy = normalizeLocalArtifactCapacityPolicy(policy);
    this.capacity = capacity;
  }

  async prepare(
    candidate: Readonly<RunDispatchCandidate>,
  ): Promise<PreparedLocalExecutionArtifact> {
    const logArtifactId = localExecutionArtifactId(candidate);
    assertLocalExecutionArtifactId(logArtifactId);
    const shard = logArtifactId.slice('local-'.length, 'local-'.length + 2);
    const directory = path.join(this.artifactRoot, shard);
    await privateDirectory(this.artifactRoot);
    const capacity = await this.capacity.inspect(this.artifactRoot);
    const requiredBytes =
      BigInt(this.policy.minimumFreeBytes) +
      BigInt(this.policy.maximumAttemptBytes);
    if (capacity.availableBytes < requiredBytes) {
      throw new LocalArtifactCapacityUnavailableError();
    }
    await privateDirectory(directory);
    await privateDirectory(this.completionReceiptRoot);
    const outputFilePath = path.join(directory, `${logArtifactId}.log`);
    const file = await fs.open(
      outputFilePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        throw new TypeError('Local execution artifact target is unsafe');
      }
      if (
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size > this.policy.maximumAttemptBytes
      ) {
        throw new LocalArtifactQuotaExceededError();
      }
      await file.chmod(0o600);
      const output = new LocalFileExecutionOutput(
        file,
        this.policy.maximumAttemptBytes,
        stat.size,
      );
      return {
        logArtifactId,
        output: enableDurableLocalProcessOutput(output, {
          outputFilePath,
          completionReceiptRoot: this.completionReceiptRoot,
          maximumBytes: this.policy.maximumAttemptBytes,
          logArtifactId,
        }),
        dispose: () => output.close(),
      };
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }
}
