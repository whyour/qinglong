import type { RunDispatchLeaseRecord } from '../domain/runDispatchLease';
import type { RunEventRecord } from '../domain/run';
import type { RunRepositoryTransaction } from './runRepository';

export interface ClaimRunDispatchLeaseCommand {
  runId: string;
  attemptId: string;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseToken: string;
  nowMs: number;
  leaseDurationMs: number;
  eventId: string;
}

export type ClaimRunDispatchLeaseResult =
  | {
      status: 'claimed';
      lease: RunDispatchLeaseRecord;
      event: RunEventRecord;
    }
  | { status: 'idempotent' | 'leased'; lease: RunDispatchLeaseRecord }
  | {
      status: 'not_eligible' | 'worker_unavailable' | 'capacity_exhausted';
    };

export interface RenewRunDispatchLeaseCommand {
  attemptId: string;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseGeneration: number;
  leaseToken: string;
  expectedVersion: number;
  nowMs: number;
  leaseDurationMs: number;
}

export interface ReleaseRunDispatchLeaseCommand {
  runId: string;
  attemptId: string;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseGeneration: number;
  leaseToken: string;
  expectedVersion: number;
  reason: 'declined' | 'shutdown' | 'start_failed' | 'capacity_changed';
  nowMs: number;
  eventId: string;
}

export interface ReleaseRunDispatchLeaseResult {
  lease: RunDispatchLeaseRecord;
  event?: RunEventRecord;
}

export interface CompleteWithRunDispatchLeaseCommand {
  runId: string;
  attemptId: string;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseGeneration: number;
  leaseToken: string;
  expectedVersion: number;
  completedAtMs: number;
}

export interface ExpireRunDispatchLeaseCommand {
  runId: string;
  attemptId: string;
  observedAtMs: number;
}

export interface UseRunDispatchLeaseCommand {
  runId: string;
  attemptId: string;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseGeneration: number;
  leaseToken: string;
  expectedVersion: number;
  observedAtMs: number;
}

export interface UseRunDispatchLeaseResult<T> {
  value: T;
  lease: RunDispatchLeaseRecord;
}

export interface CompleteWithRunDispatchLeaseResult<T> {
  value: T;
  lease: RunDispatchLeaseRecord;
}

export type ExpireRunDispatchLeaseResult<T> =
  | { status: 'expired'; value: T; lease: RunDispatchLeaseRecord }
  | { status: 'already_expired'; lease: RunDispatchLeaseRecord }
  | {
      status: 'not_found' | 'not_due' | 'not_eligible';
      lease?: RunDispatchLeaseRecord;
    };

export interface RunDispatchLeaseRepository {
  findByAttemptId(attemptId: string): Promise<RunDispatchLeaseRecord | null>;
  claim(
    command: ClaimRunDispatchLeaseCommand,
  ): Promise<ClaimRunDispatchLeaseResult>;
  renew(command: RenewRunDispatchLeaseCommand): Promise<RunDispatchLeaseRecord>;
  release(
    command: ReleaseRunDispatchLeaseCommand,
  ): Promise<ReleaseRunDispatchLeaseResult>;
  withLease<T>(
    command: UseRunDispatchLeaseCommand,
    work: (
      transaction: RunRepositoryTransaction,
      lease: RunDispatchLeaseRecord,
    ) => Promise<T>,
  ): Promise<UseRunDispatchLeaseResult<T>>;
  completeWithLease<T>(
    command: CompleteWithRunDispatchLeaseCommand,
    work: (
      transaction: RunRepositoryTransaction,
      lease: RunDispatchLeaseRecord,
    ) => Promise<T>,
  ): Promise<CompleteWithRunDispatchLeaseResult<T>>;
  expireWithLease<T>(
    command: ExpireRunDispatchLeaseCommand,
    work: (
      transaction: RunRepositoryTransaction,
      lease: RunDispatchLeaseRecord,
    ) => Promise<T>,
  ): Promise<ExpireRunDispatchLeaseResult<T>>;
}
