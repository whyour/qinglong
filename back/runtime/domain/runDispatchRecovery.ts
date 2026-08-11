import {
  assertRunDispatchCandidate,
  assertRunDispatchCandidatePageSize,
  type RunDispatchCandidate,
} from './runDispatchCandidate';
import {
  assertRunDispatchId,
  assertRunDispatchLeaseRecord,
  assertRunDispatchLeaseVersion,
  type RunDispatchLeaseRecord,
} from './runDispatchLease';

export const MAX_RUN_DISPATCH_RECOVERY_PAGE_SIZE = 64;

export interface RunDispatchRecoveryCursor {
  expiresAtMs: number;
  attemptId: string;
}

export interface RecoverableRunDispatch {
  candidate: RunDispatchCandidate;
  lease: RunDispatchLeaseRecord;
}

export function assertRunDispatchRecoveryCursor(
  cursor: RunDispatchRecoveryCursor,
): void {
  assertRunDispatchLeaseVersion('expiresAtMs', cursor.expiresAtMs);
  assertRunDispatchId('attemptId', cursor.attemptId);
}

export function assertRecoverableRunDispatch(
  recovery: RecoverableRunDispatch,
): void {
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) {
    throw new TypeError('Recoverable Run dispatch must be an object');
  }
  assertRunDispatchCandidate(recovery.candidate);
  assertRunDispatchLeaseRecord(recovery.lease);
  if (
    recovery.lease.status !== 'leased' ||
    recovery.lease.runId !== recovery.candidate.runId ||
    recovery.lease.attemptId !== recovery.candidate.attemptId
  ) {
    throw new TypeError(
      'Recoverable Run dispatch candidate and active lease do not match',
    );
  }
}

export function assertRunDispatchRecoveryPageSize(limit: number): void {
  assertRunDispatchCandidatePageSize(limit);
  if (limit > MAX_RUN_DISPATCH_RECOVERY_PAGE_SIZE) {
    throw new RangeError(
      `Run dispatch recovery page size must not exceed ${MAX_RUN_DISPATCH_RECOVERY_PAGE_SIZE}`,
    );
  }
}
