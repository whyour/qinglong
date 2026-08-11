export const CANCELLATION_DISPATCH_STATUSES = [
  'pending',
  'leased',
  'retry_wait',
  'dispatched',
  'blocked',
] as const;

export type CancellationDispatchStatus =
  (typeof CANCELLATION_DISPATCH_STATUSES)[number];

export const CANCELLATION_DISPATCH_RESULTS = [
  'termination_requested',
  'already_exited',
  'identity_mismatch',
  'pid_mismatch',
  'unsupported',
  'invalid',
  'controller_missing',
  'handle_missing',
  'dispatch_error',
] as const;

export type CancellationDispatchResult =
  (typeof CANCELLATION_DISPATCH_RESULTS)[number];

export interface CancellationDispatchRecord {
  runId: string;
  attemptId: string;
  status: CancellationDispatchStatus;
  version: number;
  dispatchCount: number;
  nextAttemptAtMs?: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAtMs?: number;
  lastResult?: CancellationDispatchResult;
  lastDispatchedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}
