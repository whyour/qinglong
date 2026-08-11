// Run owns bounded convergence of durable cancellation intent to terminal state.
import type {
  ClusterRunCancellationConvergenceCoordinator,
  ClusterRunCancellationConvergenceCycleResult,
} from '@qinglong/runtime-core/cluster-run-cancellation-convergence';

export interface ClusterRunCancellationConvergenceLifecycleOptions {
  readonly intervalMs: number;
  readonly stopTimeoutMs: number;
  readonly onDiagnostic?: (
    error: unknown,
    summary?: Readonly<ClusterRunCancellationConvergenceCycleResult>,
  ) => void | Promise<void>;
}

export interface ClusterRunCancellationConvergenceLifecycleStopSummary {
  readonly status: 'stopped' | 'timed_out';
}

/** One constant-cost cadence for all pending non-executing Run cancellations. */
export class ClusterRunCancellationConvergenceLifecycle {
  private timer: NodeJS.Timeout | undefined;
  private inFlight:
    | Promise<Readonly<ClusterRunCancellationConvergenceCycleResult>>
    | undefined;
  private stopPromise:
    | Promise<ClusterRunCancellationConvergenceLifecycleStopSummary>
    | undefined;
  private running = false;
  private stopping = false;

  constructor(
    private readonly coordinator: Pick<
      ClusterRunCancellationConvergenceCoordinator,
      'reconcile'
    >,
    private readonly options: ClusterRunCancellationConvergenceLifecycleOptions,
  ) {
    if (
      typeof coordinator?.reconcile !== 'function' ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 250 ||
      options.intervalMs > 60 * 60_000 ||
      !Number.isSafeInteger(options.stopTimeoutMs) ||
      options.stopTimeoutMs < 100 ||
      options.stopTimeoutMs > 30_000 ||
      (options.onDiagnostic !== undefined &&
        typeof options.onDiagnostic !== 'function')
    ) {
      throw new TypeError('Cluster Run cancellation lifecycle options are invalid');
    }
  }

  start(): 'started' {
    if (!this.running && !this.stopping) {
      this.running = true;
      this.schedule();
    }
    return 'started';
  }

  runOnce(): Promise<Readonly<ClusterRunCancellationConvergenceCycleResult>> {
    if (this.stopping) {
      return Promise.reject(
        new Error('Cluster Run cancellation lifecycle is stopping'),
      );
    }
    if (this.inFlight) return this.inFlight;
    const work = this.coordinator.reconcile().finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
    });
    this.inFlight = work;
    return work;
  }

  stopAndDrain(): Promise<ClusterRunCancellationConvergenceLifecycleStopSummary> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopPromise = (async () => {
      const work = this.inFlight;
      if (!work) return Object.freeze({ status: 'stopped' as const });
      let timeout: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          work.then(
            () => Object.freeze({ status: 'stopped' as const }),
            () => Object.freeze({ status: 'stopped' as const }),
          ),
          new Promise<ClusterRunCancellationConvergenceLifecycleStopSummary>(
            (resolve) => {
              timeout = setTimeout(
                () => resolve(Object.freeze({ status: 'timed_out' as const })),
                this.options.stopTimeoutMs,
              );
              timeout.unref?.();
            },
          ),
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
    summary?: Readonly<ClusterRunCancellationConvergenceCycleResult>,
  ): Promise<void> {
    if (this.stopping) return;
    try {
      await this.options.onDiagnostic?.(error, summary);
    } catch {
      // Diagnostics cannot own or stop convergence.
    }
  }
}
