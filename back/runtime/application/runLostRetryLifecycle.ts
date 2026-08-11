import type {
  RunLostRetryScanSummary,
  RunLostRetryScanner,
} from './runLostRetryScanner';

export const MIN_RUN_LOST_RETRY_INTERVAL_MS = 250;
export const MAX_RUN_LOST_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MAX_RUN_LOST_RETRY_INITIAL_DELAY_MS = 24 * 60 * 60 * 1_000;
export const MAX_RUN_LOST_RETRY_STOP_TIMEOUT_MS = 60_000;

interface ScheduledTimer {
  unref?: () => void;
}

export interface RunLostRetryLifecycleScheduler {
  setTimeout(callback: () => void, delayMs: number): ScheduledTimer;
  clearTimeout(timer: ScheduledTimer): void;
}

export interface RunLostRetryLifecycleOptions {
  intervalMs: number;
  initialDelayMs?: number;
  stopTimeoutMs?: number;
  pageSize?: number;
  scheduler?: RunLostRetryLifecycleScheduler;
  onCycle?: (summary: RunLostRetryScanSummary) => void;
  onError?: (error: unknown) => void;
}

export type RunLostRetryStopResult = 'drained' | 'timed_out';

const defaultScheduler: RunLostRetryLifecycleScheduler = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

function assertIntegerBetween(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

/**
 * One-page, non-overlapping lost recovery cadence. It deliberately owns no
 * multi-page loop: a slow edge device pays at most one bounded scan per tick.
 */
export class RunLostRetryLifecycle {
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly stopTimeoutMs: number;
  private readonly pageSize: number;
  private readonly scheduler: RunLostRetryLifecycleScheduler;
  private readonly onCycle?: (summary: RunLostRetryScanSummary) => void;
  private readonly onError?: (error: unknown) => void;
  private started = false;
  private timer?: ScheduledTimer;
  private inFlight?: Promise<void>;

  constructor(
    private readonly scanner: Pick<RunLostRetryScanner, 'scan'>,
    options: RunLostRetryLifecycleOptions,
  ) {
    this.intervalMs = options.intervalMs;
    this.initialDelayMs = options.initialDelayMs ?? 0;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.pageSize = options.pageSize ?? 16;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onCycle = options.onCycle;
    this.onError = options.onError;
    assertIntegerBetween(
      'intervalMs',
      this.intervalMs,
      MIN_RUN_LOST_RETRY_INTERVAL_MS,
      MAX_RUN_LOST_RETRY_INTERVAL_MS,
    );
    assertIntegerBetween(
      'initialDelayMs',
      this.initialDelayMs,
      0,
      MAX_RUN_LOST_RETRY_INITIAL_DELAY_MS,
    );
    assertIntegerBetween(
      'stopTimeoutMs',
      this.stopTimeoutMs,
      1,
      MAX_RUN_LOST_RETRY_STOP_TIMEOUT_MS,
    );
    assertIntegerBetween('pageSize', this.pageSize, 1, 64);
  }

  start(): boolean {
    if (this.started || this.inFlight) return false;
    this.started = true;
    this.schedule(this.initialDelayMs);
    return true;
  }

  async stop(): Promise<RunLostRetryStopResult> {
    this.started = false;
    if (this.timer) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const inFlight = this.inFlight;
    if (!inFlight) return 'drained';

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race<RunLostRetryStopResult>([
      inFlight.then(() => 'drained' as const),
      new Promise<'timed_out'>((resolve) => {
        timeout = setTimeout(() => resolve('timed_out'), this.stopTimeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return result;
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.timer) return;
    const timer = this.scheduler.setTimeout(() => {
      if (this.timer === timer) this.timer = undefined;
      this.run();
    }, delayMs);
    this.timer = timer;
    timer.unref?.();
  }

  private run(): void {
    if (!this.started || this.inFlight) return;
    const inFlight = this.scanner
      .scan({ limit: this.pageSize })
      .then((summary) => this.notifyCycle(summary))
      .catch((error) => this.notifyError(error))
      .then(() => undefined)
      .finally(() => {
        if (this.inFlight === inFlight) this.inFlight = undefined;
        if (this.started) this.schedule(this.intervalMs);
      });
    this.inFlight = inFlight;
  }

  private notifyCycle(summary: RunLostRetryScanSummary): void {
    try {
      this.onCycle?.(summary);
    } catch (error) {
      this.notifyError(error);
    }
  }

  private notifyError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics must never create another scheduler failure loop.
    }
  }
}
