import type {
  RunDispatchCandidate,
  RunDispatchCandidateCursor,
} from '../domain/runDispatchCandidate';

export interface ListRunDispatchCandidatesOptions {
  observedAtMs: number;
  after?: RunDispatchCandidateCursor;
  limit?: number;
}

export interface RunDispatchCandidateSource {
  listCandidates(
    options: ListRunDispatchCandidatesOptions,
  ): Promise<RunDispatchCandidate[]>;
}
