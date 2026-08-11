import { assertWorkerId, assertWorkerSessionId } from './worker';

export const RUN_DISPATCH_LEASE_STATUSES = [
  'leased',
  'released',
  'completed',
] as const;

export type RunDispatchLeaseStatus =
  (typeof RUN_DISPATCH_LEASE_STATUSES)[number];

export const RUN_DISPATCH_RELEASE_REASONS = [
  'declined',
  'shutdown',
  'start_failed',
  'capacity_changed',
  'lease_expired',
] as const;

export type RunDispatchReleaseReason =
  (typeof RUN_DISPATCH_RELEASE_REASONS)[number];

export const MIN_RUN_DISPATCH_LEASE_DURATION_MS = 5_000;
export const MAX_RUN_DISPATCH_LEASE_DURATION_MS = 10 * 60_000;

export interface RunDispatchLeaseRecord {
  attemptId: string;
  runId: string;
  status: RunDispatchLeaseStatus;
  version: number;
  leaseGeneration: number;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseToken: string;
  acquiredAtMs: number;
  renewedAtMs: number;
  expiresAtMs: number;
  releasedAtMs?: number;
  releaseReason?: RunDispatchReleaseReason;
  completedAtMs?: number;
  updatedAtMs: number;
}

export type RunDispatchLeaseFenceReason =
  | 'missing'
  | 'run_mismatch'
  | 'not_leased'
  | 'worker_mismatch'
  | 'worker_session_mismatch'
  | 'worker_generation_mismatch'
  | 'lease_generation_mismatch'
  | 'lease_token_mismatch'
  | 'version_mismatch'
  | 'lease_expired'
  | 'worker_unavailable';

export class InvalidRunDispatchLeaseValueError extends TypeError {
  constructor(message: string) {
    super(`Run dispatch lease value is invalid: ${message}`);
    this.name = 'InvalidRunDispatchLeaseValueError';
  }
}

export class RunDispatchLeaseFenceRejectedError extends Error {
  constructor(
    readonly attemptId: string,
    readonly reason: RunDispatchLeaseFenceReason,
  ) {
    super(`Run dispatch lease for Attempt ${attemptId} was fenced: ${reason}`);
    this.name = 'RunDispatchLeaseFenceRejectedError';
  }
}

export function assertRunDispatchId(name: string, value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidRunDispatchLeaseValueError(`${name} is invalid`);
  }
}

export function assertRunDispatchLeaseToken(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new InvalidRunDispatchLeaseValueError('leaseToken is invalid');
  }
}

export function assertRunDispatchLeaseVersion(
  name: string,
  value: number,
  positive = false,
): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new InvalidRunDispatchLeaseValueError(
      `${name} must be a ${
        positive ? 'positive' : 'non-negative'
      } safe integer`,
    );
  }
}

export function assertRunDispatchWorkerFence(value: {
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
}): void {
  assertWorkerId(value.workerId);
  assertWorkerSessionId(value.workerSessionId);
  assertRunDispatchLeaseVersion(
    'workerGeneration',
    value.workerGeneration,
    true,
  );
}

export function assertRunDispatchLeaseDuration(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_RUN_DISPATCH_LEASE_DURATION_MS ||
    value > MAX_RUN_DISPATCH_LEASE_DURATION_MS
  ) {
    throw new InvalidRunDispatchLeaseValueError(
      `leaseDurationMs must be between ${MIN_RUN_DISPATCH_LEASE_DURATION_MS} and ${MAX_RUN_DISPATCH_LEASE_DURATION_MS}`,
    );
  }
}

export function assertRunDispatchLeaseRecord(
  value: RunDispatchLeaseRecord,
): void {
  assertRunDispatchId('attemptId', value.attemptId);
  assertRunDispatchId('runId', value.runId);
  if (!RUN_DISPATCH_LEASE_STATUSES.includes(value.status)) {
    throw new InvalidRunDispatchLeaseValueError('status is invalid');
  }
  assertRunDispatchLeaseVersion('version', value.version);
  assertRunDispatchLeaseVersion('leaseGeneration', value.leaseGeneration, true);
  assertRunDispatchWorkerFence(value);
  assertRunDispatchLeaseToken(value.leaseToken);
  assertRunDispatchLeaseVersion('acquiredAtMs', value.acquiredAtMs);
  assertRunDispatchLeaseVersion('renewedAtMs', value.renewedAtMs);
  assertRunDispatchLeaseVersion('expiresAtMs', value.expiresAtMs);
  assertRunDispatchLeaseVersion('updatedAtMs', value.updatedAtMs);
  if (
    value.renewedAtMs < value.acquiredAtMs ||
    value.expiresAtMs <= value.renewedAtMs ||
    value.updatedAtMs < value.acquiredAtMs
  ) {
    throw new InvalidRunDispatchLeaseValueError('timestamps are inconsistent');
  }
  if (value.status === 'leased') {
    if (
      value.releasedAtMs !== undefined ||
      value.releaseReason !== undefined ||
      value.completedAtMs !== undefined
    ) {
      throw new InvalidRunDispatchLeaseValueError(
        'active lease has terminal metadata',
      );
    }
    return;
  }
  if (value.status === 'released') {
    if (
      value.releasedAtMs === undefined ||
      value.completedAtMs !== undefined ||
      value.releaseReason === undefined ||
      !RUN_DISPATCH_RELEASE_REASONS.includes(value.releaseReason)
    ) {
      throw new InvalidRunDispatchLeaseValueError(
        'released lease metadata is inconsistent',
      );
    }
    assertRunDispatchLeaseVersion('releasedAtMs', value.releasedAtMs);
    return;
  }
  if (
    value.completedAtMs === undefined ||
    value.releasedAtMs !== undefined ||
    value.releaseReason !== undefined
  ) {
    throw new InvalidRunDispatchLeaseValueError(
      'completed lease metadata is inconsistent',
    );
  }
  assertRunDispatchLeaseVersion('completedAtMs', value.completedAtMs);
}

export function runDispatchLeaseExpiration(
  nowMs: number,
  durationMs: number,
): number {
  assertRunDispatchLeaseVersion('nowMs', nowMs);
  assertRunDispatchLeaseDuration(durationMs);
  if (nowMs > Number.MAX_SAFE_INTEGER - durationMs) {
    throw new InvalidRunDispatchLeaseValueError(
      'lease expiration exceeds the safe integer range',
    );
  }
  return nowMs + durationMs;
}
