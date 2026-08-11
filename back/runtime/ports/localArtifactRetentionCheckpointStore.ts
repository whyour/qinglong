import type { LocalArtifactRetentionCursor } from '../domain/localArtifactRetention';
import type { LocalArtifactRetentionCheckpoint } from '../domain/localArtifactRetentionCheckpoint';

export interface LocalArtifactRetentionCheckpointStore {
  load(): Promise<Readonly<LocalArtifactRetentionCheckpoint>>;
  compareAndSet(value: {
    expectedVersion: number;
    cursor?: LocalArtifactRetentionCursor;
    updatedAtMs: number;
  }): Promise<boolean>;
}
