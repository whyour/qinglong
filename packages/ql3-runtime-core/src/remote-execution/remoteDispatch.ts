import { timingSafeEqual } from 'node:crypto';
import type { ClusterTaskExecutionRevision } from '../task-definition/clusterExecutionRevision';
import {
  CLUSTER_EXECUTOR_TYPE,
  normalizeClusterTaskExecutionRevision,
} from '../task-definition/clusterExecutionRevision';
import type { RunDispatchLeaseRecord } from '../run/runDispatchLease';
import {
  assertRunDispatchId,
  assertRunDispatchLeaseRecord,
  digestRunDispatchLeaseToken,
} from '../run/runDispatchLease';
import {
  assertWorkerId,
  assertWorkerSessionId,
} from '../worker/workerSession';

export * from './remoteWorkerPlacement';

export const MAX_REMOTE_DISPATCH_PAGE_SIZE = 64;
const SHA256 = /^[a-f0-9]{64}$/;

export interface ClusterDispatchCandidateCursor {
  readonly priority: number;
  readonly queuedAtMs: number;
  readonly attemptCreatedAtMs: number;
  readonly attemptId: string;
}

export interface ClusterDispatchCandidate extends ClusterDispatchCandidateCursor {
  readonly runId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly attemptNumber: number;
  readonly executorType: typeof CLUSTER_EXECUTOR_TYPE;
}

export interface ClusterDispatchCandidatePage {
  readonly observedAtMs: number;
  readonly candidates: readonly ClusterDispatchCandidate[];
  readonly truncated: boolean;
  readonly next?: ClusterDispatchCandidateCursor;
}

export interface ClusterDispatchRecovery {
  readonly observedAtMs: number;
  readonly candidate: ClusterDispatchCandidate;
  readonly lease: RunDispatchLeaseRecord;
  readonly workerCurrent: boolean;
}

export interface ClusterDispatchSource {
  listClusterDispatchCandidates(options: Readonly<{
    limit: number;
    after?: ClusterDispatchCandidateCursor;
  }>): Promise<ClusterDispatchCandidatePage>;
  findClusterDispatchRecovery(offerId: string): Promise<ClusterDispatchRecovery | null>;
}

export interface ClusterRemoteExecutionOffer {
  readonly offerId: string;
  readonly deliveryKind: 'new_claim' | 'lease_recovery';
  readonly executionDigest: string;
  readonly candidate: ClusterDispatchCandidate;
  readonly worker: Readonly<{
    workerId: string;
    sessionId: string;
    generation: number;
  }>;
  readonly lease: RunDispatchLeaseRecord;
  /** Ephemeral capability supplied by the Worker; never persist or log it. */
  readonly leaseToken: string;
  readonly executionRevision: ClusterTaskExecutionRevision;
  readonly placementScore: number;
}

function invalid(message: string): never {
  throw new TypeError(`Remote dispatch value is invalid: ${message}`);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(`${label} is invalid`);
  return value as number;
}

export function normalizeClusterDispatchCandidate(value: ClusterDispatchCandidate): ClusterDispatchCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('candidate is invalid');
  for (const [label, id] of [
    ['runId', value.runId], ['attemptId', value.attemptId], ['projectId', value.projectId],
    ['taskId', value.taskId], ['taskRevision', value.taskRevision],
  ] as const) assertRunDispatchId(label, id);
  if (!Number.isSafeInteger(value.priority)) invalid('candidate priority is invalid');
  safeInteger(value.queuedAtMs, 'candidate queuedAtMs');
  safeInteger(value.attemptCreatedAtMs, 'candidate attemptCreatedAtMs');
  safeInteger(value.attemptNumber, 'candidate attemptNumber', 1);
  if (value.executorType !== CLUSTER_EXECUTOR_TYPE) invalid('candidate executorType is invalid');
  return Object.freeze({ ...value });
}

export function normalizeClusterDispatchCursor(value: ClusterDispatchCandidateCursor): ClusterDispatchCandidateCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('cursor is invalid');
  if (!Number.isSafeInteger(value.priority)) invalid('cursor priority is invalid');
  safeInteger(value.queuedAtMs, 'cursor queuedAtMs');
  safeInteger(value.attemptCreatedAtMs, 'cursor attemptCreatedAtMs');
  assertRunDispatchId('attemptId', value.attemptId);
  return Object.freeze({ ...value });
}

export function assertRemoteDispatchPageSize(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REMOTE_DISPATCH_PAGE_SIZE) {
    throw new RangeError(`Remote dispatch page size must be between 1 and ${MAX_REMOTE_DISPATCH_PAGE_SIZE}`);
  }
}

export function createClusterRemoteExecutionOffer(value: ClusterRemoteExecutionOffer): ClusterRemoteExecutionOffer {
  assertRunDispatchId('offerId', value.offerId);
  const candidate = normalizeClusterDispatchCandidate(value.candidate);
  assertWorkerId(value.worker.workerId);
  assertWorkerSessionId(value.worker.sessionId);
  safeInteger(value.worker.generation, 'offer worker generation', 1);
  assertRunDispatchLeaseRecord(value.lease);
  if (
    value.lease.status !== 'leased' ||
    value.lease.attemptId !== candidate.attemptId || value.lease.runId !== candidate.runId ||
    value.lease.workerId !== value.worker.workerId ||
    value.lease.workerSessionId !== value.worker.sessionId ||
    value.lease.workerGeneration !== value.worker.generation ||
    digestRunDispatchLeaseToken(value.leaseToken) !== value.lease.leaseTokenDigest
  ) invalid('offer authority does not match');
  const executionRevision = normalizeClusterTaskExecutionRevision(value.executionRevision);
  if (
    executionRevision.projectId !== candidate.projectId ||
    executionRevision.taskId !== candidate.taskId ||
    executionRevision.taskRevision !== candidate.taskRevision
  ) invalid('offer execution revision does not match candidate');
  if (!SHA256.test(value.executionDigest) || value.executionDigest !== executionRevision.contentDigest) invalid('offer execution digest does not match');
  if (!Number.isSafeInteger(value.placementScore) || value.placementScore < 0) invalid('offer placement score is invalid');
  return Object.freeze({
    offerId: value.offerId,
    deliveryKind: value.deliveryKind,
    executionDigest: value.executionDigest,
    candidate,
    worker: Object.freeze({ ...value.worker }),
    lease: Object.freeze({ ...value.lease }),
    leaseToken: value.leaseToken,
    executionRevision,
    placementScore: value.placementScore,
  });
}

export function leaseTokenMatchesDigest(token: string, digest: string): boolean {
  const actual = Buffer.from(digestRunDispatchLeaseToken(token), 'hex');
  const expected = SHA256.test(digest) ? Buffer.from(digest, 'hex') : Buffer.alloc(0);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
