import type {
  ExecutionOrigin,
  RunAttemptStatus,
  RunStatus,
} from '../domain/run';

export const MAX_LEGACY_SHADOW_TERMINAL_PAGE_SIZE = 64;
export const MAX_LEGACY_SHADOW_TERMINAL_EVIDENCE_PER_PAGE = 512;

export interface LegacyShadowTerminalCursor {
  createdAtMs: number;
  runId: string;
}

export interface LegacyShadowTerminalAttemptEvidence {
  attemptId: string;
  status: RunAttemptStatus;
  pid?: number;
  logArtifactId?: string;
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  exitCode?: number;
}

export interface LegacyShadowTerminalCandidate {
  runId: string;
  legacyCronId?: number;
  origin: ExecutionOrigin;
  runStatus: RunStatus;
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  attemptCount: number;
  attempt?: LegacyShadowTerminalAttemptEvidence;
}

export type LegacyTerminalOutcome = 'succeeded' | 'failed' | 'stopped';

export interface LegacyTerminalEvidence {
  instanceId: number;
  legacyCronId: number;
  runId?: string;
  attemptId?: string;
  pid?: number;
  logArtifactId?: string;
  startedAtMs: number;
  finishedAtMs: number;
  outcome: LegacyTerminalOutcome;
  exitCode?: number;
}

export interface LegacyShadowTerminalPage {
  candidates: readonly LegacyShadowTerminalCandidate[];
  evidence: readonly LegacyTerminalEvidence[];
  evidenceTruncated: boolean;
  truncated: boolean;
  nextCursor?: LegacyShadowTerminalCursor;
}

/**
 * Read-only local Legacy authority used by the explicit terminal-difference
 * audit. Implementations must bound both candidate and evidence result sets.
 */
export interface LegacyShadowTerminalDifferenceSource {
  listCandidates(options: {
    projectId: string;
    origins: readonly ExecutionOrigin[];
    windowStartMs: number;
    windowEndMs: number;
    observedAtMs: number;
    correlationToleranceMs: number;
    cursor?: LegacyShadowTerminalCursor;
    limit: number;
  }): Promise<LegacyShadowTerminalPage>;
}
