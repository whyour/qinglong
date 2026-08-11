// Run owns bounded multi-replica Cluster log retirement and one lifecycle timer.
import {
  MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_CLAIMS,
  MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS,
  MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_RETRY_DELAY_MS,
  MIN_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS,
  type ClusterRunAttemptLogRetentionClaim,
  type ClusterRunAttemptLogRetentionClaimRepository,
  type ClusterRunAttemptLogRetentionFailureCode,
} from '@qinglong/runtime-core/cluster-run-attempt-log-retention';
import {
  createRunAttemptLogRetirementRecord,
  MAX_RUN_ATTEMPT_LOG_RETENTION_MS,
  MIN_RUN_ATTEMPT_LOG_RETENTION_MS,
  type RunAttemptLogRetentionCandidate,
  type RunAttemptLogRetirementStore,
  type RunAttemptLogRetirementStoreResult,
} from '@qinglong/runtime-core/run-attempt-log-retention';

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIN_SETTLEMENT_BUDGET_MS = 500;

export interface ClusterRunAttemptLogRetirementStore
  extends RunAttemptLogRetirementStore {
  retire(
    candidate: Readonly<RunAttemptLogRetentionCandidate>,
    signal?: AbortSignal,
  ): Promise<Readonly<RunAttemptLogRetirementStoreResult>>;
}

export interface ClusterRunAttemptLogRetentionCoordinatorOptions {
  readonly ownerId: string;
  readonly retentionMs: number;
  readonly claimLimit: number;
  readonly leaseMs: number;
  readonly maximumCycleMs: number;
  readonly retryBaseMs: number;
  readonly retryMaximumMs: number;
  readonly maximumFailures: number;
}

export interface ClusterRunAttemptLogRetentionCycleEntry {
  readonly attemptId: string;
  readonly outcome:
    | 'deleted'
    | 'already_absent'
    | 'retry'
    | 'manual'
    | 'fenced';
}

export interface ClusterRunAttemptLogRetentionCycleSummary {
  readonly status: 'complete' | 'saturated' | 'budget_exhausted';
  readonly claimed: number;
  readonly attempted: number;
  readonly retired: number;
  readonly alreadyAbsent: number;
  readonly retried: number;
  readonly manual: number;
  readonly fenced: number;
  readonly hasMore: boolean;
  readonly entries: readonly Readonly<ClusterRunAttemptLogRetentionCycleEntry>[];
}

function integer(
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

function prepareOptions(
  options: ClusterRunAttemptLogRetentionCoordinatorOptions,
): Readonly<ClusterRunAttemptLogRetentionCoordinatorOptions> {
  const allowed = new Set([
    'claimLimit',
    'leaseMs',
    'maximumCycleMs',
    'maximumFailures',
    'ownerId',
    'retentionMs',
    'retryBaseMs',
    'retryMaximumMs',
  ]);
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !allowed.has(key)) ||
    !OWNER_PATTERN.test(options.ownerId)
  ) {
    throw new TypeError(
      'Cluster Run Attempt log retention options are invalid',
    );
  }
  const leaseMs = integer(
    'Cluster Run Attempt log retention lease',
    options.leaseMs,
    MIN_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS,
    MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS,
  );
  const maximumCycleMs = integer(
    'Cluster Run Attempt log retention cycle budget',
    options.maximumCycleMs,
    100,
    leaseMs - MIN_SETTLEMENT_BUDGET_MS,
  );
  const retryBaseMs = integer(
    'Cluster Run Attempt log retention retry base',
    options.retryBaseMs,
    0,
    MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_RETRY_DELAY_MS,
  );
  const retryMaximumMs = integer(
    'Cluster Run Attempt log retention retry maximum',
    options.retryMaximumMs,
    retryBaseMs,
    MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_RETRY_DELAY_MS,
  );
  return Object.freeze({
    ownerId: options.ownerId,
    retentionMs: integer(
      'Cluster Run Attempt log retention duration',
      options.retentionMs,
      MIN_RUN_ATTEMPT_LOG_RETENTION_MS,
      MAX_RUN_ATTEMPT_LOG_RETENTION_MS,
    ),
    claimLimit: integer(
      'Cluster Run Attempt log retention claim limit',
      options.claimLimit,
      1,
      MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_CLAIMS,
    ),
    leaseMs,
    maximumCycleMs,
    retryBaseMs,
    retryMaximumMs,
    maximumFailures: integer(
      'Cluster Run Attempt log retention failure limit',
      options.maximumFailures,
      1,
      32,
    ),
  });
}

function failureCode(error: unknown): ClusterRunAttemptLogRetentionFailureCode {
  return (error as { readonly reason?: unknown })?.reason ===
    'integrity_mismatch'
    ? 'artifact_integrity_mismatch'
    : 'artifact_unavailable';
}

function retryDelay(
  failureCount: number,
  options: Readonly<ClusterRunAttemptLogRetentionCoordinatorOptions>,
): number {
  const multiplier = 2 ** Math.min(failureCount, 30);
  return Math.min(options.retryMaximumMs, options.retryBaseMs * multiplier);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    typeof (value as AbortSignal).removeEventListener === 'function'
  );
}

export class ClusterRunAttemptLogRetentionCoordinator {
  private readonly options: Readonly<ClusterRunAttemptLogRetentionCoordinatorOptions>;

  constructor(
    private readonly repository: ClusterRunAttemptLogRetentionClaimRepository,
    private readonly store: ClusterRunAttemptLogRetirementStore,
    options: ClusterRunAttemptLogRetentionCoordinatorOptions,
  ) {
    if (
      !repository ||
      typeof repository.claim !== 'function' ||
      typeof repository.settle !== 'function' ||
      !store ||
      typeof store.retire !== 'function'
    ) {
      throw new TypeError(
        'Cluster Run Attempt log retention dependencies are invalid',
      );
    }
    this.options = prepareOptions(options);
  }

  async runOnce(
    externalSignal?: AbortSignal,
  ): Promise<Readonly<ClusterRunAttemptLogRetentionCycleSummary>> {
    if (externalSignal !== undefined && !isAbortSignal(externalSignal)) {
      throw new TypeError(
        'Cluster Run Attempt log retention signal is invalid',
      );
    }
    if (externalSignal?.aborted) throw externalSignal.reason;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error('Cluster log retention cycle budget expired'),
        ),
      this.options.maximumCycleMs,
    );
    timeout.unref?.();
    try {
      const page = await this.repository.claim({
        ownerId: this.options.ownerId,
        retentionMs: this.options.retentionMs,
        limit: this.options.claimLimit,
        leaseMs: this.options.leaseMs,
      });
      const entries: ClusterRunAttemptLogRetentionCycleEntry[] = [];
      let attempted = 0;
      let retired = 0;
      let alreadyAbsent = 0;
      let retried = 0;
      let manual = 0;
      let fenced = 0;
      for (const claim of page.claims) {
        if (controller.signal.aborted) break;
        attempted += 1;
        let result: Readonly<RunAttemptLogRetirementStoreResult>;
        try {
          result = await this.store.retire(claim.candidate, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) break;
          const settled = await this.settleFailure(claim, failureCode(error));
          if (settled === 'fenced') {
            fenced += 1;
            entries.push({
              attemptId: claim.candidate.attemptId,
              outcome: 'fenced',
            });
          } else if (claim.failureCount + 1 >= this.options.maximumFailures) {
            manual += 1;
            entries.push({
              attemptId: claim.candidate.attemptId,
              outcome: 'manual',
            });
          } else {
            retried += 1;
            entries.push({
              attemptId: claim.candidate.attemptId,
              outcome: 'retry',
            });
          }
          continue;
        }
        if (controller.signal.aborted) break;
        let record;
        try {
          record = createRunAttemptLogRetirementRecord({
            ...claim.candidate,
            eligibleAtMs: claim.eligibleAtMs,
            retiredAtMs: claim.observedAtMs,
            ...result,
          });
        } catch {
          const settled = await this.settleFailure(
            claim,
            'retirement_record_unavailable',
          );
          if (settled === 'fenced') {
            fenced += 1;
            entries.push({
              attemptId: claim.candidate.attemptId,
              outcome: 'fenced',
            });
          } else if (claim.failureCount + 1 >= this.options.maximumFailures) {
            manual += 1;
            entries.push({
              attemptId: claim.candidate.attemptId,
              outcome: 'manual',
            });
          } else {
            retried += 1;
            entries.push({
              attemptId: claim.candidate.attemptId,
              outcome: 'retry',
            });
          }
          continue;
        }
        const settled = await this.repository.settle(claim, {
          status: 'retired',
          record,
        });
        if (settled === 'fenced') {
          fenced += 1;
          entries.push({
            attemptId: claim.candidate.attemptId,
            outcome: 'fenced',
          });
          continue;
        }
        if (record.disposition === 'already_absent') alreadyAbsent += 1;
        else retired += 1;
        entries.push({
          attemptId: claim.candidate.attemptId,
          outcome: record.disposition,
        });
      }
      const budgetExhausted = controller.signal.aborted;
      return Object.freeze({
        status: budgetExhausted
          ? ('budget_exhausted' as const)
          : page.hasMore
          ? ('saturated' as const)
          : ('complete' as const),
        claimed: page.claims.length,
        attempted,
        retired,
        alreadyAbsent,
        retried,
        manual,
        fenced,
        hasMore: page.hasMore,
        entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
      });
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', forwardAbort);
    }
  }

  private settleFailure(
    claim: Readonly<ClusterRunAttemptLogRetentionClaim>,
    code: ClusterRunAttemptLogRetentionFailureCode,
  ): Promise<'settled' | 'fenced'> {
    if (claim.failureCount + 1 >= this.options.maximumFailures) {
      return this.repository.settle(claim, {
        status: 'manual',
        failureCode: code,
      });
    }
    return this.repository.settle(claim, {
      status: 'retry',
      delayMs: retryDelay(claim.failureCount, this.options),
      failureCode: code,
    });
  }
}

export interface ClusterRunAttemptLogRetentionLifecycleOptions {
  readonly intervalMs: number;
  readonly stopTimeoutMs: number;
  readonly onDiagnostic?: (
    error: unknown,
    summary?: Readonly<ClusterRunAttemptLogRetentionCycleSummary>,
  ) => void | Promise<void>;
}

export class ClusterRunAttemptLogRetentionLifecycle {
  private timer: NodeJS.Timeout | undefined;
  private inFlight:
    | Promise<Readonly<ClusterRunAttemptLogRetentionCycleSummary>>
    | undefined;
  private controller: AbortController | undefined;
  private stopPromise: Promise<'stopped' | 'timed_out'> | undefined;
  private running = false;
  private stopping = false;

  constructor(
    private readonly coordinator: Pick<
      ClusterRunAttemptLogRetentionCoordinator,
      'runOnce'
    >,
    private readonly options: ClusterRunAttemptLogRetentionLifecycleOptions,
  ) {
    if (
      !coordinator ||
      typeof coordinator.runOnce !== 'function' ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 1_000 ||
      options.intervalMs > 24 * 60 * 60_000 ||
      !Number.isSafeInteger(options.stopTimeoutMs) ||
      options.stopTimeoutMs < 100 ||
      options.stopTimeoutMs > 30_000 ||
      (options.onDiagnostic !== undefined &&
        typeof options.onDiagnostic !== 'function')
    ) {
      throw new TypeError(
        'Cluster Run Attempt log retention lifecycle options are invalid',
      );
    }
  }

  start(): 'started' {
    if (!this.running && !this.stopping) {
      this.running = true;
      this.schedule();
    }
    return 'started';
  }

  runOnce(): Promise<Readonly<ClusterRunAttemptLogRetentionCycleSummary>> {
    if (this.stopping) {
      return Promise.reject(
        new Error('Cluster Run Attempt log retention lifecycle is stopping'),
      );
    }
    if (this.inFlight) return this.inFlight;
    const controller = new AbortController();
    this.controller = controller;
    const work = this.coordinator.runOnce(controller.signal).finally(() => {
      if (this.inFlight === work) {
        this.inFlight = undefined;
        this.controller = undefined;
      }
    });
    this.inFlight = work;
    return work;
  }

  stopAndDrain(): Promise<'stopped' | 'timed_out'> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort(
      new Error('Cluster Run Attempt log retention lifecycle is stopping'),
    );
    this.stopPromise = (async () => {
      const work = this.inFlight;
      if (!work) return 'stopped' as const;
      let timeout: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          work.then(
            () => 'stopped' as const,
            () => 'stopped' as const,
          ),
          new Promise<'timed_out'>((resolve) => {
            timeout = setTimeout(
              () => resolve('timed_out' as const),
              this.options.stopTimeoutMs,
            );
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })();
    return this.stopPromise;
  }

  private schedule(): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.running) return;
      void this.runOnce()
        .then((summary) => this.diagnostic(undefined, summary))
        .catch((error) => this.diagnostic(error))
        .finally(() => this.schedule());
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  private async diagnostic(
    error: unknown,
    summary?: Readonly<ClusterRunAttemptLogRetentionCycleSummary>,
  ): Promise<void> {
    if (this.stopping) return;
    try {
      await this.options.onDiagnostic?.(error, summary);
    } catch {
      // Diagnostics cannot own or stop retention.
    }
  }
}
