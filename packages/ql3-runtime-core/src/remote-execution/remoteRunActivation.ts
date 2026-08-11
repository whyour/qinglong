import {
  assertRunDispatchId,
  assertRunDispatchLeaseFence,
} from '../run/runDispatchLease';
import type { RunAttemptStatus, RunStatus } from '../run/run';

export interface RemoteRunActivationFence {
  readonly runId: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly workerSessionId: string;
  readonly workerGeneration: number;
  readonly offerId: string;
  readonly leaseGeneration: number;
  /** Bearer capability. Persistence implementations must store only its digest. */
  readonly leaseToken: string;
  readonly expectedLeaseVersion: number;
}

export interface AcknowledgeRemoteRunStartingCommand
  extends RemoteRunActivationFence {
  readonly eventId: string;
}

export interface AcknowledgeRemoteRunRunningCommand
  extends RemoteRunActivationFence {
  readonly attemptEventId: string;
  readonly runEventId: string;
  readonly executorHandle: string;
  readonly logArtifactId?: string;
  /** Sequence bound to the completion callback capability kept by the Worker. */
  readonly callbackSequence: number;
  /** Lowercase SHA-256 digest. The raw callback capability never crosses storage. */
  readonly callbackTokenDigest: string;
}

export interface FailRemoteRunStartCommand extends RemoteRunActivationFence {
  readonly attemptEventId: string;
  readonly runEventId: string;
}

export type RemoteRunActivationStatus =
  | 'applied'
  | 'already_starting'
  | 'already_running'
  | 'already_terminal';

export interface RemoteRunActivationSnapshot {
  readonly runId: string;
  readonly attemptId: string;
  readonly runStatus: RunStatus;
  readonly attemptStatus: RunAttemptStatus;
  readonly leaseVersion: number;
  readonly leaseGeneration: number;
  readonly callbackSequence: number;
  /** Database-clock deadline durably bound when starting was acknowledged. */
  readonly deadlineAtMs?: number;
  readonly startedAtMs?: number;
  readonly finishedAtMs?: number;
  readonly executorHandle?: string;
  readonly logArtifactId?: string;
  readonly errorCode?: string;
}

export interface RemoteRunActivationResult {
  readonly status: RemoteRunActivationStatus;
  readonly snapshot: Readonly<RemoteRunActivationSnapshot>;
}

export interface RemoteRunActivationRepository {
  acknowledgeStarting(
    command: AcknowledgeRemoteRunStartingCommand,
  ): Promise<Readonly<RemoteRunActivationResult>>;
  acknowledgeRunning(
    command: AcknowledgeRemoteRunRunningCommand,
  ): Promise<Readonly<RemoteRunActivationResult>>;
  failStart(
    command: FailRemoteRunStartCommand,
  ): Promise<Readonly<RemoteRunActivationResult>>;
}

export type RemoteRunActivationFenceReason =
  | 'missing'
  | 'run_mismatch'
  | 'execution_owner_mismatch'
  | 'executor_mismatch'
  | 'attempt_state_mismatch'
  | 'run_state_mismatch'
  | 'worker_mismatch'
  | 'worker_session_mismatch'
  | 'worker_generation_mismatch'
  | 'lease_generation_mismatch'
  | 'lease_token_mismatch'
  | 'offer_mismatch'
  | 'version_mismatch'
  | 'lease_expired'
  | 'worker_unavailable'
  | 'replay_mismatch';

export class RemoteRunActivationFenceRejectedError extends Error {
  readonly code = 'REMOTE_RUN_ACTIVATION_FENCED';

  constructor(
    readonly attemptId: string,
    readonly reason: RemoteRunActivationFenceReason,
  ) {
    super(`Remote Run activation for Attempt ${attemptId} was fenced: ${reason}`);
    this.name = 'RemoteRunActivationFenceRejectedError';
  }
}

export class RemoteRunActivationUnavailableError extends Error {
  readonly code = 'REMOTE_RUN_ACTIVATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Remote Run activation storage is unavailable', options);
    this.name = 'RemoteRunActivationUnavailableError';
  }
}

function boundedId(name: string, value: string, maximum: number): void {
  assertRunDispatchId(name, value);
  if (value.length > maximum) {
    throw new TypeError(`Remote Run activation ${name} is invalid`);
  }
}

export function assertRemoteRunActivationFence(
  value: RemoteRunActivationFence,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Remote Run activation fence is invalid');
  }
  boundedId('runId', value.runId, 36);
  boundedId('attemptId', value.attemptId, 36);
  boundedId('offerId', value.offerId, 128);
  assertRunDispatchLeaseFence({
    workerId: value.workerId,
    workerSessionId: value.workerSessionId,
    workerGeneration: value.workerGeneration,
    leaseGeneration: value.leaseGeneration,
    leaseToken: value.leaseToken,
    expectedVersion: value.expectedLeaseVersion,
  });
  for (const number of [
    value.workerGeneration,
    value.leaseGeneration,
    value.expectedLeaseVersion,
  ]) {
    if (number > 2_147_483_647) {
      throw new RangeError('Remote Run activation fence version is invalid');
    }
  }
}

export function assertAcknowledgeRemoteRunStartingCommand(
  command: AcknowledgeRemoteRunStartingCommand,
): void {
  assertRemoteRunActivationFence(command);
  boundedId('eventId', command.eventId, 36);
}

export function assertAcknowledgeRemoteRunRunningCommand(
  command: AcknowledgeRemoteRunRunningCommand,
): void {
  assertRemoteRunActivationFence(command);
  boundedId('attemptEventId', command.attemptEventId, 36);
  boundedId('runEventId', command.runEventId, 36);
  if (
    typeof command.executorHandle !== 'string' ||
    command.executorHandle.length < 1 ||
    command.executorHandle.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(command.executorHandle)
  ) {
    throw new TypeError('Remote Run activation executorHandle is invalid');
  }
  if (command.logArtifactId !== undefined) {
    boundedId('logArtifactId', command.logArtifactId, 36);
  }
  if (
    !Number.isSafeInteger(command.callbackSequence) ||
    command.callbackSequence < 1 ||
    command.callbackSequence > 2_147_483_647
  ) {
    throw new RangeError('Remote Run activation callbackSequence is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(command.callbackTokenDigest)) {
    throw new TypeError('Remote Run activation callbackTokenDigest is invalid');
  }
}

export function assertFailRemoteRunStartCommand(
  command: FailRemoteRunStartCommand,
): void {
  assertRemoteRunActivationFence(command);
  boundedId('attemptEventId', command.attemptEventId, 36);
  boundedId('runEventId', command.runEventId, 36);
}
