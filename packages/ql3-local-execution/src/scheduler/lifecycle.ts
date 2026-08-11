import type {
  LocalSchedulerCoordinator,
  LocalSchedulerCycleSummary,
} from './coordinator';

export interface LocalSchedulerLifecycleOptions {
  readonly intervalMs: number;
  readonly stopTimeoutMs: number;
  readonly onDiagnostic?: (
    error: unknown,
    summary?: LocalSchedulerCycleSummary,
  ) => void | Promise<void>;
}

export interface LocalSchedulerLifecycleStopSummary {
  readonly status: 'stopped' | 'timed_out';
}

export class LocalSchedulerLifecycle {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<LocalSchedulerCycleSummary> | undefined;
  private stopPromise: Promise<LocalSchedulerLifecycleStopSummary> | undefined;
  private running = false;
  private stopping = false;

  constructor(
    private readonly scheduler: Pick<LocalSchedulerCoordinator, 'scheduleOnce'>,
    private readonly options: LocalSchedulerLifecycleOptions,
  ) {
    if (
      !scheduler ||
      typeof scheduler.scheduleOnce !== 'function' ||
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
      throw new TypeError('Local scheduler lifecycle options are invalid');
    }
  }

  start(): 'started' {
    if (!this.running && !this.stopping) {
      this.running = true;
      this.schedule();
    }
    return 'started';
  }

  runOnce(): Promise<LocalSchedulerCycleSummary> {
    if (this.stopping) {
      return Promise.reject(
        new Error('Local scheduler lifecycle is stopping'),
      );
    }
    if (this.inFlight) return this.inFlight;
    const work = this.scheduler.scheduleOnce().finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
    });
    this.inFlight = work;
    return work;
  }

  stopAndDrain(): Promise<LocalSchedulerLifecycleStopSummary> {
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
          new Promise<LocalSchedulerLifecycleStopSummary>((resolve) => {
            timeout = setTimeout(
              () =>
                resolve(Object.freeze({ status: 'timed_out' as const })),
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
    summary?: LocalSchedulerCycleSummary,
  ): Promise<void> {
    if (this.stopping) return;
    try {
      await this.options.onDiagnostic?.(error, summary);
    } catch {
      // Diagnostics cannot own or stop scheduling.
    }
  }
}
