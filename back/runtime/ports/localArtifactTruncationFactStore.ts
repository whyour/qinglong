import type { LocalArtifactTruncationFact } from '../domain/localArtifactTruncation';

export interface LocalArtifactTruncationFactStore {
  read(
    logArtifactId: string,
  ): Promise<Readonly<LocalArtifactTruncationFact> | null>;
}
