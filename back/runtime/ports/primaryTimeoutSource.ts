export const MAX_PRIMARY_TIMEOUT_BATCH_SIZE = 64;

export interface PrimaryTimeoutCursor {
  deadlineAtMs: number;
  attemptId: string;
}

export interface PrimaryTimeoutCandidate {
  runId: string;
  attemptId: string;
  deadlineAtMs: number;
}

export interface PrimaryTimeoutPage {
  candidates: readonly PrimaryTimeoutCandidate[];
  truncated: boolean;
  nextCursor?: PrimaryTimeoutCursor;
}

export interface PrimaryTimeoutSource {
  listOverdue(options: {
    nowMs: number;
    cursor?: PrimaryTimeoutCursor;
    limit?: number;
  }): Promise<PrimaryTimeoutPage>;
}
