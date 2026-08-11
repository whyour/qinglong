export const MAX_RUN_LOST_RETRY_PAGE_SIZE = 64;

export interface RunLostRetryCandidate {
  runId: string;
  phase: 'lost' | 'retry_wait';
  availableAtMs: number;
}

export interface ListRunLostRetryCandidatesOptions {
  observedAtMs: number;
  limit?: number;
}

export interface RunLostRetrySource {
  listCandidates(
    options: ListRunLostRetryCandidatesOptions,
  ): Promise<readonly RunLostRetryCandidate[]>;
}
