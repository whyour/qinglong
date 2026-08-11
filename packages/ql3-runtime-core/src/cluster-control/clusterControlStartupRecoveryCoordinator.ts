import type { ClusterControlStartupRecoverySummary } from './clusterControlActivation';

export const MAX_CLUSTER_CONTROL_STARTUP_RECOVERY_PASSES = 64;

export interface ClusterControlRecoveryPass {
  reconcile(): Promise<ClusterControlStartupRecoverySummary>;
}

export interface ClusterControlStartupRecoveryCoordinatorOptions {
  readonly maxPasses?: number;
}

function maxPasses(value: number | undefined): number {
  const normalized = value ?? 8;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_CLUSTER_CONTROL_STARTUP_RECOVERY_PASSES
  ) {
    throw new RangeError(
      `Cluster-control startup recovery maxPasses must be between 1 and ${MAX_CLUSTER_CONTROL_STARTUP_RECOVERY_PASSES}`,
    );
  }
  return normalized;
}

function normalizeSummary(
  value: ClusterControlStartupRecoverySummary,
): ClusterControlStartupRecoverySummary {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.safe !== 'boolean' ||
    !Number.isSafeInteger(value.remaining) ||
    value.remaining < 0 ||
    !Number.isSafeInteger(value.failed) ||
    value.failed < 0 ||
    (value.safe && (value.remaining !== 0 || value.failed !== 0)) ||
    (!value.safe && value.remaining === 0 && value.failed === 0)
  ) {
    throw new TypeError(
      'Cluster-control recovery pass returned an invalid summary',
    );
  }
  return Object.freeze({
    safe: value.safe,
    remaining: value.remaining,
    failed: value.failed,
  });
}

/**
 * Runs a hard-bounded number of startup passes without a timer or recursion.
 * Deferred/manual work stops immediately; pure backlog may consume another
 * page, and the independent durable-source verifier remains the final gate.
 */
export class ClusterControlStartupRecoveryCoordinator {
  private readonly maxPasses: number;

  constructor(
    private readonly pass: ClusterControlRecoveryPass,
    options: ClusterControlStartupRecoveryCoordinatorOptions = {},
  ) {
    if (!pass || typeof pass.reconcile !== 'function') {
      throw new TypeError('Cluster-control recovery pass is invalid');
    }
    this.maxPasses = maxPasses(options.maxPasses);
  }

  async reconcile(): Promise<ClusterControlStartupRecoverySummary> {
    let latest: ClusterControlStartupRecoverySummary | undefined;
    for (let index = 0; index < this.maxPasses; index += 1) {
      latest = normalizeSummary(await this.pass.reconcile());
      if (latest.safe || latest.failed > 0) return latest;
    }
    return latest!;
  }
}
