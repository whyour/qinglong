import type {
  ExecutionOrigin,
  RunAttemptStatus,
  RunStatus,
} from '../domain/run';

export const MAX_LEGACY_SHADOW_STARTUP_BATCH_SIZE = 64;
export const MAX_LEGACY_SHADOW_STARTUP_EVIDENCE = 8;

export interface LegacyShadowStartupCursor {
  createdAtMs: number;
  runId: string;
}

export interface LegacyShadowStartupAttempt {
  attemptId: string;
  status: RunAttemptStatus;
  pid?: number;
  logArtifactId?: string;
  createdAtMs: number;
  startedAtMs?: number;
}

export interface LegacyShadowStartupCandidate {
  runId: string;
  legacyCronId?: number;
  origin: ExecutionOrigin;
  runStatus: RunStatus;
  createdAtMs: number;
  activeAttemptCount: number;
  attempt?: LegacyShadowStartupAttempt;
}

export interface LegacyShadowStartupPage {
  candidates: readonly LegacyShadowStartupCandidate[];
  truncated: boolean;
  nextCursor?: LegacyShadowStartupCursor;
}

export type LegacyRunningInstanceOutcome =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'stopped';

export interface LegacyRunningInstanceEvidence {
  pid?: number;
  logArtifactId?: string;
  startedAtMs: number;
  finishedAtMs?: number;
  outcome: LegacyRunningInstanceOutcome;
  exitCode?: number;
}

export interface LegacyRunningInstanceEvidencePage {
  evidence: readonly LegacyRunningInstanceEvidence[];
  truncated: boolean;
}

export interface LegacyShadowStartupRecoverySource {
  listCandidates(options: {
    origins: readonly ExecutionOrigin[];
    cursor?: LegacyShadowStartupCursor;
    limit?: number;
  }): Promise<LegacyShadowStartupPage>;

  listRunningInstanceEvidence(options: {
    legacyCronId: number;
    limit?: number;
  }): Promise<LegacyRunningInstanceEvidencePage>;
}
