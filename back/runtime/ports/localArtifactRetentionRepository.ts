import type {
  LocalArtifactRetentionCandidate,
  LocalArtifactRetentionCursor,
  LocalArtifactRetentionRecord,
} from '../domain/localArtifactRetention';

export const MAX_LOCAL_ARTIFACT_RETENTION_PAGE_SIZE = 64;

export interface LocalArtifactRetentionPage {
  candidates: readonly LocalArtifactRetentionCandidate[];
  truncated: boolean;
  nextCursor?: LocalArtifactRetentionCursor;
}

export interface LocalArtifactRetentionRepository {
  list(options: {
    cutoffMs: number;
    cursor?: LocalArtifactRetentionCursor;
    limit: number;
  }): Promise<LocalArtifactRetentionPage>;
  record(
    record: LocalArtifactRetentionRecord,
  ): Promise<'inserted' | 'existing'>;
}
