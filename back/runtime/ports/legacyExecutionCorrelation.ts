export interface LegacyExecutionSelector {
  legacyCronId: number;
  pid?: number;
  logArtifactId?: string;
}

export interface LegacyExecutionCancellationFact
  extends LegacyExecutionSelector {
  atMs: number;
  scope: 'all' | 'one';
  reason: 'user' | 'policy' | 'shutdown' | 'reconcile';
}

export interface LegacyExecutionCallbackFact extends LegacyExecutionSelector {
  atMs: number;
  phase: 'running' | 'finished';
  exitCode?: number;
}
