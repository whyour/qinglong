/** Bounds one startup recovery observation independently of the local Profile. */
export const MAX_LOCAL_RUN_STARTUP_RECOVERY_CANDIDATES = 256;

export type LocalRunStartupRecoveryStatus = 'dispatching' | 'running';

export interface LocalRunStartupRecoveryCandidate {
  readonly runId: string;
  readonly runStatus: LocalRunStartupRecoveryStatus;
  readonly activeAttemptCount: number;
}

export interface LocalRunStartupRecoveryPage {
  readonly candidates: readonly LocalRunStartupRecoveryCandidate[];
  readonly truncated: boolean;
}

export interface LocalRunStartupRecoverySource {
  inspectCandidates(options?: {
    readonly limit?: number;
  }): Promise<LocalRunStartupRecoveryPage>;
}
