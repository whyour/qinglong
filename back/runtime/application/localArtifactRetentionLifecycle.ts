import type { LocalArtifactRetentionCursor } from '../domain/localArtifactRetention';
import type { LocalArtifactRetentionCheckpointStore } from '../ports/localArtifactRetentionCheckpointStore';
import type {
  LocalArtifactRetentionService,
  LocalArtifactRetentionSweepResult,
} from './localArtifactRetentionService';

export const MIN_LOCAL_ARTIFACT_RETENTION_INTERVAL_MS = 1_000;
export const MAX_LOCAL_ARTIFACT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MAX_LOCAL_ARTIFACT_RETENTION_INITIAL_DELAY_MS =
  24 * 60 * 60 * 1_000;
export const MAX_LOCAL_ARTIFACT_RETENTION_STOP_TIMEOUT_MS = 60_000;

interface ScheduledTimer {
  unref?: () => void;
}

export interface LocalArtifactRetentionLifecycleScheduler {
  setTimeout(callback: () => void, delayMs: number): ScheduledTimer;
  clearTimeout(timer: ScheduledTimer): void;
}

export interface LocalArtifactRetentionCycleSummary {
  pressure: boolean;
  observedAtMs: number;
  retentionMs: number;
  availableBytes: string;
  totalBytes: string;
  candidatesScanned: number;
  deletionsAttempted: number;
  recordsWritten: number;
  failedCandidates: number;
  bytesReclaimed: number;
  sweepStatus: LocalArtifactRetentionSweepResult['status'];
  cursorAction: 'unchanged' | 'advanced' | 'cleared' | 'fenced';
}

export interface LocalArtifactRetentionLifecycleOptions {
  intervalMs: number;
  initialDelayMs?: number;
  stopTimeoutMs?: number;
  scheduler?: LocalArtifactRetentionLifecycleScheduler;
  onCycle?: (summary: Readonly<LocalArtifactRetentionCycleSummary>) => void;
  onError?: (error: unknown) => void;
}

export type LocalArtifactRetentionStopResult = 'drained' | 'timed_out';

const defaultScheduler: LocalArtifactRetentionLifecycleScheduler = {
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

function sameCursor(
  left: LocalArtifactRetentionCursor | undefined,
  right: LocalArtifactRetentionCursor | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.finishedAtMs === right.finishedAtMs &&
      left.attemptId === right.attemptId)
  );
}

/**
 * Explicit one-page cadence with a durable CAS cursor. Idle complete cycles do
 * not write a checkpoint, keeping edge flash write amplification bounded.
 */
export class LocalArtifactRetentionLifecycle {
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly stopTimeoutMs: number;
  private readonly scheduler: LocalArtifactRetentionLifecycleScheduler;
  private readonly onCycle?: LocalArtifactRetentionLifecycleOptions['onCycle'];
  private readonly onError?: LocalArtifactRetentionLifecycleOptions['onError'];
  private started = false;
  private timer?: ScheduledTimer;
  private inFlight?: Promise<void>;

  constructor(
    private readonly service: Pick<LocalArtifactRetentionService, 'sweep'>,
    private readonly checkpoints: LocalArtifactRetentionCheckpointStore,
    options: LocalArtifactRetentionLifecycleOptions,
  ) {
    this.intervalMs = options.intervalMs;
    this.initialDelayMs = options.initialDelayMs ?? 0;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onCycle = options.onCycle;
    this.onError = options.onError;
    assertIntegerBetween(
      'intervalMs',
      this.intervalMs,
      MIN_LOCAL_ARTIFACT_RETENTION_INTERVAL_MS,
      MAX_LOCAL_ARTIFACT_RETENTION_INTERVAL_MS,
    );
    assertIntegerBetween(
      'initialDelayMs',
      this.initialDelayMs,
      0,
      MAX_LOCAL_ARTIFACT_RETENTION_INITIAL_DELAY_MS,
    );
    assertIntegerBetween(
      'stopTimeoutMs',
      this.stopTimeoutMs,
      1,
      MAX_LOCAL_ARTIFACT_RETENTION_STOP_TIMEOUT_MS,
    );
  }

  start(): boolean {
    if (this.started || this.inFlight) return false;
    this.started = true;
    this.schedule(this.initialDelayMs);
    return true;
  }

  async stop(): Promise<LocalArtifactRetentionStopResult> {
    this.started = false;
    if (this.timer) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const inFlight = this.inFlight;
    if (!inFlight) return 'drained';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race<LocalArtifactRetentionStopResult>([
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
    const inFlight = this.runCycle()
      .then((summary) => this.notifyCycle(summary))
      .catch((error) => this.notifyError(error))
      .then(() => undefined)
      .finally(() => {
        if (this.inFlight === inFlight) this.inFlight = undefined;
        if (this.started) this.schedule(this.intervalMs);
      });
    this.inFlight = inFlight;
  }

  private async runCycle(): Promise<LocalArtifactRetentionCycleSummary> {
    const checkpoint = await this.checkpoints.load();
    const sweep = await this.service.sweep(checkpoint.cursor);
    const nextCursor =
      sweep.status === 'complete' ? undefined : sweep.nextCursor;
    if (sweep.status !== 'complete' && !nextCursor) {
      throw new TypeError(
        'Incomplete Local Artifact retention sweep requires a resume cursor',
      );
    }
    let cursorAction: LocalArtifactRetentionCycleSummary['cursorAction'] =
      'unchanged';
    if (!sameCursor(checkpoint.cursor, nextCursor)) {
      const updated = await this.checkpoints.compareAndSet({
        expectedVersion: checkpoint.version,
        ...(nextCursor ? { cursor: nextCursor } : {}),
        updatedAtMs: sweep.observedAtMs,
      });
      cursorAction = updated ? (nextCursor ? 'advanced' : 'cleared') : 'fenced';
    }
    return Object.freeze({
      pressure: sweep.pressure,
      observedAtMs: sweep.observedAtMs,
      retentionMs: sweep.retentionMs,
      availableBytes: sweep.availableBytes.toString(10),
      totalBytes: sweep.totalBytes.toString(10),
      candidatesScanned: sweep.candidatesScanned,
      deletionsAttempted: sweep.deletionsAttempted,
      recordsWritten: sweep.recordsWritten,
      failedCandidates: sweep.failedCandidates,
      bytesReclaimed: sweep.bytesReclaimed,
      sweepStatus: sweep.status,
      cursorAction,
    });
  }

  private notifyCycle(summary: LocalArtifactRetentionCycleSummary): void {
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
