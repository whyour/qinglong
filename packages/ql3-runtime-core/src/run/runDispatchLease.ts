import { createHash } from 'node:crypto';
import {
  assertWorkerId,
  assertWorkerSessionId,
} from '../worker/workerSession';

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
  readonly attemptId: string;
  readonly runId: string;
  readonly status: RunDispatchLeaseStatus;
  readonly version: number;
  readonly leaseGeneration: number;
  readonly workerId: string;
  readonly workerSessionId: string;
  readonly workerGeneration: number;
  /** The database never persists or returns the bearer lease token. */
  readonly leaseTokenDigest: string;
  readonly acquiredAtMs: number;
  readonly renewedAtMs: number;
  readonly expiresAtMs: number;
  readonly releasedAtMs?: number;
  readonly releaseReason?: RunDispatchReleaseReason;
  readonly completedAtMs?: number;
  readonly updatedAtMs: number;
}

export class InvalidRunDispatchLeaseValueError extends TypeError {
  constructor(message: string) {
    super(`Run dispatch lease value is invalid: ${message}`);
    this.name = 'InvalidRunDispatchLeaseValueError';
  }
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

export class RunDispatchLeaseFenceRejectedError extends Error {
  constructor(
    readonly attemptId: string,
    readonly reason: RunDispatchLeaseFenceReason,
  ) {
    super(`Run dispatch lease for Attempt ${attemptId} was fenced: ${reason}`);
    this.name = 'RunDispatchLeaseFenceRejectedError';
  }
}

function invalid(message: string): never {
  throw new InvalidRunDispatchLeaseValueError(message);
}

export function assertRunDispatchId(name: string, value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(`${name} is invalid`);
  }
}

export function assertRunDispatchLeaseToken(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    invalid('leaseToken is invalid');
  }
}

export function digestRunDispatchLeaseToken(value: string): string {
  assertRunDispatchLeaseToken(value);
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function assertRunDispatchLeaseDuration(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_RUN_DISPATCH_LEASE_DURATION_MS ||
    value > MAX_RUN_DISPATCH_LEASE_DURATION_MS
  ) {
    invalid(
      `leaseDurationMs must be between ${MIN_RUN_DISPATCH_LEASE_DURATION_MS} and ${MAX_RUN_DISPATCH_LEASE_DURATION_MS}`,
    );
  }
}

export function assertRunDispatchLeaseFence(value: {
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseGeneration: number;
  leaseToken: string;
  expectedVersion: number;
}): void {
  assertWorkerId(value.workerId);
  assertWorkerSessionId(value.workerSessionId);
  for (const [name, number, minimum] of [
    ['workerGeneration', value.workerGeneration, 1],
    ['leaseGeneration', value.leaseGeneration, 1],
    ['expectedVersion', value.expectedVersion, 0],
  ] as const) {
    if (!Number.isSafeInteger(number) || number < minimum) invalid(`${name} is invalid`);
  }
  assertRunDispatchLeaseToken(value.leaseToken);
}

export function assertRunDispatchLeaseRecord(
  value: RunDispatchLeaseRecord,
): void {
  assertRunDispatchId('attemptId', value.attemptId);
  assertRunDispatchId('runId', value.runId);
  if (!RUN_DISPATCH_LEASE_STATUSES.includes(value.status)) invalid('status is invalid');
  assertWorkerId(value.workerId);
  assertWorkerSessionId(value.workerSessionId);
  if (!/^[0-9a-f]{64}$/.test(value.leaseTokenDigest)) {
    invalid('leaseTokenDigest is invalid');
  }
  for (const [name, number, minimum] of [
    ['version', value.version, 0],
    ['leaseGeneration', value.leaseGeneration, 1],
    ['workerGeneration', value.workerGeneration, 1],
    ['acquiredAtMs', value.acquiredAtMs, 0],
    ['renewedAtMs', value.renewedAtMs, 0],
    ['expiresAtMs', value.expiresAtMs, 0],
    ['updatedAtMs', value.updatedAtMs, 0],
  ] as const) {
    if (!Number.isSafeInteger(number) || number < minimum) invalid(`${name} is invalid`);
  }
  if (
    value.renewedAtMs < value.acquiredAtMs ||
    value.expiresAtMs <= value.renewedAtMs ||
    value.updatedAtMs < value.acquiredAtMs
  ) {
    invalid('timestamps are inconsistent');
  }
  if (value.status === 'leased') {
    if (
      value.releasedAtMs !== undefined ||
      value.releaseReason !== undefined ||
      value.completedAtMs !== undefined
    ) invalid('active lease has terminal metadata');
    return;
  }
  if (value.status === 'released') {
    if (
      value.releasedAtMs === undefined ||
      value.releaseReason === undefined ||
      !RUN_DISPATCH_RELEASE_REASONS.includes(value.releaseReason) ||
      value.completedAtMs !== undefined
    ) invalid('released lease metadata is inconsistent');
    return;
  }
  if (
    value.completedAtMs === undefined ||
    value.releasedAtMs !== undefined ||
    value.releaseReason !== undefined
  ) invalid('completed lease metadata is inconsistent');
}

export interface ClaimRunDispatchLeaseCommand {
  readonly runId: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly workerSessionId: string;
  readonly workerGeneration: number;
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
  readonly eventId: string;
  readonly offerId: string;
}

export type ClaimRunDispatchLeaseResult =
  | { readonly status: 'claimed'; readonly lease: RunDispatchLeaseRecord }
  | { readonly status: 'idempotent' | 'leased'; readonly lease: RunDispatchLeaseRecord }
  | { readonly status: 'not_eligible' | 'worker_unavailable' | 'capacity_exhausted' };

export interface RenewRunDispatchLeaseCommand {
  readonly attemptId: string;
  readonly workerId: string;
  readonly workerSessionId: string;
  readonly workerGeneration: number;
  readonly leaseGeneration: number;
  readonly leaseToken: string;
  readonly expectedVersion: number;
  readonly leaseDurationMs: number;
}

export interface ReleaseRunDispatchLeaseCommand {
  readonly runId: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly workerSessionId: string;
  readonly workerGeneration: number;
  readonly leaseGeneration: number;
  readonly leaseToken: string;
  readonly expectedVersion: number;
  readonly reason: Exclude<RunDispatchReleaseReason, 'lease_expired'>;
  readonly eventId: string;
}

export interface RunDispatchLeaseRepository {
  findByAttemptId(attemptId: string): Promise<RunDispatchLeaseRecord | null>;
  claim(command: ClaimRunDispatchLeaseCommand): Promise<ClaimRunDispatchLeaseResult>;
  renew(command: RenewRunDispatchLeaseCommand): Promise<RunDispatchLeaseRecord>;
  release(command: ReleaseRunDispatchLeaseCommand): Promise<RunDispatchLeaseRecord>;
}
