// Remote Execution owns the durable offer inbox authority and transition contract.
import type { ClusterRemoteExecutionOffer } from '@qinglong/runtime-core/remote-dispatch';
import { createClusterRemoteExecutionOffer } from '@qinglong/runtime-core/remote-dispatch';

export const WORKER_REMOTE_EXECUTION_INBOX_STATES = [
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

export type WorkerRemoteExecutionInboxState =
  (typeof WORKER_REMOTE_EXECUTION_INBOX_STATES)[number];

export type WorkerRemoteExecutionRecoveryReason =
  | 'launch_outcome_unknown'
  | 'control_plane_already_running'
  | 'control_plane_terminal'
  | 'lease_lost_local_execution_stopped'
  | 'lease_lost_local_execution_unverified';

export interface WorkerRemoteExecutionInboxRecord {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly state: WorkerRemoteExecutionInboxState;
  readonly offer: ClusterRemoteExecutionOffer;
  readonly acceptedAtMs: number;
  readonly updatedAtMs: number;
  readonly executorHandle?: string;
  readonly executorStartedAtMs?: number;
  readonly logArtifactId?: string;
  readonly completionReceiptCallbackSequence?: number;
  readonly completionReceiptTokenDigest?: string;
  readonly completionAcknowledgedAtMs?: number;
  readonly recoveryReason?: WorkerRemoteExecutionRecoveryReason;
}

export interface WorkerRemoteExecutionInboxPage {
  readonly records: readonly WorkerRemoteExecutionInboxRecord[];
  readonly nextAfterOfferId?: string;
}

export interface WorkerRemoteExecutionInbox {
  readOffer(offerId: string): Promise<WorkerRemoteExecutionInboxRecord | undefined>;
  replaceOffer(
    record: WorkerRemoteExecutionInboxRecord,
    expectedRevision: number,
  ): Promise<void>;
  listOffers(options?: Readonly<{
    afterOfferId?: string;
    limit?: number;
  }>): Promise<WorkerRemoteExecutionInboxPage>;
}

export class WorkerRemoteExecutionInboxError extends Error {
  constructor(
    readonly reason:
      | 'invalid_record'
      | 'authority_conflict'
      | 'revision_conflict'
      | 'invalid_transition',
  ) {
    super(`Worker remote execution inbox failed: ${reason}`);
    this.name = 'WorkerRemoteExecutionInboxError';
  }
}

const STATES = new Set<string>(WORKER_REMOTE_EXECUTION_INBOX_STATES);
const SHA256 = /^[a-f0-9]{64}$/;
const RECOVERY_REASONS = new Set<string>([
  'launch_outcome_unknown',
  'control_plane_already_running',
  'control_plane_terminal',
  'lease_lost_local_execution_stopped',
  'lease_lost_local_execution_unverified',
]);
const OPTIONAL_FIELDS = [
  'executorHandle',
  'executorStartedAtMs',
  'logArtifactId',
  'completionReceiptCallbackSequence',
  'completionReceiptTokenDigest',
  'completionAcknowledgedAtMs',
  'recoveryReason',
] as const;
const BASE_FIELDS = [
  'schemaVersion',
  'revision',
  'state',
  'offer',
  'acceptedAtMs',
  'updatedAtMs',
] as const;

function invalid(): never {
  throw new WorkerRemoteExecutionInboxError('invalid_record');
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid();
  }
  return value;
}

function sameOfferAuthority(
  left: ClusterRemoteExecutionOffer,
  right: ClusterRemoteExecutionOffer,
): boolean {
  const first = createClusterRemoteExecutionOffer(left);
  const second = createClusterRemoteExecutionOffer(right);
  return (
    first.offerId === second.offerId &&
    first.executionDigest === second.executionDigest &&
    first.deliveryKind === second.deliveryKind &&
    JSON.stringify(first.candidate) === JSON.stringify(second.candidate) &&
    JSON.stringify(first.worker) === JSON.stringify(second.worker) &&
    first.lease.runId === second.lease.runId &&
    first.lease.attemptId === second.lease.attemptId &&
    first.lease.workerId === second.lease.workerId &&
    first.lease.workerSessionId === second.lease.workerSessionId &&
    first.lease.workerGeneration === second.lease.workerGeneration &&
    first.lease.leaseGeneration === second.lease.leaseGeneration &&
    first.lease.leaseTokenDigest === second.lease.leaseTokenDigest &&
    first.leaseToken === second.leaseToken &&
    JSON.stringify(first.executionRevision) ===
      JSON.stringify(second.executionRevision)
  );
}

function exactOptional<T extends keyof WorkerRemoteExecutionInboxRecord>(
  value: WorkerRemoteExecutionInboxRecord,
  key: T,
): WorkerRemoteExecutionInboxRecord[T] | undefined {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

export function normalizeWorkerRemoteExecutionInboxRecord(
  value: WorkerRemoteExecutionInboxRecord,
): WorkerRemoteExecutionInboxRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const allowed = new Set<string>([...BASE_FIELDS, ...OPTIONAL_FIELDS]);
  const keys = Object.keys(value);
  if (
    value.schemaVersion !== 1 ||
    BASE_FIELDS.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key)) ||
    !STATES.has(value.state)
  ) {
    invalid();
  }
  const revision = safeInteger(value.revision);
  const acceptedAtMs = safeInteger(value.acceptedAtMs);
  const updatedAtMs = safeInteger(value.updatedAtMs);
  if (updatedAtMs < acceptedAtMs) invalid();
  const offer = createClusterRemoteExecutionOffer(value.offer);

  const executorHandle = exactOptional(value, 'executorHandle');
  const executorStartedAtMs = exactOptional(value, 'executorStartedAtMs');
  const logArtifactId = exactOptional(value, 'logArtifactId');
  const callbackSequence = exactOptional(
    value,
    'completionReceiptCallbackSequence',
  );
  const tokenDigest = exactOptional(value, 'completionReceiptTokenDigest');
  const completionAcknowledgedAtMs = exactOptional(
    value,
    'completionAcknowledgedAtMs',
  );
  const recoveryReason = exactOptional(value, 'recoveryReason');

  if (executorHandle !== undefined && executorStartedAtMs === undefined) invalid();
  if (executorHandle !== undefined) boundedText(executorHandle, 512);
  if (executorStartedAtMs !== undefined) safeInteger(executorStartedAtMs);
  if (logArtifactId !== undefined) boundedText(logArtifactId, 36);
  if ((callbackSequence === undefined) !== (tokenDigest === undefined)) invalid();
  if (
    callbackSequence !== undefined &&
    (safeInteger(callbackSequence) < 1 || callbackSequence > 2_147_483_647)
  ) {
    invalid();
  }
  if (tokenDigest !== undefined && !SHA256.test(tokenDigest)) invalid();
  if (completionAcknowledgedAtMs !== undefined) {
    safeInteger(completionAcknowledgedAtMs);
  }
  if (
    recoveryReason !== undefined &&
    !RECOVERY_REASONS.has(recoveryReason)
  ) {
    invalid();
  }

  const hasExecutor = executorHandle !== undefined;
  const hasExecutorStartedAt = executorStartedAtMs !== undefined;
  const hasLogArtifact = logArtifactId !== undefined;
  const hasReceiptAuthentication = callbackSequence !== undefined;
  const executorRequired = [
    'started',
    'running_acknowledged',
  ].includes(value.state);
  const executorStartedAtRequired = [
    'launching',
    'started',
    'running_acknowledged',
    'completion_acknowledged',
  ].includes(value.state);
  const executorStartedAtOptional = [
    'start_failed',
    'start_failure_acknowledged',
    'recovery_required',
  ].includes(value.state);
  const receiptAuthenticationRequired = [
    'launching',
    'started',
    'running_acknowledged',
    'completion_acknowledged',
  ].includes(value.state);
  const receiptAuthenticationOptional = [
    'start_failed',
    'start_failure_acknowledged',
    'recovery_required',
  ].includes(value.state);
  const logArtifactRequired = [
    'launching',
    'started',
    'running_acknowledged',
    'completion_acknowledged',
  ].includes(value.state);
  if (
    (!['completion_acknowledged', 'recovery_required'].includes(value.state) &&
      executorRequired !== hasExecutor) ||
    (!executorStartedAtOptional &&
      executorStartedAtRequired !== hasExecutorStartedAt) ||
    (hasExecutor &&
      !['started', 'running_acknowledged', 'completion_acknowledged', 'recovery_required']
        .includes(value.state)) ||
    (hasExecutorStartedAt &&
      !['launching', 'started', 'running_acknowledged', 'start_failed',
        'start_failure_acknowledged', 'completion_acknowledged',
        'recovery_required'].includes(value.state)) ||
    (!receiptAuthenticationOptional &&
      receiptAuthenticationRequired !== hasReceiptAuthentication) ||
    (hasReceiptAuthentication &&
      !['launching', 'started', 'running_acknowledged', 'start_failed',
        'start_failure_acknowledged', 'completion_acknowledged',
        'recovery_required'].includes(value.state)) ||
    (logArtifactRequired && !hasLogArtifact) ||
    (hasLogArtifact && ['accepted', 'starting_acknowledged'].includes(value.state))
  ) {
    invalid();
  }
  if (
    completionAcknowledgedAtMs !== undefined !==
      (value.state === 'completion_acknowledged') ||
    recoveryReason !== undefined !== (value.state === 'recovery_required')
  ) {
    invalid();
  }

  return Object.freeze({
    schemaVersion: 1,
    revision,
    state: value.state,
    offer,
    acceptedAtMs,
    updatedAtMs,
    ...(executorHandle === undefined ? {} : { executorHandle }),
    ...(executorStartedAtMs === undefined ? {} : { executorStartedAtMs }),
    ...(logArtifactId === undefined ? {} : { logArtifactId }),
    ...(callbackSequence === undefined
      ? {}
      : { completionReceiptCallbackSequence: callbackSequence }),
    ...(tokenDigest === undefined
      ? {}
      : { completionReceiptTokenDigest: tokenDigest }),
    ...(completionAcknowledgedAtMs === undefined
      ? {}
      : { completionAcknowledgedAtMs }),
    ...(recoveryReason === undefined ? {} : { recoveryReason }),
  });
}

export function createWorkerRemoteExecutionInboxRecord(
  offer: ClusterRemoteExecutionOffer,
  acceptedAtMs: number,
): WorkerRemoteExecutionInboxRecord {
  return normalizeWorkerRemoteExecutionInboxRecord({
    schemaVersion: 1,
    revision: 0,
    state: 'accepted',
    offer,
    acceptedAtMs,
    updatedAtMs: acceptedAtMs,
  });
}

function transitions(
  ...states: WorkerRemoteExecutionInboxState[]
): ReadonlySet<WorkerRemoteExecutionInboxState> {
  return new Set(states);
}

const TRANSITIONS: Readonly<Record<
  WorkerRemoteExecutionInboxState,
  ReadonlySet<WorkerRemoteExecutionInboxState>
>> = Object.freeze({
  accepted: transitions('accepted', 'starting_acknowledged', 'recovery_required'),
  starting_acknowledged: transitions(
    'starting_acknowledged', 'launching', 'start_failed', 'recovery_required',
  ),
  launching: transitions(
    'launching', 'started', 'start_failed', 'completion_acknowledged',
    'recovery_required',
  ),
  started: transitions(
    'started', 'running_acknowledged', 'completion_acknowledged',
    'recovery_required',
  ),
  running_acknowledged: transitions(
    'running_acknowledged', 'completion_acknowledged', 'recovery_required',
  ),
  start_failed: transitions(
    'start_failed', 'start_failure_acknowledged', 'recovery_required',
  ),
  start_failure_acknowledged: transitions('start_failure_acknowledged'),
  completion_acknowledged: transitions('completion_acknowledged'),
  recovery_required: transitions('recovery_required', 'completion_acknowledged'),
});

export function assertWorkerRemoteExecutionInboxTransition(
  previousValue: WorkerRemoteExecutionInboxRecord,
  nextValue: WorkerRemoteExecutionInboxRecord,
): void {
  const previous = normalizeWorkerRemoteExecutionInboxRecord(previousValue);
  const next = normalizeWorkerRemoteExecutionInboxRecord(nextValue);
  if (!sameOfferAuthority(previous.offer, next.offer)) {
    throw new WorkerRemoteExecutionInboxError('authority_conflict');
  }
  if (
    next.revision !== previous.revision + 1 ||
    next.acceptedAtMs !== previous.acceptedAtMs ||
    next.updatedAtMs < previous.updatedAtMs ||
    next.offer.lease.version < previous.offer.lease.version ||
    (next.offer.lease.version === previous.offer.lease.version &&
      JSON.stringify(next.offer.lease) !== JSON.stringify(previous.offer.lease))
  ) {
    throw new WorkerRemoteExecutionInboxError('revision_conflict');
  }
  if (!TRANSITIONS[previous.state].has(next.state)) {
    throw new WorkerRemoteExecutionInboxError('invalid_transition');
  }
  for (const key of OPTIONAL_FIELDS) {
    const before = exactOptional(previous, key);
    const after = exactOptional(next, key);
    if (
      key === 'recoveryReason' &&
      next.state === 'completion_acknowledged'
    ) continue;
    if (before !== undefined && before !== after) {
      throw new WorkerRemoteExecutionInboxError('invalid_transition');
    }
  }
}
