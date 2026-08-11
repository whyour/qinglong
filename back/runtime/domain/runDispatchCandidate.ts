import {
  assertRunDispatchId,
  assertRunDispatchLeaseVersion,
} from './runDispatchLease';

export const MAX_RUN_DISPATCH_CANDIDATE_PAGE_SIZE = 64;

export interface RunDispatchCandidateCursor {
  priority: number;
  queuedAtMs: number;
  attemptCreatedAtMs: number;
  attemptId: string;
}

export interface RunDispatchCandidate extends RunDispatchCandidateCursor {
  runId: string;
  projectId: string;
  taskId: string;
  taskRevision: string;
  executorType: string;
}

function assertPriority(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      'Run dispatch candidate priority must be a safe integer',
    );
  }
}

function assertExecutorType(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError('Run dispatch candidate executorType is invalid');
  }
}

export function assertRunDispatchCandidateCursor(
  cursor: RunDispatchCandidateCursor,
): void {
  assertPriority(cursor.priority);
  assertRunDispatchLeaseVersion('queuedAtMs', cursor.queuedAtMs);
  assertRunDispatchLeaseVersion(
    'attemptCreatedAtMs',
    cursor.attemptCreatedAtMs,
  );
  assertRunDispatchId('attemptId', cursor.attemptId);
}

export function assertRunDispatchCandidate(
  candidate: RunDispatchCandidate,
): void {
  assertRunDispatchCandidateCursor(candidate);
  assertRunDispatchId('runId', candidate.runId);
  assertRunDispatchId('projectId', candidate.projectId);
  assertRunDispatchId('taskId', candidate.taskId);
  assertRunDispatchId('taskRevision', candidate.taskRevision);
  assertExecutorType(candidate.executorType);
}

export function assertRunDispatchCandidatePageSize(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_RUN_DISPATCH_CANDIDATE_PAGE_SIZE
  ) {
    throw new RangeError(
      `Run dispatch candidate page size must be between 1 and ${MAX_RUN_DISPATCH_CANDIDATE_PAGE_SIZE}`,
    );
  }
}
