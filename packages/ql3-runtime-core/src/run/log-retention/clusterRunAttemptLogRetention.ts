import type {
  RunAttemptLogRetentionCandidate,
  RunAttemptLogRetentionStateReader,
  RunAttemptLogRetirementRecord,
} from './runAttemptLogRetention';

export const MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_CLAIMS = 16;
export const MIN_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS = 5_000;
export const MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS = 5 * 60_000;
export const MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_RETRY_DELAY_MS =
  24 * 60 * 60_000;

export type ClusterRunAttemptLogRetentionFailureCode =
  | 'artifact_unavailable'
  | 'artifact_integrity_mismatch'
  | 'retirement_record_unavailable';

export interface ClusterRunAttemptLogRetentionClaim {
  readonly candidate: Readonly<RunAttemptLogRetentionCandidate>;
  readonly eligibleAtMs: number;
  readonly observedAtMs: number;
  readonly ownerId: string;
  readonly token: string;
  readonly version: number;
  readonly expiresAtMs: number;
  readonly failureCount: number;
}

export interface ClusterRunAttemptLogRetentionClaimPage {
  readonly claims: readonly Readonly<ClusterRunAttemptLogRetentionClaim>[];
  readonly hasMore: boolean;
}

export type ClusterRunAttemptLogRetentionSettlement =
  | Readonly<{
      readonly status: 'retired';
      readonly record: Readonly<RunAttemptLogRetirementRecord>;
    }>
  | Readonly<{
      readonly status: 'retry';
      readonly delayMs: number;
      readonly failureCode: ClusterRunAttemptLogRetentionFailureCode;
    }>
  | Readonly<{
      readonly status: 'manual';
      readonly failureCode: ClusterRunAttemptLogRetentionFailureCode;
    }>;

export interface ClusterRunAttemptLogRetentionClaimRepository
  extends RunAttemptLogRetentionStateReader {
  claim(options: Readonly<{
    readonly ownerId: string;
    readonly retentionMs: number;
    readonly limit: number;
    readonly leaseMs: number;
  }>): Promise<Readonly<ClusterRunAttemptLogRetentionClaimPage>>;

  settle(
    claim: Readonly<ClusterRunAttemptLogRetentionClaim>,
    settlement: Readonly<ClusterRunAttemptLogRetentionSettlement>,
  ): Promise<'settled' | 'fenced'>;
}
