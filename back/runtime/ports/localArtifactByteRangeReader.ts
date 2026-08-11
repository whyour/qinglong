import type { LocalArtifactReadRange } from '../domain/artifactRead';

export interface AvailableLocalArtifactByteRange {
  status: 'available';
  content: Buffer;
  start: number;
  endExclusive: number;
  totalBytes: number;
  nextOffset?: number;
}

export type LocalArtifactByteRangeReadResult =
  | AvailableLocalArtifactByteRange
  | { status: 'missing' };

export interface LocalArtifactByteRangeReader {
  read(
    logArtifactId: string,
    range: Readonly<LocalArtifactReadRange>,
  ): Promise<LocalArtifactByteRangeReadResult>;
}
