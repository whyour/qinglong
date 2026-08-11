import type { ApprovedActionDispatchCursor } from '../domain/approvedActionDispatchExecution';
import type { ApprovedActionRecoveryCursor } from '../domain/approvedActionRecovery';
import type {
  ApprovedActionDispatchCycleOptions,
  ApprovedActionRecoveryCycleOptions,
  ApprovedActionRuntimeCycleSummary,
  ApprovedActionRuntimeSupervisor,
} from './approvedActionRuntimeSupervisor';

export const MIN_APPROVED_ACTION_RUNTIME_INTERVAL_MS = 250;
export const MAX_APPROVED_ACTION_RUNTIME_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MAX_APPROVED_ACTION_RUNTIME_INITIAL_DELAY_MS =
  24 * 60 * 60 * 1_000;
export const MAX_APPROVED_ACTION_RUNTIME_STOP_TIMEOUT_MS = 60_000;

interface ScheduledTimer {
  unref?: () => void;
}

export interface ApprovedActionRuntimeLifecycleScheduler {
  setTimeout(callback: () => void, delayMs: number): ScheduledTimer;
  clearTimeout(timer: ScheduledTimer): void;
}

export interface ApprovedActionRuntimeLifecycleOptions {
  intervalMs: number;
  initialDelayMs?: number;
  stopTimeoutMs?: number;
  cycle?: {
    dispatch?: ApprovedActionDispatchCycleOptions;
    recovery?: ApprovedActionRecoveryCycleOptions;
  };
  scheduler?: ApprovedActionRuntimeLifecycleScheduler;
  onCycle?: (summary: Readonly<ApprovedActionRuntimeCycleSummary>) => void;
  onError?: (error: unknown) => void;
}

export type ApprovedActionRuntimeStopResult = 'drained' | 'timed_out';

const defaultScheduler: ApprovedActionRuntimeLifecycleScheduler = {
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
 * One timer serializes recovery and new dispatch work. It remains inert until
 * start(), never overlaps a slow cycle, resumes bounded keyset cursors, and
 * waits only a bounded time during shutdown.
 */
export class ApprovedActionRuntimeLifecycle {
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly stopTimeoutMs: number;
  private readonly dispatchOptions: Omit<
    ApprovedActionDispatchCycleOptions,
    'cursor'
  >;
  private readonly recoveryOptions: Omit<
    ApprovedActionRecoveryCycleOptions,
    'cursor'
  >;
  private readonly scheduler: ApprovedActionRuntimeLifecycleScheduler;
  private readonly onCycle?: (
    summary: Readonly<ApprovedActionRuntimeCycleSummary>,
  ) => void;
  private readonly onError?: (error: unknown) => void;
  private started = false;
  private timer?: ScheduledTimer;
  private inFlight?: Promise<void>;
  private dispatchCursor?: ApprovedActionDispatchCursor;
  private recoveryCursor?: ApprovedActionRecoveryCursor;

  constructor(
    private readonly supervisor: Pick<
      ApprovedActionRuntimeSupervisor,
      'runCycle'
    >,
    options: ApprovedActionRuntimeLifecycleOptions,
  ) {
    this.intervalMs = options.intervalMs;
    this.initialDelayMs = options.initialDelayMs ?? 0;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.dispatchOptions = {
      ...(options.cycle?.dispatch?.pageSize === undefined
        ? {}
        : { pageSize: options.cycle.dispatch.pageSize }),
      ...(options.cycle?.dispatch?.maxPages === undefined
        ? {}
        : { maxPages: options.cycle.dispatch.maxPages }),
    };
    this.recoveryOptions = {
      ...(options.cycle?.recovery?.pageSize === undefined
        ? {}
        : { pageSize: options.cycle.recovery.pageSize }),
      ...(options.cycle?.recovery?.maxPages === undefined
        ? {}
        : { maxPages: options.cycle.recovery.maxPages }),
    };
    this.dispatchCursor =
      options.cycle?.dispatch?.cursor === undefined
        ? undefined
        : { ...options.cycle.dispatch.cursor };
    this.recoveryCursor =
      options.cycle?.recovery?.cursor === undefined
        ? undefined
        : { ...options.cycle.recovery.cursor };
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onCycle = options.onCycle;
    this.onError = options.onError;
    assertIntegerBetween(
      'intervalMs',
      this.intervalMs,
      MIN_APPROVED_ACTION_RUNTIME_INTERVAL_MS,
      MAX_APPROVED_ACTION_RUNTIME_INTERVAL_MS,
    );
    assertIntegerBetween(
      'initialDelayMs',
      this.initialDelayMs,
      0,
      MAX_APPROVED_ACTION_RUNTIME_INITIAL_DELAY_MS,
    );
    assertIntegerBetween(
      'stopTimeoutMs',
      this.stopTimeoutMs,
      1,
      MAX_APPROVED_ACTION_RUNTIME_STOP_TIMEOUT_MS,
    );
  }

  start(): boolean {
    if (this.started || this.inFlight) return false;
    this.started = true;
    this.schedule(this.initialDelayMs);
    return true;
  }

  async stop(): Promise<ApprovedActionRuntimeStopResult> {
    this.started = false;
    if (this.timer) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const inFlight = this.inFlight;
    if (!inFlight) return 'drained';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race<ApprovedActionRuntimeStopResult>([
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
      .runCycle({
        recovery: {
          ...this.recoveryOptions,
          ...(this.recoveryCursor === undefined
            ? {}
            : { cursor: { ...this.recoveryCursor } }),
        },
        dispatch: {
          ...this.dispatchOptions,
          ...(this.dispatchCursor === undefined
            ? {}
            : { cursor: { ...this.dispatchCursor } }),
        },
      })
      .then((summary) => {
        this.recoveryCursor =
          summary.recovery.remaining && summary.recovery.nextCursor
            ? { ...summary.recovery.nextCursor }
            : undefined;
        this.dispatchCursor =
          summary.dispatch.remaining && summary.dispatch.nextCursor
            ? { ...summary.dispatch.nextCursor }
            : undefined;
        this.notifyCycle(summary);
      })
      .catch((error) => this.notifyError(error))
      .then(() => undefined)
      .finally(() => {
        if (this.inFlight === inFlight) this.inFlight = undefined;
        if (this.started) this.schedule(this.intervalMs);
      });
    this.inFlight = inFlight;
  }

  private notifyCycle(
    summary: Readonly<ApprovedActionRuntimeCycleSummary>,
  ): void {
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
      // Diagnostics must not create another scheduler failure loop.
    }
  }
}
