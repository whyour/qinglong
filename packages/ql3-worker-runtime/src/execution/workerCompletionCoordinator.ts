// Worker Execution owns crash-replayable Artifact upload and completion convergence.
import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  CompletionReceipt,
  CompletionReceiptStore,
} from '@qinglong/local-process';
import {
  normalizeWorkerRemoteExecutionInboxRecord,
  type WorkerRemoteExecutionInbox,
  type WorkerRemoteExecutionInboxRecord,
} from '../remote-execution/executionInbox';
import type { WorkerRemoteExecutionSession } from '../remote-execution/executionInboxProcessor';
import type {
  WorkerRemoteLogArtifactReadLease,
  WorkerRemoteLogArtifactSource,
} from './workerFileLogArtifactAllocator';
import type { RemoteWorkerExecutionFence } from '@qinglong/runtime-core/remote-worker-completion';

const SHA256 = /^[a-f0-9]{64}$/;
const COMPLETION_EVIDENCE_STATES = new Set([
  'launching',
  'started',
  'running_acknowledged',
  'recovery_required',
]);

export interface WorkerRemoteLogArtifactUploadCommand {
  readonly workerId: RemoteWorkerExecutionFence['workerId'];
  readonly workerSessionId: RemoteWorkerExecutionFence['workerSessionId'];
  readonly workerGeneration: RemoteWorkerExecutionFence['workerGeneration'];
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly offerId: RemoteWorkerExecutionFence['offerId'];
  readonly leaseGeneration: RemoteWorkerExecutionFence['leaseGeneration'];
  readonly leaseToken: RemoteWorkerExecutionFence['leaseToken'];
  readonly expectedLeaseVersion: RemoteWorkerExecutionFence['expectedLeaseVersion'];
  readonly logArtifactId: string;
  readonly byteLength: number;
  readonly truncated: boolean | undefined;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface WorkerRemoteLogArtifactUploadResult {
  readonly status: 'stored' | 'already_stored';
  readonly logArtifactId: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface WorkerRemoteLogArtifactUploader {
  upload(
    command: WorkerRemoteLogArtifactUploadCommand,
  ): Promise<Readonly<WorkerRemoteLogArtifactUploadResult>>;
}

export interface WorkerRemoteExecutionCompletionCommand {
  readonly offerId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly callbackSequence: number;
  readonly callbackTokenDigest: string;
  readonly result: Readonly<{
    outcome: 'succeeded' | 'failed';
    startedAtMs: number;
    finishedAtMs: number;
    exitCode: number;
  }>;
  readonly artifact: Readonly<{
    logArtifactId: string;
    byteLength: number;
    sha256: string;
    truncated: boolean | undefined;
  }>;
  readonly executorType: string;
  readonly workerId: string;
  readonly workerSessionId: string;
  readonly workerGeneration: number;
  readonly leaseGeneration: number;
  readonly leaseToken: string;
  readonly expectedLeaseVersion: number;
}

export interface WorkerRemoteExecutionCompletionResult {
  readonly status: 'applied' | 'already_completed' | 'already_terminal';
  readonly runId: string;
  readonly attemptId: string;
  readonly callbackSequence: number;
}

export interface WorkerRemoteExecutionCompletionClient {
  complete(
    command: WorkerRemoteExecutionCompletionCommand,
  ): Promise<Readonly<WorkerRemoteExecutionCompletionResult>>;
}

export type WorkerRemoteCompletionStatus =
  | 'not_found'
  | 'deferred'
  | 'receipt_missing'
  | 'receipt_unavailable'
  | 'receipt_invalid'
  | 'artifact_missing'
  | 'completion_acknowledged'
  | 'already_completed'
  | 'control_plane_terminal';

export interface WorkerRemoteCompletionResult {
  readonly offerId: string;
  readonly status: WorkerRemoteCompletionStatus;
  readonly receiptCleanup?: 'removed' | 'already_absent' | 'pending';
}

export interface WorkerRemoteCompletionCoordinatorOptions {
  readonly currentSession: () => WorkerRemoteExecutionSession | undefined;
  readonly now?: () => number;
}

export class WorkerRemoteCompletionCoordinatorError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'artifact_response_invalid'
      | 'completion_response_invalid',
  ) {
    super(`Worker remote completion coordination failed: ${reason}`);
    this.name = 'WorkerRemoteCompletionCoordinatorError';
  }
}

/**
 * Crash-replayable Worker completion pipeline. The local receipt is an
 * authenticated capability, the log is uploaded before terminal mutation,
 * and receipt deletion happens only after the inbox completion barrier.
 */
export class WorkerRemoteCompletionCoordinator {
  private readonly currentSessionProvider: () =>
    WorkerRemoteExecutionSession | undefined;
  private readonly nowProvider: () => number;
  private readonly inFlight = new Map<
    string,
    Promise<WorkerRemoteCompletionResult>
  >();

  constructor(
    private readonly inbox: Pick<
      WorkerRemoteExecutionInbox,
      'readOffer' | 'replaceOffer'
    >,
    private readonly receipts: Pick<CompletionReceiptStore, 'read' | 'remove'>,
    private readonly artifacts: WorkerRemoteLogArtifactSource,
    private readonly uploader: WorkerRemoteLogArtifactUploader,
    private readonly completion: WorkerRemoteExecutionCompletionClient,
    options: WorkerRemoteCompletionCoordinatorOptions,
  ) {
    if (
      typeof inbox?.readOffer !== 'function' ||
      typeof inbox?.replaceOffer !== 'function' ||
      typeof receipts?.read !== 'function' ||
      typeof receipts?.remove !== 'function' ||
      typeof artifacts?.open !== 'function' ||
      typeof uploader?.upload !== 'function' ||
      typeof completion?.complete !== 'function' ||
      typeof options?.currentSession !== 'function'
    ) {
      throw new WorkerRemoteCompletionCoordinatorError('invalid_configuration');
    }
    this.currentSessionProvider = options.currentSession;
    this.nowProvider = options.now ?? Date.now;
  }

  recover(offerId: string): Promise<WorkerRemoteCompletionResult> {
    const active = this.inFlight.get(offerId);
    if (active) return active;
    const operation = this.process(offerId).finally(() => {
      if (this.inFlight.get(offerId) === operation) this.inFlight.delete(offerId);
    });
    this.inFlight.set(offerId, operation);
    return operation;
  }

  private async process(offerId: string): Promise<WorkerRemoteCompletionResult> {
    const value = await this.inbox.readOffer(offerId);
    if (!value) return Object.freeze({ offerId, status: 'not_found' });
    let record = normalizeWorkerRemoteExecutionInboxRecord(value);
    if (record.state === 'completion_acknowledged') {
      return Object.freeze({
        offerId,
        status: 'already_completed',
        receiptCleanup: await this.cleanup(record.offer.candidate.attemptId),
      });
    }
    if (!this.canSubmit(record)) {
      return Object.freeze({ offerId, status: 'deferred' });
    }

    let receipt: CompletionReceipt | undefined;
    try {
      receipt = await this.receipts.read(record.offer.candidate.attemptId);
    } catch {
      return Object.freeze({ offerId, status: 'receipt_unavailable' });
    }
    if (!receipt) return Object.freeze({ offerId, status: 'receipt_missing' });
    try {
      this.authenticate(record, receipt);
    } catch {
      return Object.freeze({ offerId, status: 'receipt_invalid' });
    }

    const artifact = await this.artifacts.open({
      runId: record.offer.candidate.runId,
      attemptId: record.offer.candidate.attemptId,
      logArtifactId: record.logArtifactId!,
    });
    if (!artifact) return Object.freeze({ offerId, status: 'artifact_missing' });
    const uploaded = await this.upload(record, artifact);
    const completed = await this.completion.complete(Object.freeze({
      offerId: record.offer.offerId,
      projectId: record.offer.candidate.projectId,
      runId: record.offer.candidate.runId,
      attemptId: record.offer.candidate.attemptId,
      callbackSequence: receipt.callbackSequence,
      callbackTokenDigest: record.completionReceiptTokenDigest!,
      result: Object.freeze({
        outcome: receipt.exitCode === 0 ? 'succeeded' as const : 'failed' as const,
        startedAtMs: receipt.startedAtMs,
        finishedAtMs: receipt.finishedAtMs,
        exitCode: receipt.exitCode,
      }),
      artifact: Object.freeze({
        logArtifactId: uploaded.logArtifactId,
        byteLength: uploaded.byteLength,
        sha256: uploaded.sha256,
        truncated: artifact.truncated,
      }),
      executorType: record.offer.candidate.executorType,
      workerId: record.offer.lease.workerId,
      workerSessionId: record.offer.lease.workerSessionId,
      workerGeneration: record.offer.lease.workerGeneration,
      leaseGeneration: record.offer.lease.leaseGeneration,
      leaseToken: record.offer.leaseToken,
      expectedLeaseVersion: record.offer.lease.version,
    }));
    this.assertCompletionResponse(record, receipt, completed);
    if (completed.status === 'already_terminal') {
      return Object.freeze({ offerId, status: 'control_plane_terminal' });
    }
    record = await this.markAcknowledged(record);
    return Object.freeze({
      offerId,
      status: 'completion_acknowledged',
      receiptCleanup: await this.cleanup(record.offer.candidate.attemptId),
    });
  }

  private canSubmit(record: WorkerRemoteExecutionInboxRecord): boolean {
    if (!COMPLETION_EVIDENCE_STATES.has(record.state)) return false;
    if (
      record.state === 'recovery_required' &&
      record.recoveryReason !== 'launch_outcome_unknown'
    ) return false;
    const current = this.currentSessionProvider();
    const now = this.now();
    return Boolean(
      current &&
      current.workerId === record.offer.worker.workerId &&
      current.sessionId === record.offer.worker.sessionId &&
      current.generation === record.offer.worker.generation &&
      current.status !== 'offline' &&
      current.leaseExpiresAtMs > now &&
      record.offer.lease.expiresAtMs > now &&
      record.executorStartedAtMs !== undefined &&
      record.logArtifactId !== undefined &&
      record.completionReceiptCallbackSequence !== undefined &&
      record.completionReceiptTokenDigest !== undefined
    );
  }

  private authenticate(
    record: WorkerRemoteExecutionInboxRecord,
    receipt: CompletionReceipt,
  ): void {
    if (
      receipt.runId !== record.offer.candidate.runId ||
      receipt.attemptId !== record.offer.candidate.attemptId ||
      receipt.callbackSequence !== record.completionReceiptCallbackSequence ||
      receipt.startedAtMs !== record.executorStartedAtMs ||
      receipt.finishedAtMs > this.now() ||
      !record.completionReceiptTokenDigest ||
      !SHA256.test(record.completionReceiptTokenDigest)
    ) throw new Error('Completion receipt authority does not match');
    const token = Buffer.from(receipt.token, 'base64url');
    try {
      if (token.byteLength !== 32 || token.toString('base64url') !== receipt.token) {
        throw new Error('Completion receipt capability is not canonical');
      }
      const expected = Buffer.from(record.completionReceiptTokenDigest, 'hex');
      const actual = createHash('sha256').update(token).digest();
      if (!timingSafeEqual(expected, actual)) {
        throw new Error('Completion receipt capability does not match');
      }
    } finally {
      token.fill(0);
    }
  }

  private async upload(
    record: WorkerRemoteExecutionInboxRecord,
    artifact: WorkerRemoteLogArtifactReadLease,
  ): Promise<WorkerRemoteLogArtifactUploadResult> {
    const digest = createHash('sha256');
    let observedBytes = 0;
    const content = (async function* () {
      for await (const chunk of artifact.chunks()) {
        observedBytes += chunk.byteLength;
        digest.update(chunk);
        yield chunk;
      }
    })();
    let result: Readonly<WorkerRemoteLogArtifactUploadResult>;
    try {
      result = await this.uploader.upload(Object.freeze({
        workerId: record.offer.lease.workerId,
        workerSessionId: record.offer.lease.workerSessionId,
        workerGeneration: record.offer.lease.workerGeneration,
        projectId: record.offer.candidate.projectId,
        runId: record.offer.candidate.runId,
        attemptId: record.offer.candidate.attemptId,
        offerId: record.offer.offerId,
        leaseGeneration: record.offer.lease.leaseGeneration,
        leaseToken: record.offer.leaseToken,
        expectedLeaseVersion: record.offer.lease.version,
        logArtifactId: artifact.logArtifactId,
        byteLength: artifact.byteLength,
        truncated: artifact.truncated,
        content,
      }));
    } finally {
      await artifact.close();
    }
    const actualDigest = digest.digest('hex');
    if (
      observedBytes !== artifact.byteLength ||
      (result?.status !== 'stored' && result?.status !== 'already_stored') ||
      result.logArtifactId !== artifact.logArtifactId ||
      result.byteLength !== artifact.byteLength ||
      !SHA256.test(result.sha256) ||
      result.sha256 !== actualDigest
    ) {
      throw new WorkerRemoteCompletionCoordinatorError(
        'artifact_response_invalid',
      );
    }
    return Object.freeze({ ...result });
  }

  private assertCompletionResponse(
    record: WorkerRemoteExecutionInboxRecord,
    receipt: CompletionReceipt,
    result: Readonly<WorkerRemoteExecutionCompletionResult>,
  ): void {
    if (
      !['applied', 'already_completed', 'already_terminal'].includes(result?.status) ||
      result.runId !== record.offer.candidate.runId ||
      result.attemptId !== record.offer.candidate.attemptId ||
      result.callbackSequence !== receipt.callbackSequence
    ) {
      throw new WorkerRemoteCompletionCoordinatorError(
        'completion_response_invalid',
      );
    }
  }

  private async markAcknowledged(
    record: WorkerRemoteExecutionInboxRecord,
  ): Promise<WorkerRemoteExecutionInboxRecord> {
    const updatedAtMs = Math.max(this.now(), record.updatedAtMs);
    const { recoveryReason: _recoveryReason, ...authority } = record;
    const next = normalizeWorkerRemoteExecutionInboxRecord({
      ...authority,
      revision: record.revision + 1,
      state: 'completion_acknowledged',
      updatedAtMs,
      completionAcknowledgedAtMs: updatedAtMs,
    });
    try {
      await this.inbox.replaceOffer(next, record.revision);
      return next;
    } catch (error) {
      const current = await this.inbox.readOffer(record.offer.offerId);
      if (current) {
        const normalized = normalizeWorkerRemoteExecutionInboxRecord(current);
        if (normalized.state === 'completion_acknowledged') return normalized;
      }
      throw error;
    }
  }

  private async cleanup(
    attemptId: string,
  ): Promise<'removed' | 'already_absent' | 'pending'> {
    try {
      return (await this.receipts.remove(attemptId))
        ? 'removed'
        : 'already_absent';
    } catch {
      return 'pending';
    }
  }

  private now(): number {
    const value = this.nowProvider();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WorkerRemoteCompletionCoordinatorError('invalid_configuration');
    }
    return value;
  }
}
