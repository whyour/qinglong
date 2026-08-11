export interface LocalArtifactFileRetirementResult {
  disposition: 'deleted' | 'already_absent';
  bytesReclaimed: number;
}

export interface LocalArtifactFileRetirementStore {
  retire(logArtifactId: string): Promise<LocalArtifactFileRetirementResult>;
}
