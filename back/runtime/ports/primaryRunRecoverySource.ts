import type { ExecutorType } from '../domain/execution';

export const MAX_PRIMARY_RECOVERY_BATCH_SIZE = 64;

export interface PrimaryRunRecoveryCursor {
  createdAtMs: number;
  runId: string;
}

export interface PrimaryRunRecoveryAttemptReference {
  attemptId: string;
  executorType: ExecutorType;
}

export interface PrimaryRunRecoveryCandidate {
  runId: string;
  attempts: readonly PrimaryRunRecoveryAttemptReference[];
}

export interface PrimaryRunRecoveryPage {
  candidates: readonly PrimaryRunRecoveryCandidate[];
  truncated: boolean;
  unsafeAttemptOverflow: boolean;
  nextCursor?: PrimaryRunRecoveryCursor;
}

export interface PrimaryRunRecoverySource {
  listCandidates(options?: {
    cursor?: PrimaryRunRecoveryCursor;
    limit?: number;
  }): Promise<PrimaryRunRecoveryPage>;
}
