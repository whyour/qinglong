// Worker Execution owns bounded local log allocation, output, and read leases.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { assertRunDispatchId } from '@qinglong/runtime-core/run-dispatch-lease';
import type {
  WorkerRemoteExecutionOutputChunk,
  WorkerRemoteExecutionOutputSink,
} from '../remote-execution/executionInboxProcessor';
import type {
  WorkerRemoteLogArtifactAllocator,
  WorkerRemoteLogArtifactPreparation,
} from '../remote-execution/executionContextMaterializer';

const MEBIBYTE = 1024 * 1024;
const MAXIMUM_POLICY_BYTES = 1024 * MEBIBYTE;
const MAXIMUM_RESERVE_BYTES = 1024 * 1024 * MEBIBYTE;
const ARTIFACT_ID_PREFIX = 'wlog-';
const ARTIFACT_ID_DIGEST_LENGTH = 30;
const ARTIFACT_ID_DOMAIN = 'qinglong/worker-log-artifact@v1';
const WORKER_FILE_LOG_OUTPUT_PLAN = Symbol('worker-file-log-output-plan');

export type WorkerRemoteLogArtifactProfile = 'edge' | 'node';

export interface WorkerRemoteLogArtifactPolicy {
  readonly maximumAttemptBytes: number;
  readonly minimumFreeBytes: number;
  readonly maximumWriteChunkBytes: number;
}

export interface WorkerRemoteLogArtifactCapacityProbe {
  availableBytes(root: string): Promise<bigint>;
}

export interface WorkerFileLogArtifactAllocatorOptions {
  readonly root: string;
  readonly policy: WorkerRemoteLogArtifactPolicy;
  readonly capacity?: WorkerRemoteLogArtifactCapacityProbe;
}

export interface WorkerFileLogOutputPlan {
  readonly filePath: string;
  readonly maximumBytes: number;
  readonly logArtifactId: string;
}

export interface WorkerRemoteLogArtifactReadRequest {
  readonly runId: string;
  readonly attemptId: string;
  readonly logArtifactId: string;
}

export interface WorkerRemoteLogArtifactReadLease {
  readonly logArtifactId: string;
  readonly byteLength: number;
  /** Undefined means the launcher's bounded truncation fact was unavailable. */
  readonly truncated: boolean | undefined;
  chunks(): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

export interface WorkerRemoteLogArtifactSource {
  open(
    request: WorkerRemoteLogArtifactReadRequest,
  ): Promise<WorkerRemoteLogArtifactReadLease | undefined>;
}

type PlannedWorkerRemoteExecutionOutputSink = WorkerRemoteExecutionOutputSink & {
  readonly [WORKER_FILE_LOG_OUTPUT_PLAN]?: () => WorkerFileLogOutputPlan;
};

/** Adapter-private path capability; it is non-enumerable on the output sink. */
export function workerFileLogOutputPlan(
  output: WorkerRemoteExecutionOutputSink,
): Readonly<WorkerFileLogOutputPlan> | undefined {
  return (output as PlannedWorkerRemoteExecutionOutputSink)[
    WORKER_FILE_LOG_OUTPUT_PLAN
  ]?.();
}

export class WorkerRemoteLogArtifactError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'invalid_request'
      | 'capacity_unavailable'
      | 'unsafe_path'
      | 'quota_exceeded'
      | 'invalid_output'
      | 'closed',
  ) {
    super(`Worker remote log Artifact failed: ${reason}`);
    this.name = 'WorkerRemoteLogArtifactError';
  }
}

export function workerRemoteLogArtifactPolicy(
  profile: WorkerRemoteLogArtifactProfile,
): Readonly<WorkerRemoteLogArtifactPolicy> {
  if (profile === 'edge') {
    return Object.freeze({
      maximumAttemptBytes: 4 * MEBIBYTE,
      minimumFreeBytes: 32 * MEBIBYTE,
      maximumWriteChunkBytes: MEBIBYTE,
    });
  }
  if (profile === 'node') {
    return Object.freeze({
      maximumAttemptBytes: 64 * MEBIBYTE,
      minimumFreeBytes: 256 * MEBIBYTE,
      maximumWriteChunkBytes: MEBIBYTE,
    });
  }
  throw new WorkerRemoteLogArtifactError('invalid_configuration');
}

function normalizePolicy(
  policy: WorkerRemoteLogArtifactPolicy,
): Readonly<WorkerRemoteLogArtifactPolicy> {
  if (
    !policy ||
    !Number.isSafeInteger(policy.maximumAttemptBytes) ||
    policy.maximumAttemptBytes < 1 ||
    policy.maximumAttemptBytes > MAXIMUM_POLICY_BYTES ||
    !Number.isSafeInteger(policy.minimumFreeBytes) ||
    policy.minimumFreeBytes < 0 ||
    policy.minimumFreeBytes > MAXIMUM_RESERVE_BYTES ||
    !Number.isSafeInteger(policy.maximumWriteChunkBytes) ||
    policy.maximumWriteChunkBytes < 1 ||
    policy.maximumWriteChunkBytes > MEBIBYTE
  ) {
    throw new WorkerRemoteLogArtifactError('invalid_configuration');
  }
  return Object.freeze({
    maximumAttemptBytes: policy.maximumAttemptBytes,
    minimumFreeBytes: policy.minimumFreeBytes,
    maximumWriteChunkBytes: policy.maximumWriteChunkBytes,
  });
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function assertOwnedOrdinaryFile(stat: Awaited<ReturnType<FileHandle['stat']>>): void {
  const uid = currentUid();
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    throw new WorkerRemoteLogArtifactError('unsafe_path');
  }
}

async function privateDirectory(directory: string): Promise<Readonly<{
  dev: number;
  ino: number;
}>> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const before = await fs.lstat(directory);
  const uid = currentUid();
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    (uid !== undefined && before.uid !== uid)
  ) {
    throw new WorkerRemoteLogArtifactError('unsafe_path');
  }
  await fs.chmod(directory, 0o700);
  const after = await fs.lstat(directory);
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    (after.mode & 0o777) !== 0o700 ||
    (uid !== undefined && after.uid !== uid)
  ) {
    throw new WorkerRemoteLogArtifactError('unsafe_path');
  }
  return Object.freeze({ dev: after.dev, ino: after.ino });
}

function requestId(name: string, value: unknown): string {
  try {
    if (typeof value !== 'string') {
      throw new TypeError('invalid ID');
    }
    assertRunDispatchId(name, value);
    return value;
  } catch {
    throw new WorkerRemoteLogArtifactError('invalid_request');
  }
}

export function createWorkerRemoteLogArtifactId(request: Readonly<{
  projectId: string;
  runId: string;
  attemptId: string;
  offerId: string;
}>): string {
  if (!request || typeof request !== 'object') {
    throw new WorkerRemoteLogArtifactError('invalid_request');
  }
  const values = [
    requestId('projectId', request.projectId),
    requestId('runId', request.runId),
    requestId('attemptId', request.attemptId),
    requestId('offerId', request.offerId),
  ];
  const digest = createHash('sha256');
  digest.update(ARTIFACT_ID_DOMAIN, 'utf8');
  for (const value of values) {
    digest.update('\0', 'utf8');
    digest.update(value, 'utf8');
  }
  const artifactId = `${ARTIFACT_ID_PREFIX}${digest.digest('hex').slice(
    0,
    ARTIFACT_ID_DIGEST_LENGTH,
  )}`;
  assertRunDispatchId('logArtifactId', artifactId);
  return artifactId;
}

class FileSystemCapacityProbe implements WorkerRemoteLogArtifactCapacityProbe {
  async availableBytes(root: string): Promise<bigint> {
    const stat = await fs.statfs(root, { bigint: true });
    return stat.bavail * stat.bsize;
  }
}

class WorkerFileLogOutput implements WorkerRemoteExecutionOutputSink {
  private pending: Promise<unknown> = Promise.resolve();
  private closeOperation: Promise<void> | undefined;
  private state: 'open' | 'closing' | 'closed' = 'open';
  private remainingBytes: number;

  constructor(
    readonly logArtifactId: string,
    private readonly file: FileHandle,
    maximumBytes: number,
    existingBytes: number,
    private readonly maximumWriteChunkBytes: number,
    outputFilePath: string,
  ) {
    this.remainingBytes = maximumBytes - existingBytes;
    Object.defineProperty(this, WORKER_FILE_LOG_OUTPUT_PLAN, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: () => Object.freeze({
        filePath: outputFilePath,
        maximumBytes,
        logArtifactId,
      }),
    });
  }

  write(output: WorkerRemoteExecutionOutputChunk): Promise<void> {
    if (this.state !== 'open') {
      return Promise.reject(new WorkerRemoteLogArtifactError('closed'));
    }
    if (
      !output ||
      typeof output !== 'object' ||
      (output.stream !== 'stdout' && output.stream !== 'stderr') ||
      !(output.chunk instanceof Uint8Array) ||
      output.chunk.byteLength > this.maximumWriteChunkBytes ||
      !Number.isSafeInteger(output.observedAtMs) ||
      output.observedAtMs < 0
    ) {
      return Promise.reject(new WorkerRemoteLogArtifactError('invalid_output'));
    }
    const chunk = Buffer.from(output.chunk);
    const operation = this.pending.then(async () => {
      if (chunk.byteLength === 0) return;
      if (this.remainingBytes <= 0) {
        throw new WorkerRemoteLogArtifactError('quota_exceeded');
      }
      const accepted = chunk.subarray(
        0,
        Math.min(chunk.byteLength, this.remainingBytes),
      );
      let offset = 0;
      while (offset < accepted.byteLength) {
        const result = await this.file.write(accepted.subarray(offset));
        if (result.bytesWritten < 1) {
          throw new Error('Worker remote log Artifact write made no progress');
        }
        offset += result.bytesWritten;
        this.remainingBytes -= result.bytesWritten;
      }
      if (accepted.byteLength !== chunk.byteLength) {
        throw new WorkerRemoteLogArtifactError('quota_exceeded');
      }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.state = 'closing';
    this.closeOperation = (async () => {
      await this.pending.catch(() => undefined);
      let syncError: unknown;
      try {
        await this.file.datasync();
      } catch (error) {
        syncError = error;
      }
      try {
        await this.file.close();
      } finally {
        this.state = 'closed';
      }
      if (syncError !== undefined) throw syncError;
    })();
    return this.closeOperation;
  }
}

class WorkerFileLogReadLease implements WorkerRemoteLogArtifactReadLease {
  private consumed = false;
  private closeOperation: Promise<void> | undefined;

  constructor(
    readonly logArtifactId: string,
    readonly byteLength: number,
    readonly truncated: boolean | undefined,
    private readonly file: FileHandle,
    private readonly chunkBytes: number,
  ) {}

  chunks(): AsyncIterable<Uint8Array> {
    if (this.consumed) {
      throw new WorkerRemoteLogArtifactError('closed');
    }
    this.consumed = true;
    const file = this.file;
    const byteLength = this.byteLength;
    const chunkBytes = this.chunkBytes;
    const close = () => this.close();
    return (async function* () {
      let offset = 0;
      try {
        while (offset < byteLength) {
          const buffer = Buffer.allocUnsafe(
            Math.min(chunkBytes, byteLength - offset),
          );
          const result = await file.read(buffer, 0, buffer.length, offset);
          if (result.bytesRead < 1) {
            throw new WorkerRemoteLogArtifactError('invalid_output');
          }
          offset += result.bytesRead;
          yield Buffer.from(buffer.subarray(0, result.bytesRead));
        }
      } finally {
        await close();
      }
    })();
  }

  close(): Promise<void> {
    this.closeOperation ??= this.file.close();
    return this.closeOperation;
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function readTruncationFact(
  directory: string,
  request: WorkerRemoteLogArtifactReadRequest,
  maximumBytes: number,
): Promise<boolean | undefined> {
  const target = path.join(
    directory,
    `.${request.logArtifactId}.log.truncated.json`,
  );
  let file: FileHandle;
  try {
    file = await fs.open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined;
    if (isCode(error, 'ELOOP')) {
      throw new WorkerRemoteLogArtifactError('unsafe_path');
    }
    throw error;
  }
  try {
    const stat = await file.stat();
    assertOwnedOrdinaryFile(stat);
    if (stat.size < 1 || stat.size > 4096 || (stat.mode & 0o777) !== 0o600) {
      throw new WorkerRemoteLogArtifactError('invalid_output');
    }
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== stat.size) {
      throw new WorkerRemoteLogArtifactError('invalid_output');
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8'));
    } catch {
      throw new WorkerRemoteLogArtifactError('invalid_output');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new WorkerRemoteLogArtifactError('invalid_output');
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      JSON.stringify(keys) !== JSON.stringify([
        'attemptId', 'logArtifactId', 'maximumBytes', 'observedAtMs',
        'quotaReached', 'runId', 'schemaVersion',
      ]) ||
      record.schemaVersion !== 1 ||
      record.runId !== request.runId ||
      record.attemptId !== request.attemptId ||
      record.logArtifactId !== request.logArtifactId ||
      record.maximumBytes !== maximumBytes ||
      typeof record.quotaReached !== 'boolean' ||
      !Number.isSafeInteger(record.observedAtMs) ||
      (record.observedAtMs as number) < 0
    ) {
      throw new WorkerRemoteLogArtifactError('invalid_output');
    }
    return record.quotaReached;
  } finally {
    await file.close();
  }
}

export class WorkerFileLogArtifactAllocator
  implements WorkerRemoteLogArtifactAllocator, WorkerRemoteLogArtifactSource {
  private readonly root: string;
  private readonly policy: Readonly<WorkerRemoteLogArtifactPolicy>;
  private readonly capacity: WorkerRemoteLogArtifactCapacityProbe;

  constructor(options: WorkerFileLogArtifactAllocatorOptions) {
    if (
      !options ||
      typeof options.root !== 'string' ||
      !path.isAbsolute(options.root) ||
      options.root.includes('\0') ||
      (options.capacity !== undefined &&
        typeof options.capacity.availableBytes !== 'function')
    ) {
      throw new WorkerRemoteLogArtifactError('invalid_configuration');
    }
    this.root = path.resolve(options.root);
    this.policy = normalizePolicy(options.policy);
    this.capacity = options.capacity ?? new FileSystemCapacityProbe();
  }

  async prepare(request: Readonly<{
    projectId: string;
    runId: string;
    attemptId: string;
    offerId: string;
  }>): Promise<WorkerRemoteLogArtifactPreparation> {
    const logArtifactId = createWorkerRemoteLogArtifactId(request);
    const rootIdentity = await privateDirectory(this.root);
    let availableBytes: bigint;
    try {
      availableBytes = await this.capacity.availableBytes(this.root);
    } catch {
      throw new WorkerRemoteLogArtifactError('capacity_unavailable');
    }
    if (typeof availableBytes !== 'bigint' || availableBytes < 0n) {
      throw new WorkerRemoteLogArtifactError('capacity_unavailable');
    }
    const requiredBytes = BigInt(this.policy.minimumFreeBytes) +
      BigInt(this.policy.maximumAttemptBytes);
    if (availableBytes < requiredBytes) {
      throw new WorkerRemoteLogArtifactError('capacity_unavailable');
    }
    const rootAfterCapacity = await fs.lstat(this.root);
    if (
      rootAfterCapacity.dev !== rootIdentity.dev ||
      rootAfterCapacity.ino !== rootIdentity.ino
    ) {
      throw new WorkerRemoteLogArtifactError('unsafe_path');
    }
    const shard = logArtifactId.slice(
      ARTIFACT_ID_PREFIX.length,
      ARTIFACT_ID_PREFIX.length + 2,
    );
    const directory = path.join(this.root, shard);
    const directoryIdentity = await privateDirectory(directory);
    const outputFilePath = path.join(directory, `${logArtifactId}.log`);
    let file: FileHandle;
    try {
      file = await fs.open(
        outputFilePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ELOOP') {
        throw new WorkerRemoteLogArtifactError('unsafe_path');
      }
      throw error;
    }
    try {
      const stat = await file.stat();
      assertOwnedOrdinaryFile(stat);
      if (
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size > this.policy.maximumAttemptBytes
      ) {
        throw new WorkerRemoteLogArtifactError('quota_exceeded');
      }
      await file.chmod(0o600);
      const pathStat = await fs.lstat(outputFilePath);
      const directoryAfterOpen = await fs.lstat(directory);
      if (
        pathStat.isSymbolicLink() ||
        pathStat.dev !== stat.dev ||
        pathStat.ino !== stat.ino ||
        (pathStat.mode & 0o777) !== 0o600 ||
        directoryAfterOpen.dev !== directoryIdentity.dev ||
        directoryAfterOpen.ino !== directoryIdentity.ino
      ) {
        throw new WorkerRemoteLogArtifactError('unsafe_path');
      }
      const output = new WorkerFileLogOutput(
        logArtifactId,
        file,
        this.policy.maximumAttemptBytes,
        stat.size,
        this.policy.maximumWriteChunkBytes,
        outputFilePath,
      );
      let ownership: 'prepared' | 'handed_off' | 'released' = 'prepared';
      return Object.freeze({
        logArtifactId,
        takeOutput() {
          if (ownership !== 'prepared') {
            throw new WorkerRemoteLogArtifactError('closed');
          }
          ownership = 'handed_off';
          return output;
        },
        async release() {
          if (ownership === 'released' || ownership === 'handed_off') return;
          ownership = 'released';
          await output.close();
        },
      });
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }

  async open(
    request: WorkerRemoteLogArtifactReadRequest,
  ): Promise<WorkerRemoteLogArtifactReadLease | undefined> {
    const runId = requestId('runId', request?.runId);
    const attemptId = requestId('attemptId', request?.attemptId);
    const logArtifactId = requestId('logArtifactId', request?.logArtifactId);
    if (!/^wlog-[0-9a-f]{30}$/.test(logArtifactId)) {
      throw new WorkerRemoteLogArtifactError('invalid_request');
    }
    const rootIdentity = await privateDirectory(this.root);
    const directory = path.join(this.root, logArtifactId.slice(5, 7));
    const directoryIdentity = await privateDirectory(directory);
    const target = path.join(directory, `${logArtifactId}.log`);
    let file: FileHandle;
    try {
      file = await fs.open(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (isCode(error, 'ENOENT')) return undefined;
      if (isCode(error, 'ELOOP')) {
        throw new WorkerRemoteLogArtifactError('unsafe_path');
      }
      throw error;
    }
    try {
      const stat = await file.stat();
      assertOwnedOrdinaryFile(stat);
      if (
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size > this.policy.maximumAttemptBytes ||
        (stat.mode & 0o777) !== 0o600
      ) {
        throw new WorkerRemoteLogArtifactError('invalid_output');
      }
      const pathStat = await fs.lstat(target);
      const rootAfterOpen = await fs.lstat(this.root);
      const directoryAfterOpen = await fs.lstat(directory);
      if (
        pathStat.isSymbolicLink() ||
        pathStat.dev !== stat.dev ||
        pathStat.ino !== stat.ino ||
        rootAfterOpen.dev !== rootIdentity.dev ||
        rootAfterOpen.ino !== rootIdentity.ino ||
        directoryAfterOpen.dev !== directoryIdentity.dev ||
        directoryAfterOpen.ino !== directoryIdentity.ino
      ) {
        throw new WorkerRemoteLogArtifactError('unsafe_path');
      }
      const truncated = await readTruncationFact(
        directory,
        { runId, attemptId, logArtifactId },
        this.policy.maximumAttemptBytes,
      );
      return new WorkerFileLogReadLease(
        logArtifactId,
        stat.size,
        truncated,
        file,
        Math.min(this.policy.maximumWriteChunkBytes, 64 * 1024),
      );
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }
}
