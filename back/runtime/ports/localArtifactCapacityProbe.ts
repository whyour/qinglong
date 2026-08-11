export interface LocalArtifactCapacitySnapshot {
  availableBytes: bigint;
  totalBytes: bigint;
}

export interface LocalArtifactCapacityProbe {
  inspect(root: string): Promise<LocalArtifactCapacitySnapshot>;
}

export interface LocalArtifactCapacitySource {
  inspect(): Promise<LocalArtifactCapacitySnapshot>;
}
