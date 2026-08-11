import type { ExecutionHandle } from './execution';
import { cloneExecutionSpec } from './executionSpec';
import {
  assertRunDispatchCandidate,
  type RunDispatchCandidate,
} from './runDispatchCandidate';
import {
  assertRunDispatchLeaseRecord,
  type RunDispatchLeaseRecord,
} from './runDispatchLease';
import {
  assertRunDispatchOfferId,
  createExecutionSpecDigest,
  createRunDispatchOfferId,
  type ClaimedExecutionOffer,
} from './runDispatchOffer';
import {
  MAX_EXECUTOR_HANDLE_LENGTH,
  MAX_LOG_ARTIFACT_ID_LENGTH,
} from './runStateMachine';
import { WORKER_COMPLETION_RECEIPT_TOKEN_DIGEST_PATTERN } from './workerExecutionCompletionReceiptAuthentication';

export const WORKER_EXECUTION_OFFER_JOURNAL_STATES = [
  'accepted',
  'starting_acknowledged',
  'launching',
  'started',
  'running_acknowledged',
  'start_failed',
  'start_failure_acknowledged',
  'completion_acknowledged',
  'recovery_required',
] as const;

export type WorkerExecutionOfferJournalState =
  (typeof WORKER_EXECUTION_OFFER_JOURNAL_STATES)[number];

export const MAX_WORKER_EXECUTION_OFFER_RECORD_BYTES = 192 * 1024;
export const MAX_WORKER_EXECUTION_OFFER_JOURNAL_ENTRIES = 1024;
export const MAX_WORKER_EXECUTION_OFFER_JOURNAL_PAGE_SIZE = 64;

export interface WorkerExecutionOfferJournalRecord {
  schemaVersion: 1;
  revision: number;
  state: WorkerExecutionOfferJournalState;
  offer: ClaimedExecutionOffer;
  acceptedAtMs: number;
  updatedAtMs: number;
  executorHandle?: string;
  executorStartedAtMs?: number;
  logArtifactId?: string;
  completionReceiptCallbackSequence?: number;
  completionReceiptTokenDigest?: string;
  completionAcknowledgedAtMs?: number;
  recoveryReason?:
    | 'launch_outcome_unknown'
    | 'control_plane_already_running'
    | 'control_plane_terminal'
    | 'lease_lost_local_execution_stopped'
    | 'lease_lost_local_execution_unverified';
}

export class InvalidWorkerExecutionOfferError extends TypeError {
  constructor(message: string) {
    super(`Worker execution offer is invalid: ${message}`);
    this.name = 'InvalidWorkerExecutionOfferError';
  }
}

export class WorkerExecutionOfferConflictError extends Error {
  constructor(readonly offerId: string) {
    super(`Worker execution offer ${offerId} conflicts with durable state`);
    this.name = 'WorkerExecutionOfferConflictError';
  }
}

function invalid(message: string): never {
  throw new InvalidWorkerExecutionOfferError(message);
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function sameCandidate(
  left: RunDispatchCandidate,
  right: RunDispatchCandidate,
): boolean {
  return (
    left.runId === right.runId &&
    left.attemptId === right.attemptId &&
    left.projectId === right.projectId &&
    left.taskId === right.taskId &&
    left.taskRevision === right.taskRevision &&
    left.executorType === right.executorType &&
    left.priority === right.priority &&
    left.queuedAtMs === right.queuedAtMs &&
    left.attemptCreatedAtMs === right.attemptCreatedAtMs
  );
}

function sameLeaseAuthority(
  left: RunDispatchLeaseRecord,
  right: RunDispatchLeaseRecord,
): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.runId === right.runId &&
    left.workerId === right.workerId &&
    left.workerSessionId === right.workerSessionId &&
    left.workerGeneration === right.workerGeneration &&
    left.leaseGeneration === right.leaseGeneration &&
    left.leaseToken === right.leaseToken
  );
}

export function assertClaimedExecutionOffer(
  offer: ClaimedExecutionOffer,
): void {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
    invalid('offer must be an object');
  }
  assertRunDispatchOfferId(offer.offerId);
  assertRunDispatchCandidate(offer.candidate);
  assertRunDispatchLeaseRecord(offer.lease);
  if (offer.lease.status !== 'leased') invalid('lease must be active');
  cloneExecutionSpec(offer.executionSpec);
  if (
    offer.deliveryKind !== 'new_claim' &&
    offer.deliveryKind !== 'lease_recovery'
  ) {
    invalid('deliveryKind is invalid');
  }
  if (
    !offer.worker ||
    typeof offer.worker !== 'object' ||
    offer.worker.id !== offer.lease.workerId ||
    offer.worker.sessionId !== offer.lease.workerSessionId ||
    offer.worker.generation !== offer.lease.workerGeneration
  ) {
    invalid('Worker target does not match the lease fence');
  }
  if (
    offer.candidate.runId !== offer.lease.runId ||
    offer.candidate.attemptId !== offer.lease.attemptId ||
    offer.executionSpec.runId !== offer.candidate.runId ||
    offer.executionSpec.attemptId !== offer.candidate.attemptId ||
    offer.executionSpec.projectId !== offer.candidate.projectId ||
    offer.executionSpec.taskId !== offer.candidate.taskId ||
    offer.executionSpec.taskRevision !== offer.candidate.taskRevision
  ) {
    invalid('Run, Attempt, Project, Task or revision identity drifted');
  }
  if (createRunDispatchOfferId(offer.lease) !== offer.offerId) {
    invalid('offerId does not match the lease authority');
  }
  if (
    createExecutionSpecDigest(offer.executionSpec) !== offer.executionSpecDigest
  ) {
    invalid('ExecutionSpec digest does not match the payload');
  }
  if (
    offer.placementScore !== undefined &&
    (!Number.isFinite(offer.placementScore) || offer.placementScore < 0)
  ) {
    invalid('placementScore is invalid');
  }
}

export function cloneClaimedExecutionOffer(
  offer: ClaimedExecutionOffer,
): ClaimedExecutionOffer {
  assertClaimedExecutionOffer(offer);
  return {
    offerId: offer.offerId,
    executionSpecDigest: offer.executionSpecDigest,
    deliveryKind: offer.deliveryKind,
    candidate: { ...offer.candidate },
    worker: { ...offer.worker },
    lease: { ...offer.lease },
    executionSpec: cloneExecutionSpec(offer.executionSpec),
    ...(offer.placementScore === undefined
      ? {}
      : { placementScore: offer.placementScore }),
  };
}

export function assertSameWorkerExecutionOffer(
  persisted: ClaimedExecutionOffer,
  delivered: ClaimedExecutionOffer,
): void {
  assertClaimedExecutionOffer(persisted);
  assertClaimedExecutionOffer(delivered);
  if (
    persisted.offerId !== delivered.offerId ||
    persisted.executionSpecDigest !== delivered.executionSpecDigest ||
    !sameCandidate(persisted.candidate, delivered.candidate) ||
    !sameLeaseAuthority(persisted.lease, delivered.lease) ||
    persisted.worker.id !== delivered.worker.id ||
    persisted.worker.sessionId !== delivered.worker.sessionId ||
    persisted.worker.generation !== delivered.worker.generation
  ) {
    throw new WorkerExecutionOfferConflictError(delivered.offerId);
  }
}

export function mergeWorkerExecutionOffer(
  persisted: ClaimedExecutionOffer,
  delivered: ClaimedExecutionOffer,
): ClaimedExecutionOffer {
  assertSameWorkerExecutionOffer(persisted, delivered);
  const selectedLease =
    delivered.lease.version > persisted.lease.version
      ? delivered.lease
      : persisted.lease;
  return cloneClaimedExecutionOffer({
    ...persisted,
    deliveryKind: delivered.deliveryKind,
    lease: selectedLease,
  });
}

export function createWorkerExecutionOfferJournalRecord(
  offer: ClaimedExecutionOffer,
  acceptedAtMs: number,
): WorkerExecutionOfferJournalRecord {
  safeInteger(acceptedAtMs, 'acceptedAtMs');
  return {
    schemaVersion: 1,
    revision: 0,
    state: 'accepted',
    offer: cloneClaimedExecutionOffer(offer),
    acceptedAtMs,
    updatedAtMs: acceptedAtMs,
  };
}

export function cloneWorkerExecutionOfferJournalRecord(
  record: WorkerExecutionOfferJournalRecord,
): WorkerExecutionOfferJournalRecord {
  assertWorkerExecutionOfferJournalRecord(record);
  return {
    schemaVersion: 1,
    revision: record.revision,
    state: record.state,
    offer: cloneClaimedExecutionOffer(record.offer),
    acceptedAtMs: record.acceptedAtMs,
    updatedAtMs: record.updatedAtMs,
    ...(record.executorHandle === undefined
      ? {}
      : { executorHandle: record.executorHandle }),
    ...(record.executorStartedAtMs === undefined
      ? {}
      : { executorStartedAtMs: record.executorStartedAtMs }),
    ...(record.logArtifactId === undefined
      ? {}
      : { logArtifactId: record.logArtifactId }),
    ...(record.completionReceiptCallbackSequence === undefined
      ? {}
      : {
          completionReceiptCallbackSequence:
            record.completionReceiptCallbackSequence,
        }),
    ...(record.completionReceiptTokenDigest === undefined
      ? {}
      : {
          completionReceiptTokenDigest: record.completionReceiptTokenDigest,
        }),
    ...(record.completionAcknowledgedAtMs === undefined
      ? {}
      : {
          completionAcknowledgedAtMs: record.completionAcknowledgedAtMs,
        }),
    ...(record.recoveryReason === undefined
      ? {}
      : { recoveryReason: record.recoveryReason }),
  };
}

export function assertWorkerExecutionOfferJournalRecord(
  record: WorkerExecutionOfferJournalRecord,
): void {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    invalid('journal record must be an object');
  }
  if (record.schemaVersion !== 1) invalid('schemaVersion is unsupported');
  safeInteger(record.revision, 'revision');
  safeInteger(record.acceptedAtMs, 'acceptedAtMs');
  safeInteger(record.updatedAtMs, 'updatedAtMs');
  if (record.updatedAtMs < record.acceptedAtMs) {
    invalid('journal timestamps are inconsistent');
  }
  if (!WORKER_EXECUTION_OFFER_JOURNAL_STATES.includes(record.state)) {
    invalid('journal state is invalid');
  }
  assertClaimedExecutionOffer(record.offer);
  const hasExecutorMetadata =
    record.executorHandle !== undefined ||
    record.executorStartedAtMs !== undefined ||
    record.logArtifactId !== undefined;
  const requiresExecutorMetadata =
    record.state === 'started' || record.state === 'running_acknowledged';
  if (requiresExecutorMetadata || hasExecutorMetadata) {
    boundedString(
      record.executorHandle,
      'executorHandle',
      MAX_EXECUTOR_HANDLE_LENGTH,
    );
    safeInteger(record.executorStartedAtMs, 'executorStartedAtMs');
    if (
      !requiresExecutorMetadata &&
      record.state !== 'recovery_required' &&
      record.state !== 'completion_acknowledged'
    ) {
      invalid('executor metadata is not allowed in this journal state');
    }
  }
  if (record.logArtifactId !== undefined) {
    boundedString(
      record.logArtifactId,
      'logArtifactId',
      MAX_LOG_ARTIFACT_ID_LENGTH,
    );
  }
  const hasCompletionCallbackSequence =
    record.completionReceiptCallbackSequence !== undefined;
  const hasCompletionTokenDigest =
    record.completionReceiptTokenDigest !== undefined;
  if (hasCompletionCallbackSequence !== hasCompletionTokenDigest) {
    invalid('completion receipt authentication metadata must be complete');
  }
  if (hasCompletionCallbackSequence) {
    if (
      !Number.isSafeInteger(record.completionReceiptCallbackSequence) ||
      record.completionReceiptCallbackSequence! < 1
    ) {
      invalid('completionReceiptCallbackSequence must be positive');
    }
    if (
      typeof record.completionReceiptTokenDigest !== 'string' ||
      !WORKER_COMPLETION_RECEIPT_TOKEN_DIGEST_PATTERN.test(
        record.completionReceiptTokenDigest,
      )
    ) {
      invalid('completionReceiptTokenDigest is invalid');
    }
    if (
      record.state === 'accepted' ||
      record.state === 'starting_acknowledged'
    ) {
      invalid(
        'completion receipt authentication is not allowed before launching',
      );
    }
  }
  if (record.state === 'completion_acknowledged') {
    if (!hasCompletionCallbackSequence) {
      invalid('completion acknowledgement requires authentication metadata');
    }
    safeInteger(
      record.completionAcknowledgedAtMs,
      'completionAcknowledgedAtMs',
    );
    if (record.completionAcknowledgedAtMs !== record.updatedAtMs) {
      invalid('completion acknowledgement timestamp must match updatedAtMs');
    }
  } else if (record.completionAcknowledgedAtMs !== undefined) {
    invalid(
      'completionAcknowledgedAtMs is only allowed for completion_acknowledged',
    );
  }
  if (record.state === 'recovery_required') {
    if (
      record.recoveryReason !== 'launch_outcome_unknown' &&
      record.recoveryReason !== 'control_plane_already_running' &&
      record.recoveryReason !== 'control_plane_terminal' &&
      record.recoveryReason !== 'lease_lost_local_execution_stopped' &&
      record.recoveryReason !== 'lease_lost_local_execution_unverified'
    ) {
      invalid('recoveryReason is invalid');
    }
  } else if (record.recoveryReason !== undefined) {
    invalid('recoveryReason is only allowed for recovery_required');
  }
}

export function workerExecutionHandleMetadata(handle: ExecutionHandle): {
  executorHandle: string;
  executorStartedAtMs: number;
} {
  const executorHandle = boundedString(
    handle.durableHandle ?? handle.id,
    'executorHandle',
    MAX_EXECUTOR_HANDLE_LENGTH,
  );
  const executorStartedAtMs = safeInteger(handle.startedAtMs, 'startedAtMs');
  return { executorHandle, executorStartedAtMs };
}

export function serializeWorkerExecutionOfferJournalRecord(
  record: WorkerExecutionOfferJournalRecord,
): string {
  const serialized = JSON.stringify(
    cloneWorkerExecutionOfferJournalRecord(record),
  );
  if (
    Buffer.byteLength(serialized, 'utf8') >
    MAX_WORKER_EXECUTION_OFFER_RECORD_BYTES
  ) {
    invalid('journal record exceeds the byte limit');
  }
  return serialized;
}

export function parseWorkerExecutionOfferJournalRecord(
  value: Uint8Array | string,
): WorkerExecutionOfferJournalRecord {
  const bytes =
    typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
  if (
    bytes.length < 2 ||
    bytes.length > MAX_WORKER_EXECUTION_OFFER_RECORD_BYTES
  ) {
    invalid('serialized journal record size is outside the allowed range');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalid('serialized journal record is not valid JSON');
  }
  return cloneWorkerExecutionOfferJournalRecord(
    parsed as WorkerExecutionOfferJournalRecord,
  );
}
