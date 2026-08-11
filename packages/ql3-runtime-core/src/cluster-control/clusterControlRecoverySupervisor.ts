import type { ClusterControlRecoveryCandidate } from './clusterControlRecovery';
import type { ClusterControlStartupRecoverySummary } from './clusterControlActivation';

export const MAX_CLUSTER_CONTROL_RECOVERY_CLAIMS_PER_PASS = 128;
export const MAX_CLUSTER_CONTROL_RECOVERY_CLAIM_LEASE_MS = 5 * 60 * 1000;
export const MAX_CLUSTER_CONTROL_RECOVERY_RETRY_DELAY_MS = 5 * 60 * 1000;

export class ClusterControlRecoveryStoreError extends Error {
  readonly retryable = true;

  constructor(readonly cause?: unknown) {
    super('Cluster-control recovery store operation failed');
    this.name = 'ClusterControlRecoveryStoreError';
  }
}

export interface ClusterControlRecoveryClaim {
  readonly candidate: ClusterControlRecoveryCandidate;
  readonly observedAtMs: number;
  readonly ownerId: string;
  readonly token: string;
  readonly version: number;
  readonly expiresAtMs: number;
}

export interface ClusterControlRecoveryClaimPage {
  readonly claims: readonly ClusterControlRecoveryClaim[];
  /** Number of candidates observed in this bounded discovery page. */
  readonly discovered: number;
  readonly hasMore: boolean;
}

export type ClusterControlRecoveryDisposition =
  | Readonly<{ status: 'resolved' }>
  | Readonly<{ status: 'retry'; delayMs: number }>
  | Readonly<{ status: 'manual' }>;

export interface ClusterControlRecoveryClaimRepository {
  claim(
    options: Readonly<{
      ownerId: string;
      limit: number;
      leaseMs: number;
    }>,
  ): Promise<ClusterControlRecoveryClaimPage>;
  settle(
    claim: ClusterControlRecoveryClaim,
    disposition: ClusterControlRecoveryDisposition,
  ): Promise<'settled' | 'fenced'>;
}

export interface ClusterControlRecoveryProcessor {
  process(
    claim: ClusterControlRecoveryClaim,
  ): Promise<ClusterControlRecoveryDisposition>;
}

export interface ClusterControlRecoverySupervisorOptions {
  readonly ownerId: string;
  readonly limit?: number;
  readonly leaseMs?: number;
  readonly retryDelayMs?: number;
}

function integerInRange(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function ownerId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError(
      'Cluster-control recovery ownerId must contain 1-128 safe identifier characters',
    );
  }
  return value;
}

function targetKey(candidate: ClusterControlRecoveryCandidate): string {
  return `${candidate.kind}:${candidate.id}`;
}

function assertClaim(
  claim: ClusterControlRecoveryClaim,
  expectedOwnerId: string,
): void {
  if (
    claim.ownerId !== expectedOwnerId ||
    typeof claim.token !== 'string' ||
    claim.token.length < 16 ||
    claim.token.length > 128 ||
    !Number.isSafeInteger(claim.version) ||
    claim.version < 1 ||
    !Number.isSafeInteger(claim.observedAtMs) ||
    claim.observedAtMs < 0 ||
    !Number.isSafeInteger(claim.expiresAtMs) ||
    claim.expiresAtMs <= claim.observedAtMs ||
    !claim.candidate ||
    typeof claim.candidate.id !== 'string' ||
    claim.candidate.id.length === 0
  ) {
    throw new TypeError(
      'Cluster-control recovery repository returned an invalid claim',
    );
  }
}

function normalizeDisposition(
  value: ClusterControlRecoveryDisposition,
): ClusterControlRecoveryDisposition {
  if (!value || typeof value !== 'object') {
    throw new TypeError(
      'Cluster-control recovery processor returned no disposition',
    );
  }
  if (value.status === 'resolved') return Object.freeze({ status: 'resolved' });
  if (value.status === 'manual') return Object.freeze({ status: 'manual' });
  if (value.status === 'retry') {
    return Object.freeze({
      status: 'retry',
      delayMs: integerInRange(
        'Cluster-control recovery retry delay',
        value.delayMs,
        0,
        MAX_CLUSTER_CONTROL_RECOVERY_RETRY_DELAY_MS,
      ),
    });
  }
  throw new TypeError(
    'Cluster-control recovery processor returned an invalid disposition',
  );
}

/**
 * Runs one bounded, sequential recovery pass. It owns no timer and never
 * executes a task; the injected processor may only resolve evidence under the
 * repository claim fence.
 */
export class ClusterControlRecoverySupervisor {
  private readonly ownerId: string;
  private readonly limit: number;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly repository: ClusterControlRecoveryClaimRepository,
    private readonly processor: ClusterControlRecoveryProcessor,
    options: ClusterControlRecoverySupervisorOptions,
  ) {
    this.ownerId = ownerId(options.ownerId);
    this.limit = integerInRange(
      'Cluster-control recovery claim limit',
      options.limit ?? 16,
      1,
      MAX_CLUSTER_CONTROL_RECOVERY_CLAIMS_PER_PASS,
    );
    this.leaseMs = integerInRange(
      'Cluster-control recovery claim lease',
      options.leaseMs ?? 30_000,
      1_000,
      MAX_CLUSTER_CONTROL_RECOVERY_CLAIM_LEASE_MS,
    );
    this.retryDelayMs = integerInRange(
      'Cluster-control recovery retry delay',
      options.retryDelayMs ?? 5_000,
      0,
      MAX_CLUSTER_CONTROL_RECOVERY_RETRY_DELAY_MS,
    );
  }

  async reconcile(): Promise<ClusterControlStartupRecoverySummary> {
    const page = await this.repository.claim({
      ownerId: this.ownerId,
      limit: this.limit,
      leaseMs: this.leaseMs,
    });
    if (
      !Number.isSafeInteger(page.discovered) ||
      page.discovered < page.claims.length ||
      page.discovered > this.limit ||
      typeof page.hasMore !== 'boolean' ||
      page.claims.length > this.limit
    ) {
      throw new TypeError(
        'Cluster-control recovery repository returned an invalid claim page',
      );
    }

    const keys = new Set<string>();
    for (const claim of page.claims) {
      assertClaim(claim, this.ownerId);
      const key = targetKey(claim.candidate);
      if (keys.has(key)) {
        throw new TypeError(
          'Cluster-control recovery repository returned duplicate claims',
        );
      }
      keys.add(key);
    }

    let remaining =
      page.discovered - page.claims.length + (page.hasMore ? 1 : 0);
    let failed = 0;
    for (const claim of page.claims) {
      let disposition: ClusterControlRecoveryDisposition;
      try {
        disposition = normalizeDisposition(await this.processor.process(claim));
      } catch {
        disposition = Object.freeze({
          status: 'retry',
          delayMs: this.retryDelayMs,
        });
      }
      const settled = await this.repository.settle(claim, disposition);
      if (settled === 'fenced') {
        remaining += 1;
        continue;
      }
      if (settled !== 'settled') {
        throw new TypeError(
          'Cluster-control recovery repository returned an invalid settlement',
        );
      }
      if (disposition.status !== 'resolved') {
        remaining += 1;
        failed += 1;
      }
    }
    return Object.freeze({
      safe: remaining === 0 && failed === 0,
      remaining,
      failed,
    });
  }
}
