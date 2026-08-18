import type { ExecutionOrigin } from '../domain/run';

export interface LegacyExecutionAcceptedFact {
  origin: ExecutionOrigin;
  projectId: string;
  taskId: string;
  taskRevision: string;
  taskName?: string;
  legacyCronId?: number;
  triggerType: string;
  triggeredBy?: string;
  requestId?: string;
  scheduledForMs?: number;
  acceptedAtMs: number;
}

export interface LegacyExecutionSpawnedFact {
  atMs: number;
  pid?: number;
  executorHandle?: string;
  logArtifactId?: string;
}

export interface LegacyExecutionRunningFact {
  atMs: number;
}

export interface LegacyExecutionStartFailedFact {
  atMs: number;
  errorCode: string;
}

export interface LegacyExecutionExitedFact {
  atMs: number;
  exitCode: number | null;
  signal?: NodeJS.Signals;
}

export interface LegacyExecutionCancelledFact {
  atMs: number;
  reason: 'user' | 'policy' | 'shutdown' | 'reconcile';
}

export interface LegacyExecutionObservation {
  captureSettled?(): Promise<'captured' | 'failed'>;
  spawned(fact: LegacyExecutionSpawnedFact): void;
  running(fact: LegacyExecutionRunningFact): void;
  startFailed(fact: LegacyExecutionStartFailedFact): void;
  exited(fact: LegacyExecutionExitedFact): void;
  cancelled(fact: LegacyExecutionCancelledFact): void;
}

export interface LegacyExecutionObserver {
  begin(fact: LegacyExecutionAcceptedFact): LegacyExecutionObservation;
}
