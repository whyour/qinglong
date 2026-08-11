import type {
  ExecutionOrigin,
  RunAttemptStatus,
  RunStatus,
} from '../domain/run';

export const MAX_LEGACY_SHADOW_LOOKUP_CANDIDATES = 64;

export interface ActiveLegacyShadowRun {
  runId: string;
  attemptId: string;
  origin: ExecutionOrigin;
  runStatus: RunStatus;
  attemptStatus: RunAttemptStatus;
  pid?: number;
  logArtifactId?: string;
  createdAtMs: number;
}

export interface ActiveLegacyShadowRunQuery {
  legacyCronId: number;
  origins: readonly ExecutionOrigin[];
  limit?: number;
}

export interface ActiveLegacyShadowRunResult {
  candidates: readonly ActiveLegacyShadowRun[];
  truncated: boolean;
}

export interface LegacyShadowRunLocator {
  listActiveByLegacyCron(
    query: ActiveLegacyShadowRunQuery,
  ): Promise<ActiveLegacyShadowRunResult>;
}
