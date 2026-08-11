import type {
  PrimaryCancellationCycleOptions,
  PrimaryCancellationCycleSummary,
  PrimaryCancellationSupervisor,
} from './primaryCancellationSupervisor';

export const MIN_CANCELLATION_CYCLE_INTERVAL_MS = 250;
export const MAX_CANCELLATION_CYCLE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MAX_CANCELLATION_INITIAL_DELAY_MS = 24 * 60 * 60 * 1_000;
export const MAX_CANCELLATION_STOP_TIMEOUT_MS = 60_000;

interface ScheduledTimer {
  unref?: () => void;
}

export interface CancellationLifecycleScheduler {
  setTimeout(callback: () => void, delayMs: number): ScheduledTimer;
  clearTimeout(timer: ScheduledTimer): void;
}

export interface PrimaryCancellationLifecycleOptions {
  intervalMs: number;
  initialDelayMs?: number;
  stopTimeoutMs?: number;
  cycle?: PrimaryCancellationCycleOptions;
  scheduler?: CancellationLifecycleScheduler;
  onCycle?: (summary: PrimaryCancellationCycleSummary) => void;
  onError?: (error: unknown) => void;
}

export type PrimaryCancellationStopResult = 'drained' | 'timed_out';

const defaultScheduler: CancellationLifecycleScheduler = {
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
 * Explicit lifecycle wrapper for a bounded supervisor cycle. It is inert until
 * start() is called and schedules the next cycle only after the current one
 * settles, so slow edge devices cannot accumulate overlapping scans.
 */
export class PrimaryCancellationLifecycle {
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly stopTimeoutMs: number;
  private readonly cycleOptions: PrimaryCancellationCycleOptions;
  private readonly scheduler: CancellationLifecycleScheduler;
  private readonly onCycle?: (summary: PrimaryCancellationCycleSummary) => void;
  private readonly onError?: (error: unknown) => void;
  private started = false;
  private timer?: ScheduledTimer;
  private inFlight?: Promise<void>;

  constructor(
    private readonly supervisor: Pick<
      PrimaryCancellationSupervisor,
      'runCycle'
    >,
    options: PrimaryCancellationLifecycleOptions,
  ) {
    this.intervalMs = options.intervalMs;
    this.initialDelayMs = options.initialDelayMs ?? 0;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.cycleOptions = {
      ...(options.cycle?.cursor === undefined
        ? {}
        : { cursor: { ...options.cycle.cursor } }),
      ...(options.cycle?.pageSize === undefined
        ? {}
        : { pageSize: options.cycle.pageSize }),
      ...(options.cycle?.maxPages === undefined
        ? {}
        : { maxPages: options.cycle.maxPages }),
    };
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onCycle = options.onCycle;
    this.onError = options.onError;
    assertIntegerBetween(
      'intervalMs',
      this.intervalMs,
      MIN_CANCELLATION_CYCLE_INTERVAL_MS,
      MAX_CANCELLATION_CYCLE_INTERVAL_MS,
    );
    assertIntegerBetween(
      'initialDelayMs',
      this.initialDelayMs,
      0,
      MAX_CANCELLATION_INITIAL_DELAY_MS,
    );
    assertIntegerBetween(
      'stopTimeoutMs',
      this.stopTimeoutMs,
      1,
      MAX_CANCELLATION_STOP_TIMEOUT_MS,
    );
  }

  start(): boolean {
    if (this.started || this.inFlight) return false;
    this.started = true;
    this.schedule(this.initialDelayMs);
    return true;
  }

  async stop(): Promise<PrimaryCancellationStopResult> {
    this.started = false;
    if (this.timer) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const inFlight = this.inFlight;
    if (!inFlight) return 'drained';

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race<PrimaryCancellationStopResult>([
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
    const inFlight = this.supervisor
      .runCycle(this.cycleOptions)
      .then((summary) => this.notifyCycle(summary))
      .catch((error) => this.notifyError(error))
      .then(() => undefined)
      .finally(() => {
        if (this.inFlight === inFlight) this.inFlight = undefined;
        if (this.started) this.schedule(this.intervalMs);
      });
    this.inFlight = inFlight;
  }

  private notifyCycle(summary: PrimaryCancellationCycleSummary): void {
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
