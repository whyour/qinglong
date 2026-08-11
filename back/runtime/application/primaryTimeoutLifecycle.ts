import type {
  PrimaryTimeoutSupervisor,
  PrimaryTimeoutSupervisorOptions,
  PrimaryTimeoutSupervisorSummary,
} from './primaryTimeoutSupervisor';

export const MIN_TIMEOUT_CYCLE_INTERVAL_MS = 250;
export const MAX_TIMEOUT_CYCLE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MAX_TIMEOUT_INITIAL_DELAY_MS = 24 * 60 * 60 * 1_000;
export const MAX_TIMEOUT_STOP_TIMEOUT_MS = 60_000;

interface ScheduledTimer {
  unref?: () => void;
}

export interface TimeoutLifecycleScheduler {
  setTimeout(callback: () => void, delayMs: number): ScheduledTimer;
  clearTimeout(timer: ScheduledTimer): void;
}

export interface PrimaryTimeoutLifecycleOptions {
  intervalMs: number;
  initialDelayMs?: number;
  stopTimeoutMs?: number;
  cycle?: Omit<PrimaryTimeoutSupervisorOptions, 'nowMs'>;
  scheduler?: TimeoutLifecycleScheduler;
  onCycle?: (summary: PrimaryTimeoutSupervisorSummary) => void;
  onError?: (error: unknown) => void;
}

export type PrimaryTimeoutStopResult = 'drained' | 'timed_out';

const defaultScheduler: TimeoutLifecycleScheduler = {
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
 * Explicit, non-overlapping timeout-intent lifecycle. It owns no process
 * signal path: each cycle only asks the supervisor to persist timeout intent.
 */
export class PrimaryTimeoutLifecycle {
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly stopTimeoutMs: number;
  private readonly cycleOptions: Omit<PrimaryTimeoutSupervisorOptions, 'nowMs'>;
  private readonly scheduler: TimeoutLifecycleScheduler;
  private readonly onCycle?: (summary: PrimaryTimeoutSupervisorSummary) => void;
  private readonly onError?: (error: unknown) => void;
  private started = false;
  private timer?: ScheduledTimer;
  private inFlight?: Promise<void>;

  constructor(
    private readonly supervisor: Pick<PrimaryTimeoutSupervisor, 'run'>,
    options: PrimaryTimeoutLifecycleOptions,
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
      MIN_TIMEOUT_CYCLE_INTERVAL_MS,
      MAX_TIMEOUT_CYCLE_INTERVAL_MS,
    );
    assertIntegerBetween(
      'initialDelayMs',
      this.initialDelayMs,
      0,
      MAX_TIMEOUT_INITIAL_DELAY_MS,
    );
    assertIntegerBetween(
      'stopTimeoutMs',
      this.stopTimeoutMs,
      1,
      MAX_TIMEOUT_STOP_TIMEOUT_MS,
    );
  }

  start(): boolean {
    if (this.started || this.inFlight) return false;
    this.started = true;
    this.schedule(this.initialDelayMs);
    return true;
  }

  async stop(): Promise<PrimaryTimeoutStopResult> {
    this.started = false;
    if (this.timer) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const inFlight = this.inFlight;
    if (!inFlight) return 'drained';

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race<PrimaryTimeoutStopResult>([
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
      .run(this.cycleOptions)
      .then((summary) => this.notifyCycle(summary))
      .catch((error) => this.notifyError(error))
      .then(() => undefined)
      .finally(() => {
        if (this.inFlight === inFlight) this.inFlight = undefined;
        if (this.started) this.schedule(this.intervalMs);
      });
    this.inFlight = inFlight;
  }

  private notifyCycle(summary: PrimaryTimeoutSupervisorSummary): void {
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
