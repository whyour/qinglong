// Remote Execution owns stable offer claiming, delivery, and durable admission.
import { randomBytes, randomUUID } from 'node:crypto';
import type { ClusterRemoteExecutionOffer } from '@qinglong/runtime-core/remote-dispatch';
import { createClusterRemoteExecutionOffer } from '@qinglong/runtime-core/remote-dispatch';
import {
  assertWorkerId,
  assertWorkerSessionId,
} from '@qinglong/runtime-core/worker-session';
import {
  InvalidRemoteExecutionOfferDeliveryError,
  MAX_REMOTE_EXECUTION_OFFER_RESPONSE_BYTES,
  normalizeRemoteExecutionOfferClaimAuthority,
  parseRemoteExecutionOfferPullResponse,
  type RemoteExecutionOfferClaimAuthority,
  type RemoteExecutionOfferDeliveryStats,
  type RemoteExecutionOfferIdleReason,
} from '@qinglong/runtime-core/remote-offer-delivery';
import {
  normalizeWorkerRemoteExecutionInboxRecord,
  type WorkerRemoteExecutionInboxRecord,
} from './executionInbox';

export const MAX_WORKER_REMOTE_OFFER_ATTEMPTS = 16;
export const MAX_WORKER_REMOTE_OFFER_BACKOFF_MS = 60_000;
export const MAX_WORKER_REMOTE_OFFER_INBOX_ENTRIES = 1024;
export const DEFAULT_WORKER_REMOTE_OFFER_INBOX_ENTRIES = 64;
export const MAX_WORKER_REMOTE_OFFER_RECORD_BYTES = 160 * 1024;

export interface WorkerRemoteOfferClaimRecord
  extends RemoteExecutionOfferClaimAuthority {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly attemptCount: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly lastAttemptAtMs: number | null;
  readonly nextAttemptAtMs: number;
}

/** @deprecated Use WorkerRemoteExecutionInboxRecord. */
export type WorkerRemoteOfferInboxRecord = WorkerRemoteExecutionInboxRecord;

export type WorkerRemoteOfferInboxAcceptResult = Readonly<{
  status: 'accepted' | 'replayed';
  record: WorkerRemoteOfferInboxRecord;
}>;

export interface WorkerRemoteOfferDeliveryJournal {
  readPendingClaim(): Promise<WorkerRemoteOfferClaimRecord | undefined>;
  createPendingClaim(
    record: WorkerRemoteOfferClaimRecord,
  ): Promise<WorkerRemoteOfferClaimRecord>;
  replacePendingClaim(
    record: WorkerRemoteOfferClaimRecord,
    expectedRevision: number,
  ): Promise<WorkerRemoteOfferClaimRecord>;
  clearPendingClaim(offerId: string, expectedRevision: number): Promise<void>;
  acceptOffer(
    offer: ClusterRemoteExecutionOffer,
    acceptedAtMs: number,
  ): Promise<WorkerRemoteOfferInboxAcceptResult>;
  readOffer(offerId: string): Promise<WorkerRemoteOfferInboxRecord | undefined>;
}

export interface WorkerRemoteOfferTransport {
  exchange(request: Readonly<{
    path: string;
    body: Readonly<{
      workerGeneration: number;
      offerId: string;
      leaseToken: string;
    }>;
    maximumResponseBytes: number;
    signal?: AbortSignal;
  }>): Promise<Uint8Array | string>;
}

export interface WorkerRemoteOfferSession {
  readonly workerId: string;
  readonly sessionId: string;
  readonly generation: number;
}

export interface WorkerRemoteOfferPullCoordinatorOptions {
  readonly journal: WorkerRemoteOfferDeliveryJournal;
  readonly transport: WorkerRemoteOfferTransport;
  readonly currentSession: () => WorkerRemoteOfferSession | undefined;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly backoffBaseMs?: number;
}

export type WorkerRemoteOfferPullResult =
  | Readonly<{
      status: 'accepted' | 'replayed';
      offerId: string;
      stats: RemoteExecutionOfferDeliveryStats;
      truncated: boolean;
    }>
  | Readonly<{
      status: 'idle';
      reason: RemoteExecutionOfferIdleReason;
      stats: RemoteExecutionOfferDeliveryStats;
      truncated: boolean;
    }>
  | Readonly<{
      status: 'backoff' | 'unavailable' | 'invalid_response';
      offerId: string;
      nextAttemptAtMs: number;
    }>;

export class WorkerRemoteOfferDeliveryError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'claim_conflict'
      | 'claim_revision_conflict'
      | 'offer_conflict'
      | 'attempt_budget_exhausted',
  ) {
    super(`Worker remote offer delivery failed: ${reason}`);
    this.name = 'WorkerRemoteOfferDeliveryError';
  }
}

function safeTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerRemoteOfferDeliveryError('invalid_configuration');
  }
  return value;
}

function safeRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerRemoteOfferDeliveryError('claim_revision_conflict');
  }
  return value;
}

export function normalizeWorkerRemoteOfferClaimRecord(
  value: WorkerRemoteOfferClaimRecord,
): WorkerRemoteOfferClaimRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerRemoteOfferDeliveryError('claim_conflict');
  }
  const expected = [
    'schemaVersion', 'revision', 'workerId', 'workerSessionId',
    'workerGeneration', 'offerId', 'leaseToken', 'attemptCount',
    'createdAtMs', 'updatedAtMs', 'lastAttemptAtMs', 'nextAttemptAtMs',
  ].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    value.schemaVersion !== 1
  ) {
    throw new WorkerRemoteOfferDeliveryError('claim_conflict');
  }
  const authority = normalizeRemoteExecutionOfferClaimAuthority({
    workerId: value.workerId,
    workerSessionId: value.workerSessionId,
    workerGeneration: value.workerGeneration,
    offerId: value.offerId,
    leaseToken: value.leaseToken,
  });
  safeRevision(value.revision);
  if (
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 0 ||
    value.attemptCount > MAX_WORKER_REMOTE_OFFER_ATTEMPTS
  ) {
    throw new WorkerRemoteOfferDeliveryError('claim_conflict');
  }
  const createdAtMs = safeTime(value.createdAtMs, 'createdAtMs');
  const updatedAtMs = safeTime(value.updatedAtMs, 'updatedAtMs');
  const nextAttemptAtMs = safeTime(value.nextAttemptAtMs, 'nextAttemptAtMs');
  if (
    updatedAtMs < createdAtMs ||
    nextAttemptAtMs < createdAtMs ||
    (value.lastAttemptAtMs !== null &&
      (!Number.isSafeInteger(value.lastAttemptAtMs) ||
        value.lastAttemptAtMs < createdAtMs ||
        value.lastAttemptAtMs > updatedAtMs))
  ) {
    throw new WorkerRemoteOfferDeliveryError('claim_conflict');
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: value.revision,
    ...authority,
    attemptCount: value.attemptCount,
    createdAtMs,
    updatedAtMs,
    lastAttemptAtMs: value.lastAttemptAtMs,
    nextAttemptAtMs,
  });
}

export function createWorkerRemoteOfferClaimRecord(
  authority: RemoteExecutionOfferClaimAuthority,
  createdAtMs: number,
): WorkerRemoteOfferClaimRecord {
  const normalized = normalizeRemoteExecutionOfferClaimAuthority(authority);
  const now = safeTime(createdAtMs, 'createdAtMs');
  return normalizeWorkerRemoteOfferClaimRecord({
    schemaVersion: 1,
    revision: 0,
    ...normalized,
    attemptCount: 0,
    createdAtMs: now,
    updatedAtMs: now,
    lastAttemptAtMs: null,
    nextAttemptAtMs: now,
  });
}

export function normalizeWorkerRemoteOfferInboxRecord(
  value: WorkerRemoteOfferInboxRecord,
): WorkerRemoteOfferInboxRecord {
  try {
    return normalizeWorkerRemoteExecutionInboxRecord(value);
  } catch {
    throw new WorkerRemoteOfferDeliveryError('offer_conflict');
  }
}

export function sameWorkerRemoteOfferAuthority(
  left: ClusterRemoteExecutionOffer,
  right: ClusterRemoteExecutionOffer,
): boolean {
  const leftOffer = createClusterRemoteExecutionOffer(left);
  const rightOffer = createClusterRemoteExecutionOffer(right);
  return (
    leftOffer.offerId === rightOffer.offerId &&
    leftOffer.executionDigest === rightOffer.executionDigest &&
    JSON.stringify(leftOffer.candidate) === JSON.stringify(rightOffer.candidate) &&
    JSON.stringify(leftOffer.worker) === JSON.stringify(rightOffer.worker) &&
    leftOffer.lease.runId === rightOffer.lease.runId &&
    leftOffer.lease.attemptId === rightOffer.lease.attemptId &&
    leftOffer.lease.leaseGeneration === rightOffer.lease.leaseGeneration &&
    leftOffer.lease.leaseTokenDigest === rightOffer.lease.leaseTokenDigest &&
    leftOffer.leaseToken === rightOffer.leaseToken &&
    JSON.stringify(leftOffer.executionRevision) ===
      JSON.stringify(rightOffer.executionRevision)
  );
}

export class WorkerRemoteOfferPullCoordinator {
  private readonly journal: WorkerRemoteOfferDeliveryJournal;
  private readonly transport: WorkerRemoteOfferTransport;
  private readonly currentSessionProvider: () =>
    WorkerRemoteOfferSession | undefined;
  private readonly nowProvider: () => number;
  private readonly randomProvider: () => number;
  private readonly backoffBaseMs: number;
  private inFlight?: Readonly<{
    session: WorkerRemoteOfferSession;
    operation: Promise<WorkerRemoteOfferPullResult>;
  }>;

  constructor(options: WorkerRemoteOfferPullCoordinatorOptions) {
    if (
      !options ||
      typeof options.journal?.readPendingClaim !== 'function' ||
      typeof options.transport?.exchange !== 'function' ||
      typeof options.currentSession !== 'function'
    ) {
      throw new WorkerRemoteOfferDeliveryError('invalid_configuration');
    }
    const backoffBaseMs = options.backoffBaseMs ?? 1_000;
    if (
      !Number.isSafeInteger(backoffBaseMs) ||
      backoffBaseMs < 100 ||
      backoffBaseMs > MAX_WORKER_REMOTE_OFFER_BACKOFF_MS
    ) {
      throw new WorkerRemoteOfferDeliveryError('invalid_configuration');
    }
    this.journal = options.journal;
    this.transport = options.transport;
    this.currentSessionProvider = options.currentSession;
    this.nowProvider = options.now ?? Date.now;
    this.randomProvider = options.random ?? Math.random;
    this.backoffBaseMs = backoffBaseMs;
  }

  pull(
    session: WorkerRemoteOfferSession,
    signal?: AbortSignal,
  ): Promise<WorkerRemoteOfferPullResult> {
    assertWorkerId(session.workerId);
    assertWorkerSessionId(session.sessionId);
    if (!Number.isSafeInteger(session.generation) || session.generation < 1) {
      throw new WorkerRemoteOfferDeliveryError('invalid_configuration');
    }
    const normalizedSession = Object.freeze({
      workerId: session.workerId,
      sessionId: session.sessionId,
      generation: session.generation,
    });
    this.assertCurrentSession(normalizedSession);
    if (this.inFlight) {
      if (
        this.inFlight.session.workerId !== normalizedSession.workerId ||
        this.inFlight.session.sessionId !== normalizedSession.sessionId ||
        this.inFlight.session.generation !== normalizedSession.generation
      ) {
        return Promise.reject(
          new WorkerRemoteOfferDeliveryError('claim_conflict'),
        );
      }
      return this.inFlight.operation;
    }
    const operation = this.pullOnce(normalizedSession, signal)
      .finally(() => {
        if (this.inFlight?.operation === operation) this.inFlight = undefined;
      });
    this.inFlight = Object.freeze({
      session: normalizedSession,
      operation,
    });
    return operation;
  }

  private async pullOnce(
    session: WorkerRemoteOfferSession,
    signal?: AbortSignal,
  ): Promise<WorkerRemoteOfferPullResult> {
    const now = this.now();
    let claim = await this.journal.readPendingClaim();
    if (claim) {
      if (
        claim.workerId !== session.workerId ||
        claim.workerSessionId !== session.sessionId ||
        claim.workerGeneration !== session.generation
      ) {
        throw new WorkerRemoteOfferDeliveryError('claim_conflict');
      }
    } else {
      const generated = normalizeRemoteExecutionOfferClaimAuthority({
        workerId: session.workerId,
        workerSessionId: session.sessionId,
        workerGeneration: session.generation,
        offerId: randomUUID(),
        leaseToken: randomBytes(32).toString('base64url'),
      });
      claim = await this.journal.createPendingClaim(
        createWorkerRemoteOfferClaimRecord(generated, now),
      );
    }
    if (claim.nextAttemptAtMs > now) {
      return Object.freeze({
        status: 'backoff' as const,
        offerId: claim.offerId,
        nextAttemptAtMs: claim.nextAttemptAtMs,
      });
    }
    if (claim.attemptCount >= MAX_WORKER_REMOTE_OFFER_ATTEMPTS) {
      throw new WorkerRemoteOfferDeliveryError('attempt_budget_exhausted');
    }
    claim = await this.journal.replacePendingClaim(
      normalizeWorkerRemoteOfferClaimRecord({
        ...claim,
        revision: claim.revision + 1,
        attemptCount: claim.attemptCount + 1,
        lastAttemptAtMs: now,
        updatedAtMs: now,
        nextAttemptAtMs: now,
      }),
      claim.revision,
    );
    try {
      const serialized = await this.transport.exchange({
        path: `/api/v3/worker-ingress/workers/${claim.workerId}/sessions/${claim.workerSessionId}/offers`,
        body: Object.freeze({
          workerGeneration: claim.workerGeneration,
          offerId: claim.offerId,
          leaseToken: claim.leaseToken,
        }),
        maximumResponseBytes: MAX_REMOTE_EXECUTION_OFFER_RESPONSE_BYTES,
        ...(signal === undefined ? {} : { signal }),
      });
      const result = parseRemoteExecutionOfferPullResponse(serialized, {
        workerId: claim.workerId,
        workerSessionId: claim.workerSessionId,
        workerGeneration: claim.workerGeneration,
        offerId: claim.offerId,
        leaseToken: claim.leaseToken,
      });
      if (result.status === 'idle') {
        this.assertCurrentSession(session);
        await this.journal.clearPendingClaim(claim.offerId, claim.revision);
        return Object.freeze({
          status: 'idle' as const,
          reason: result.reason,
          stats: result.stats,
          truncated: result.truncated,
        });
      }
      this.assertCurrentSession(session);
      const accepted = await this.journal.acceptOffer(result.offer, this.now());
      await this.journal.clearPendingClaim(claim.offerId, claim.revision);
      return Object.freeze({
        status: accepted.status,
        offerId: accepted.record.offer.offerId,
        stats: result.stats,
        truncated: result.truncated,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const nextAttemptAtMs = this.nextAttemptAt(claim.attemptCount, this.now());
      await this.journal.replacePendingClaim(
        normalizeWorkerRemoteOfferClaimRecord({
          ...claim,
          revision: claim.revision + 1,
          updatedAtMs: this.now(),
          nextAttemptAtMs,
        }),
        claim.revision,
      );
      return Object.freeze({
        status:
          error instanceof InvalidRemoteExecutionOfferDeliveryError
            ? 'invalid_response' as const
            : 'unavailable' as const,
        offerId: claim.offerId,
        nextAttemptAtMs,
      });
    }
  }

  private nextAttemptAt(attemptCount: number, now: number): number {
    const random = this.randomProvider();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw new WorkerRemoteOfferDeliveryError('invalid_configuration');
    }
    const ceiling = Math.min(
      MAX_WORKER_REMOTE_OFFER_BACKOFF_MS,
      this.backoffBaseMs * 2 ** Math.max(0, attemptCount - 1),
    );
    return safeTime(now + Math.floor(random * ceiling), 'nextAttemptAtMs');
  }

  private assertCurrentSession(expected: WorkerRemoteOfferSession): void {
    const current = this.currentSessionProvider();
    if (
      !current ||
      current.workerId !== expected.workerId ||
      current.sessionId !== expected.sessionId ||
      current.generation !== expected.generation
    ) {
      throw new WorkerRemoteOfferDeliveryError('claim_conflict');
    }
  }

  private now(): number {
    return safeTime(this.nowProvider(), 'now');
  }
}
