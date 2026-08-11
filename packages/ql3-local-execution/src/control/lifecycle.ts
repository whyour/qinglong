import type { LocalCompletionReceiptJournalCursor } from '@qinglong/runtime-core/local-completion-receipt-journal';
import { assertLocalExecutionControlLimit } from '@qinglong/runtime-core/local-execution-control';
import type { RunAttemptLogRetentionSweepSummary } from '@qinglong/runtime-core/run-attempt-log-retention';
import type {
  LocalCompletionReceiptCleanupScanner,
  LocalCompletionReceiptCleanupSummary,
} from '@qinglong/local-process';
import type { LocalCompletionReceiptProcessor } from './completion';
import type {
  LocalExecutionControlScanSummary,
  LocalExecutionControlScanner,
  LocalExecutionDrainSummary,
} from './control';

export const MAX_LOCAL_COMPLETION_NOTIFICATIONS = 64;

export interface LocalExecutionControlLifecycleOptions {
  readonly intervalMs: number;
  readonly pageSize: number;
  readonly cleanupIntervalMs: number;
  readonly cleanupPageSize: number;
  readonly stopTimeoutMs: number;
  readonly maxDrainPages: number;
  readonly maxNotifications?: number;
  readonly artifactRetention?: Readonly<{
    sweep(): Promise<RunAttemptLogRetentionSweepSummary>;
  }>;
  readonly clock?: { now(): number };
  readonly onDiagnostic?: (
    error: unknown,
    summary?: LocalExecutionControlCycleSummary,
  ) => void | Promise<void>;
}

export interface LocalExecutionControlCycleSummary {
  readonly completions: number;
  readonly completionFailures: number;
  readonly control: LocalExecutionControlScanSummary;
  readonly cleanup?: LocalCompletionReceiptCleanupSummary;
  readonly artifactRetention?: RunAttemptLogRetentionSweepSummary;
}

export interface LocalExecutionControlStopSummary {
  readonly status: 'stopped' | 'timed_out';
  readonly drain?: LocalExecutionDrainSummary;
  readonly cleanup?: LocalCompletionReceiptCleanupSummary;
}

export class LocalExecutionControlLifecycle {
  private readonly clock: { now(): number };
  private readonly maxNotifications: number;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<LocalExecutionControlCycleSummary> | undefined;
  private stopPromise: Promise<LocalExecutionControlStopSummary> | undefined;
  private running = false;
  private stopping = false;
  private kickQueued = false;
  private controlCursor:
    | NonNullable<LocalExecutionControlScanSummary['nextCursor']>
    | undefined;
  private cleanupCursor: LocalCompletionReceiptJournalCursor | undefined;
  private lastCleanupAtMs: number | undefined;
  private readonly pending = new Set<string>();

  constructor(
    private readonly completions: Pick<
      LocalCompletionReceiptProcessor,
      'process'
    >,
    private readonly control: Pick<
      LocalExecutionControlScanner,
      'scan' | 'drain'
    >,
    private readonly cleanup: Pick<
      LocalCompletionReceiptCleanupScanner,
      'scan'
    >,
    private readonly options: LocalExecutionControlLifecycleOptions,
  ) {
    if (
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 250 ||
      options.intervalMs > 60 * 60_000
    ) {
      throw new RangeError('Local execution control interval is invalid');
    }
    assertLocalExecutionControlLimit(options.pageSize);
    if (
      !Number.isSafeInteger(options.cleanupIntervalMs) ||
      options.cleanupIntervalMs < 1_000 ||
      options.cleanupIntervalMs > 24 * 60 * 60_000
    ) {
      throw new RangeError('Local execution cleanup interval is invalid');
    }
    assertLocalExecutionControlLimit(options.cleanupPageSize);
    if (
      !Number.isSafeInteger(options.stopTimeoutMs) ||
      options.stopTimeoutMs < 100 ||
      options.stopTimeoutMs > 30_000
    ) {
      throw new RangeError('Local execution control stop timeout is invalid');
    }
    if (
      !Number.isSafeInteger(options.maxDrainPages) ||
      options.maxDrainPages < 1 ||
      options.maxDrainPages > 16
    ) {
      throw new RangeError('Local execution control drain budget is invalid');
    }
    this.maxNotifications =
      options.maxNotifications ?? MAX_LOCAL_COMPLETION_NOTIFICATIONS;
    if (
      !Number.isSafeInteger(this.maxNotifications) ||
      this.maxNotifications < 1 ||
      this.maxNotifications > MAX_LOCAL_COMPLETION_NOTIFICATIONS
    ) {
      throw new RangeError('Local completion notification budget is invalid');
    }
    if (
      options.artifactRetention !== undefined &&
      typeof options.artifactRetention.sweep !== 'function'
    ) {
      throw new TypeError('Local Artifact retention lifecycle is invalid');
    }
    this.clock = options.clock ?? { now: Date.now };
  }

  start(): void {
    if (this.running || this.stopping) return;
    this.running = true;
    this.schedule();
  }

  notifyCompletion(attemptId: string): boolean {
    if (
      this.stopping ||
      typeof attemptId !== 'string' ||
      attemptId.length > 128
    ) {
      return false;
    }
    if (
      !this.pending.has(attemptId) &&
      this.pending.size >= this.maxNotifications
    ) {
      return false;
    }
    this.pending.add(attemptId);
    this.kick();
    return true;
  }

  runOnce(forceCleanup = false): Promise<LocalExecutionControlCycleSummary> {
    if (this.inFlight) return this.inFlight;
    const work = this.cycle(forceCleanup).finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
    });
    this.inFlight = work;
    return work;
  }

  stopAndDrain(): Promise<LocalExecutionControlStopSummary> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;

    const stopWork = (async () => {
      await this.inFlight;
      await this.processPending();
      const drain = await this.control.drain({
        limit: this.options.pageSize,
        maxPages: this.options.maxDrainPages,
      });
      const cleanup = await this.cleanup.scan({
        limit: this.options.cleanupPageSize,
        ...(this.cleanupCursor === undefined
          ? {}
          : { cursor: this.cleanupCursor }),
      });
      this.cleanupCursor = cleanup.truncated ? cleanup.nextCursor : undefined;
      return Object.freeze({
        status:
          drain.remaining === 0 && drain.failed === 0 && !drain.truncated
            ? ('stopped' as const)
            : ('timed_out' as const),
        drain,
        cleanup,
      });
    })();
    this.stopPromise = Promise.race([
      stopWork,
      new Promise<LocalExecutionControlStopSummary>((resolve) => {
        const timer = setTimeout(
          () => resolve(Object.freeze({ status: 'timed_out' as const })),
          this.options.stopTimeoutMs,
        );
        timer.unref?.();
      }),
    ]);
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

  private kick(): void {
    if (this.kickQueued || this.inFlight || this.stopping) return;
    this.kickQueued = true;
    queueMicrotask(() => {
      this.kickQueued = false;
      if (this.stopping || this.inFlight) return;
      void this.runOnce()
        .then((summary) => this.diagnostic(undefined, summary))
        .catch((error) => this.diagnostic(error));
    });
  }

  private async cycle(
    forceCleanup: boolean,
  ): Promise<LocalExecutionControlCycleSummary> {
    const completion = await this.processPending();
    const control = await this.control.scan({
      limit: this.options.pageSize,
      ...(this.controlCursor === undefined
        ? {}
        : { cursor: this.controlCursor }),
    });
    this.controlCursor = control.truncated ? control.nextCursor : undefined;
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError(
        'Local execution control lifecycle clock is invalid',
      );
    }
    let cleanup: LocalCompletionReceiptCleanupSummary | undefined;
    let artifactRetention: RunAttemptLogRetentionSweepSummary | undefined;
    if (
      forceCleanup ||
      this.lastCleanupAtMs === undefined ||
      now - this.lastCleanupAtMs >= this.options.cleanupIntervalMs
    ) {
      cleanup = await this.cleanup.scan({
        limit: this.options.cleanupPageSize,
        ...(this.cleanupCursor === undefined
          ? {}
          : { cursor: this.cleanupCursor }),
      });
      this.cleanupCursor = cleanup.truncated ? cleanup.nextCursor : undefined;
      artifactRetention = await this.options.artifactRetention?.sweep();
      this.lastCleanupAtMs = now;
    }
    if (this.pending.size > 0) this.kick();
    return Object.freeze({
      completions: completion.processed,
      completionFailures: completion.failed,
      control,
      ...(cleanup === undefined ? {} : { cleanup }),
      ...(artifactRetention === undefined ? {} : { artifactRetention }),
    });
  }

  private async processPending(): Promise<
    Readonly<{
      processed: number;
      failed: number;
    }>
  > {
    const batch = [...this.pending].slice(0, this.maxNotifications);
    for (const attemptId of batch) this.pending.delete(attemptId);
    let processed = 0;
    let failed = 0;
    for (const attemptId of batch) {
      try {
        await this.completions.process(attemptId);
        processed += 1;
      } catch {
        failed += 1;
      }
    }
    return Object.freeze({ processed, failed });
  }

  private async diagnostic(
    error: unknown,
    summary?: LocalExecutionControlCycleSummary,
  ): Promise<void> {
    try {
      await this.options.onDiagnostic?.(error, summary);
    } catch {
      // Diagnostics cannot own execution-control liveness.
    }
  }
}
