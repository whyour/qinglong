import type { ClusterControlStartupRecoverySummary } from './clusterControlActivation';

export const MAX_CLUSTER_CONTROL_RECOVERY_PAGE_SIZE = 128;

export type ClusterControlRecoveryCandidate = Readonly<
  | {
      kind: 'run';
      id: string;
      runId: string;
      status: 'created' | 'dispatching' | 'running';
      createdAtMs: number;
    }
  | {
      kind: 'attempt';
      id: string;
      runId: string;
      status: 'claimed' | 'starting' | 'running';
      createdAtMs: number;
    }
>;

export interface ClusterControlRecoveryPage {
  /** Observation instant selected by the durable source authority. */
  readonly observedAtMs: number;
  readonly candidates: readonly ClusterControlRecoveryCandidate[];
  /** True means at least one additional candidate exists beyond this page. */
  readonly hasMore: boolean;
}

/**
 * Cluster-profile port for bounded, durable startup-recovery discovery.
 * Implementations must never use an unbounded table scan or return terminal
 * work as a candidate.
 */
export interface ClusterControlRecoverySource {
  listOutstanding(limit: number): Promise<ClusterControlRecoveryPage>;
}

/**
 * Independently proves that a recovery implementation really converged before
 * cluster admission is installed. A non-zero remaining value is a lower bound,
 * not an expensive exact count.
 */
export class ClusterControlRecoveryConvergenceVerifier {
  constructor(private readonly source: ClusterControlRecoverySource) {}

  async verify(): Promise<ClusterControlStartupRecoverySummary> {
    const page = await this.source.listOutstanding(1);
    if (!Number.isSafeInteger(page.observedAtMs) || page.observedAtMs < 0) {
      throw new Error('Cluster-control recovery observation is invalid');
    }
    if (page.candidates.length === 0) {
      if (page.hasMore) {
        throw new Error(
          'Cluster-control recovery source returned hasMore without a candidate',
        );
      }
      return Object.freeze({ safe: true, remaining: 0, failed: 0 });
    }
    return Object.freeze({
      safe: false,
      remaining: page.candidates.length + (page.hasMore ? 1 : 0),
      failed: 0,
    });
  }
}
