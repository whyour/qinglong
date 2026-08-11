import { MAX_STEP_RUNS_PER_RUN } from './stepRun';

export const MAX_CLUSTER_RUN_CANCELLATION_CONVERGENCE_PAGE_SIZE = 128;
export const MAX_CLUSTER_RUN_CANCELLATION_CONVERGENCE_PAGES_PER_CYCLE = 64;

export interface ClusterRunCancellationConvergencePageCommand {
  readonly limit: number;
}

export interface ClusterRunCancellationConvergencePageResult {
  readonly scanned: number;
  readonly settledRuns: number;
  readonly settledAttempts: number;
  readonly blocked: number;
  readonly hasMore: boolean;
}

export interface ClusterRunCancellationConvergenceRepository {
  convergePage(
    command: Readonly<ClusterRunCancellationConvergencePageCommand>,
  ): Promise<Readonly<ClusterRunCancellationConvergencePageResult>>;
}

export interface ClusterRunCancellationConvergenceCycleResult
  extends ClusterRunCancellationConvergencePageResult {
  readonly pages: number;
  readonly remaining: boolean;
  readonly stopReason: 'complete' | 'page_limit' | 'blocked';
}

export interface ClusterRunCancellationConvergenceCoordinatorOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export class ClusterRunCancellationConvergenceUnavailableError extends Error {
  readonly code = 'CLUSTER_RUN_CANCELLATION_CONVERGENCE_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Cluster Run cancellation convergence is unavailable', options);
    this.name = 'ClusterRunCancellationConvergenceUnavailableError';
  }
}

function boundedInteger(
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

export function normalizeClusterRunCancellationConvergencePageCommand(
  value: ClusterRunCancellationConvergencePageCommand,
): Readonly<ClusterRunCancellationConvergencePageCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Cluster Run cancellation convergence command is invalid');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 1 || keys[0] !== 'limit') {
    throw new TypeError('Cluster Run cancellation convergence command shape is invalid');
  }
  const limit = boundedInteger(
    'Cluster Run cancellation convergence page size',
    value.limit,
    1,
    MAX_CLUSTER_RUN_CANCELLATION_CONVERGENCE_PAGE_SIZE,
  );
  return Object.freeze({ limit });
}

export function normalizeClusterRunCancellationConvergencePageResult(
  value: ClusterRunCancellationConvergencePageResult,
  limit = MAX_CLUSTER_RUN_CANCELLATION_CONVERGENCE_PAGE_SIZE,
): Readonly<ClusterRunCancellationConvergencePageResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Cluster Run cancellation convergence result is invalid');
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 5 ||
    keys.join(',') !== 'blocked,hasMore,scanned,settledAttempts,settledRuns'
  ) {
    throw new TypeError('Cluster Run cancellation convergence result shape is invalid');
  }
  const maximum = boundedInteger(
    'Cluster Run cancellation convergence result limit',
    limit,
    1,
    MAX_CLUSTER_RUN_CANCELLATION_CONVERGENCE_PAGE_SIZE,
  );
  const scanned = boundedInteger(
    'Cluster Run cancellation convergence scanned count',
    value.scanned,
    0,
    maximum,
  );
  const settledRuns = boundedInteger(
    'Cluster Run cancellation convergence settled Run count',
    value.settledRuns,
    0,
    scanned,
  );
  const settledAttempts = boundedInteger(
    'Cluster Run cancellation convergence settled Attempt count',
    value.settledAttempts,
    0,
    scanned * MAX_STEP_RUNS_PER_RUN,
  );
  const blocked = boundedInteger(
    'Cluster Run cancellation convergence blocked count',
    value.blocked,
    0,
    scanned - settledRuns,
  );
  if (typeof value.hasMore !== 'boolean') {
    throw new TypeError('Cluster Run cancellation convergence continuation is invalid');
  }
  return Object.freeze({
    scanned,
    settledRuns,
    settledAttempts,
    blocked,
    hasMore: value.hasMore,
  });
}

/**
 * Runs a bounded, sequential convergence cycle. It owns no timer or connection;
 * deployment profiles choose the cadence and the repository owns row locking.
 */
export class ClusterRunCancellationConvergenceCoordinator {
  private readonly pageSize: number;
  private readonly maxPages: number;
  private inFlight:
    | Promise<Readonly<ClusterRunCancellationConvergenceCycleResult>>
    | undefined;

  constructor(
    private readonly repository: ClusterRunCancellationConvergenceRepository,
    options: ClusterRunCancellationConvergenceCoordinatorOptions,
  ) {
    if (
      typeof repository?.convergePage !== 'function' ||
      !options || typeof options !== 'object' || Array.isArray(options)
    ) {
      throw new TypeError('Cluster Run cancellation convergence coordinator is invalid');
    }
    this.pageSize = boundedInteger(
      'Cluster Run cancellation convergence page size',
      options.pageSize ?? 32,
      1,
      MAX_CLUSTER_RUN_CANCELLATION_CONVERGENCE_PAGE_SIZE,
    );
    this.maxPages = boundedInteger(
      'Cluster Run cancellation convergence page limit',
      options.maxPages ?? 4,
      1,
      MAX_CLUSTER_RUN_CANCELLATION_CONVERGENCE_PAGES_PER_CYCLE,
    );
  }

  reconcile(): Promise<Readonly<ClusterRunCancellationConvergenceCycleResult>> {
    if (this.inFlight) return this.inFlight;
    const operation = this.reconcileOnce().finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    });
    this.inFlight = operation;
    return operation;
  }

  private async reconcileOnce(): Promise<Readonly<ClusterRunCancellationConvergenceCycleResult>> {
    let pages = 0;
    let scanned = 0;
    let settledRuns = 0;
    let settledAttempts = 0;
    let blocked = 0;
    for (; pages < this.maxPages; pages += 1) {
      let page: Readonly<ClusterRunCancellationConvergencePageResult>;
      try {
        page = normalizeClusterRunCancellationConvergencePageResult(
          await this.repository.convergePage({
            limit: this.pageSize,
          }),
          this.pageSize,
        );
      } catch (error) {
        if (error instanceof ClusterRunCancellationConvergenceUnavailableError) {
          throw error;
        }
        throw new ClusterRunCancellationConvergenceUnavailableError({ cause: error });
      }
      scanned += page.scanned;
      settledRuns += page.settledRuns;
      settledAttempts += page.settledAttempts;
      blocked += page.blocked;
      const completedPages = pages + 1;
      if (page.blocked > 0) {
        return Object.freeze({
          pages: completedPages,
          scanned,
          settledRuns,
          settledAttempts,
          blocked,
          hasMore: page.hasMore,
          remaining: true,
          stopReason: 'blocked' as const,
        });
      }
      if (!page.hasMore) {
        return Object.freeze({
          pages: completedPages,
          scanned,
          settledRuns,
          settledAttempts,
          blocked,
          hasMore: false,
          remaining: false,
          stopReason: 'complete' as const,
        });
      }
      if (page.scanned === 0 || page.settledRuns === 0) {
        throw new ClusterRunCancellationConvergenceUnavailableError();
      }
    }
    return Object.freeze({
      pages,
      scanned,
      settledRuns,
      settledAttempts,
      blocked,
      hasMore: true,
      remaining: true,
      stopReason: 'page_limit' as const,
    });
  }
}
