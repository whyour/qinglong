import type { LocalArtifactReadMetadata } from '../domain/artifactRead';

export interface LocalArtifactReadMetadataRepository {
  find(input: {
    projectId: string;
    runId: string;
    logArtifactId: string;
  }): Promise<Readonly<LocalArtifactReadMetadata> | null>;
}
