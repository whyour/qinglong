// Remote execution owns immutable Artifact admission and fenced Worker completion.
import { randomUUID } from 'node:crypto';
import {
  InvalidRemoteWorkerCompletionError,
  MAX_REMOTE_WORKER_ARTIFACT_HEADER_BYTES,
  RemoteWorkerCompletionFenceRejectedError,
  RemoteWorkerCompletionUnavailableError,
  normalizeRemoteWorkerArtifactReceipt,
  normalizeRemoteWorkerCompletionCommand,
  normalizeRemoteWorkerCompletionResult,
  parseRemoteWorkerArtifactUploadHeader,
  type RemoteWorkerArtifactReceipt,
  type RemoteWorkerArtifactUploadAuthorityRepository,
  type RemoteWorkerArtifactUploadCommand,
  type RemoteWorkerCompletionCommand,
  type RemoteWorkerCompletionRepository,
  type RemoteWorkerCompletionResult,
} from '@qinglong/runtime-core/remote-worker-completion';
import type {
  RunAttemptLogRangeReadResult,
  RunAttemptLogReadIdentity,
  RunAttemptLogReadRange,
} from '@qinglong/runtime-core/run-attempt-log-read';

export interface ClusterRemoteWorkerArtifactStorageCommand {
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly logArtifactId: string;
  readonly byteLength: number;
  readonly truncated?: boolean;
}

export interface ClusterRemoteWorkerArtifactLookup {
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly logArtifactId: string;
}

/**
 * Production implementations must be shared by every cluster-control replica
 * and provide immutable, digest-authenticated put-if-absent semantics.
 */
export interface ClusterRemoteWorkerArtifactStore {
  put(
    command: Readonly<ClusterRemoteWorkerArtifactStorageCommand>,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<Readonly<RemoteWorkerArtifactReceipt>>;
  inspect(
    lookup: Readonly<ClusterRemoteWorkerArtifactLookup>,
    signal?: AbortSignal,
  ): Promise<Readonly<RemoteWorkerArtifactReceipt> | undefined>;
  /** Optional during Alpha so upload-only test and alternate stores remain compatible. */
  readLogRange?(
    identity: Readonly<RunAttemptLogReadIdentity>,
    range: Readonly<RunAttemptLogReadRange>,
    signal?: AbortSignal,
  ): Promise<RunAttemptLogRangeReadResult>;
}

export interface ClusterRemoteWorkerArtifactUploadInput {
  readonly workerId: string;
  readonly workerSessionId: string;
  readonly contentLength: number;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface ClusterRemoteWorkerCompletionServiceOptions {
  readonly createEventId?: () => string;
}

class BoundedArtifactStreamReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private pending: Uint8Array | undefined;
  private pendingOffset = 0;

  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly signal?: AbortSignal,
  ) {
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
      throw new InvalidRemoteWorkerCompletionError(
        'Artifact upload stream is invalid',
      );
    }
    this.iterator = source[Symbol.asyncIterator]();
  }

  async readExactly(byteLength: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(byteLength);
    let written = 0;
    try {
      while (written < byteLength) {
        const chunk = await this.nextChunk();
        if (!chunk) {
          throw new InvalidRemoteWorkerCompletionError(
            'Artifact upload stream ended before its header',
          );
        }
        const available = chunk.byteLength - this.pendingOffset;
        const copied = Math.min(available, byteLength - written);
        Buffer.from(
          chunk.buffer,
          chunk.byteOffset + this.pendingOffset,
          copied,
        ).copy(result, written);
        written += copied;
        this.pendingOffset += copied;
        if (this.pendingOffset === chunk.byteLength) {
          this.pending = undefined;
          this.pendingOffset = 0;
        }
      }
      return result;
    } catch (error) {
      result.fill(0);
      throw error;
    }
  }

  content(byteLength: number): Readonly<{
    chunks: AsyncIterable<Uint8Array>;
    isComplete(): boolean;
  }> {
    let complete = false;
    let started = false;
    const self = this;
    const chunks = Object.freeze({
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        if (started) {
          throw new InvalidRemoteWorkerCompletionError(
            'Artifact content can only be consumed once',
          );
        }
        started = true;
        let total = 0;
        while (true) {
          const chunk = await self.nextChunk();
          if (!chunk) break;
          const bytes = chunk.subarray(self.pendingOffset);
          self.pending = undefined;
          self.pendingOffset = 0;
          total += bytes.byteLength;
          if (total > byteLength) {
            throw new InvalidRemoteWorkerCompletionError(
              'Artifact content exceeds its declared length',
            );
          }
          yield bytes;
        }
        if (total !== byteLength) {
          throw new InvalidRemoteWorkerCompletionError(
            'Artifact content does not match its declared length',
          );
        }
        complete = true;
      },
    });
    return Object.freeze({ chunks, isComplete: () => complete });
  }

  private async nextChunk(): Promise<Uint8Array | undefined> {
    if (this.signal?.aborted) throw this.signal.reason;
    if (this.pending) return this.pending;
    const next = await this.iterator.next();
    if (next.done) return undefined;
    if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
      throw new InvalidRemoteWorkerCompletionError(
        'Artifact upload chunk is invalid',
      );
    }
    this.pending = next.value;
    this.pendingOffset = 0;
    return this.pending;
  }
}

function storageCommand(
  command: RemoteWorkerArtifactUploadCommand,
): Readonly<ClusterRemoteWorkerArtifactStorageCommand> {
  return Object.freeze({
    projectId: command.projectId,
    runId: command.runId,
    attemptId: command.attemptId,
    logArtifactId: command.logArtifactId,
    byteLength: command.byteLength,
    ...(command.truncated === undefined
      ? {}
      : { truncated: command.truncated }),
  });
}

function assertReceiptMatches(
  command: ClusterRemoteWorkerArtifactStorageCommand,
  value: RemoteWorkerArtifactReceipt,
): Readonly<RemoteWorkerArtifactReceipt> {
  const receipt = normalizeRemoteWorkerArtifactReceipt(value);
  if (
    receipt.projectId !== command.projectId ||
    receipt.runId !== command.runId ||
    receipt.attemptId !== command.attemptId ||
    receipt.logArtifactId !== command.logArtifactId ||
    receipt.byteLength !== command.byteLength ||
    receipt.truncated !== command.truncated
  ) {
    throw new RemoteWorkerCompletionUnavailableError();
  }
  return receipt;
}

function eventId(factory: () => string): string {
  const value = factory();
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 36 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new RemoteWorkerCompletionUnavailableError();
  }
  return value;
}

export class ClusterRemoteWorkerArtifactService {
  constructor(
    private readonly authority: RemoteWorkerArtifactUploadAuthorityRepository,
    private readonly store: ClusterRemoteWorkerArtifactStore,
  ) {
    if (
      typeof authority?.authorizeArtifactUpload !== 'function' ||
      typeof store?.put !== 'function' ||
      typeof store?.inspect !== 'function'
    ) {
      throw new TypeError('Remote Worker Artifact service is invalid');
    }
  }

  async upload(
    input: ClusterRemoteWorkerArtifactUploadInput,
  ): Promise<Readonly<RemoteWorkerArtifactReceipt>> {
    if (
      !input ||
      !Number.isSafeInteger(input.contentLength) ||
      input.contentLength < 6
    ) {
      throw new InvalidRemoteWorkerCompletionError(
        'Artifact upload envelope is invalid',
      );
    }
    const reader = new BoundedArtifactStreamReader(input.chunks, input.signal);
    const prefix = await reader.readExactly(4);
    const headerLength = prefix.readUInt32BE(0);
    prefix.fill(0);
    if (
      headerLength < 2 ||
      headerLength > MAX_REMOTE_WORKER_ARTIFACT_HEADER_BYTES
    ) {
      throw new InvalidRemoteWorkerCompletionError(
        'Artifact upload header length is invalid',
      );
    }
    const header = await reader.readExactly(headerLength);
    let command: Readonly<RemoteWorkerArtifactUploadCommand>;
    try {
      command = parseRemoteWorkerArtifactUploadHeader(header, {
        workerId: input.workerId,
        workerSessionId: input.workerSessionId,
      });
    } finally {
      header.fill(0);
    }
    if (input.contentLength !== 4 + headerLength + command.byteLength) {
      throw new InvalidRemoteWorkerCompletionError(
        'Artifact upload envelope length does not match its header',
      );
    }
    try {
      await this.authority.authorizeArtifactUpload(command);
      const target = storageCommand(command);
      const content = reader.content(command.byteLength);
      const receipt = await this.store.put(
        target,
        content.chunks,
        input.signal,
      );
      if (!content.isComplete()) {
        throw new Error('Artifact store did not consume the complete body');
      }
      return assertReceiptMatches(target, receipt);
    } catch (error) {
      if (
        error instanceof InvalidRemoteWorkerCompletionError ||
        error instanceof RemoteWorkerCompletionFenceRejectedError ||
        error instanceof RemoteWorkerCompletionUnavailableError
      ) {
        throw error;
      }
      throw new RemoteWorkerCompletionUnavailableError({ cause: error });
    }
  }
}

export class ClusterRemoteWorkerCompletionService {
  private readonly createEventId: () => string;

  constructor(
    private readonly repository: RemoteWorkerCompletionRepository,
    private readonly store: Pick<ClusterRemoteWorkerArtifactStore, 'inspect'>,
    options: ClusterRemoteWorkerCompletionServiceOptions = {},
  ) {
    if (
      typeof repository?.complete !== 'function' ||
      typeof store?.inspect !== 'function' ||
      (options.createEventId !== undefined &&
        typeof options.createEventId !== 'function')
    ) {
      throw new TypeError('Remote Worker completion service is invalid');
    }
    this.createEventId = options.createEventId ?? randomUUID;
  }

  async complete(
    value: RemoteWorkerCompletionCommand,
    signal?: AbortSignal,
  ): Promise<Readonly<RemoteWorkerCompletionResult>> {
    const command = normalizeRemoteWorkerCompletionCommand(value);
    if (signal?.aborted) throw signal.reason;
    const lookup = Object.freeze({
      projectId: command.projectId,
      runId: command.runId,
      attemptId: command.attemptId,
      logArtifactId: command.artifact.logArtifactId,
    });
    let stored: Readonly<RemoteWorkerArtifactReceipt> | undefined;
    try {
      stored = await this.store.inspect(lookup, signal);
    } catch (error) {
      throw new RemoteWorkerCompletionUnavailableError({ cause: error });
    }
    if (!stored) {
      throw new RemoteWorkerCompletionFenceRejectedError(
        command.attemptId,
        'state_mismatch',
      );
    }
    const receipt = assertReceiptMatches(
      {
        ...lookup,
        byteLength: command.artifact.byteLength,
        ...(command.artifact.truncated === undefined
          ? {}
          : { truncated: command.artifact.truncated }),
      },
      stored,
    );
    if (receipt.sha256 !== command.artifact.sha256) {
      throw new RemoteWorkerCompletionFenceRejectedError(
        command.attemptId,
        'replay_mismatch',
      );
    }
    try {
      const result = normalizeRemoteWorkerCompletionResult(
        await this.repository.complete(
          Object.freeze({
            ...command,
            attemptEventId: eventId(this.createEventId),
            runEventId: eventId(this.createEventId),
          }),
        ),
      );
      if (
        result.runId !== command.runId ||
        result.attemptId !== command.attemptId ||
        result.callbackSequence !== command.callbackSequence
      ) {
        throw new Error('Remote Worker completion authority drifted');
      }
      return result;
    } catch (error) {
      if (
        error instanceof RemoteWorkerCompletionFenceRejectedError ||
        error instanceof RemoteWorkerCompletionUnavailableError
      ) {
        throw error;
      }
      throw new RemoteWorkerCompletionUnavailableError({ cause: error });
    }
  }
}
