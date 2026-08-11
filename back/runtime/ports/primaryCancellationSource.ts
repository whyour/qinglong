import type { ExecutionStopKind, ExecutorType } from '../domain/execution';

export const MAX_PRIMARY_CANCELLATION_BATCH_SIZE = 64;

export interface PrimaryCancellationCursor {
  requestedAtMs: number;
  runId: string;
}

export interface PrimaryCancellationAttemptReference {
  attemptId: string;
  executorType: ExecutorType;
  executorHandle?: string;
  pid?: number;
}

export interface PrimaryCancellationCandidate {
  runId: string;
  requestedAtMs: number;
  reason: ExecutionStopKind;
  attempts: readonly PrimaryCancellationAttemptReference[];
}

export interface PrimaryCancellationPage {
  candidates: readonly PrimaryCancellationCandidate[];
  truncated: boolean;
  unsafeAttemptOverflow: boolean;
  nextCursor?: PrimaryCancellationCursor;
}

export interface PrimaryCancellationSource {
  listCandidates(options?: {
    cursor?: PrimaryCancellationCursor;
    limit?: number;
  }): Promise<PrimaryCancellationPage>;
}
