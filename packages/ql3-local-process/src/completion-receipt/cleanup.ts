import type {
  LocalCompletionReceiptJournal,
  LocalCompletionReceiptJournalCursor,
} from '@qinglong/runtime-core/local-completion-receipt-journal';
import {
  MAX_LOCAL_COMPLETION_RECEIPT_JOURNAL_PAGE,
  assertLocalCompletionReceiptJournalLimit,
} from '@qinglong/runtime-core/local-completion-receipt-journal';
import type { CompletionReceiptStore } from './completionReceiptFileStore';

const TERMINAL_ATTEMPT_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);
const MAX_RETENTION_MS = 24 * 60 * 60_000;

interface MaintainedCompletionReceiptStore extends CompletionReceiptStore {
  quarantine?(attemptId: string): Promise<string | undefined>;
  purgeQuarantine?(attemptId: string): Promise<boolean>;
}

export interface LocalCompletionReceiptCleanupSummary {
  readonly scanned: number;
  readonly removed: number;
  readonly expiredMissing: number;
  readonly purgedQuarantines: number;
  readonly remaining: number;
  readonly failed: number;
  readonly truncated: boolean;
  readonly nextCursor?: LocalCompletionReceiptJournalCursor;
}

export interface LocalCompletionReceiptCleanupOptions {
  readonly terminalMissingRetentionMs?: number;
  readonly clock?: { now(): number };
}

export class LocalCompletionReceiptCleanupScanner {
  private readonly terminalMissingRetentionMs: number;
  private readonly clock: { now(): number };

  constructor(
    private readonly journal: LocalCompletionReceiptJournal,
    private readonly receipts: MaintainedCompletionReceiptStore,
    options: LocalCompletionReceiptCleanupOptions = {},
  ) {
    this.terminalMissingRetentionMs =
      options.terminalMissingRetentionMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.terminalMissingRetentionMs) ||
      this.terminalMissingRetentionMs < 0 ||
      this.terminalMissingRetentionMs > MAX_RETENTION_MS
    ) {
      throw new RangeError(
        'terminalMissingRetentionMs must be between 0 and 24 hours',
      );
    }
    this.clock = options.clock ?? { now: Date.now };
  }

  async scan(
    options: {
      readonly cursor?: LocalCompletionReceiptJournalCursor;
      readonly limit?: number;
    } = {},
  ): Promise<LocalCompletionReceiptCleanupSummary> {
    const observedAtMs = this.clock.now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new RangeError('Completion receipt cleanup clock is invalid');
    }
    const limit = options.limit ?? 32;
    assertLocalCompletionReceiptJournalLimit(limit);
    const page = await this.journal.listCandidates({
      observedAtMs,
      limit,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    });
    if (
      !page ||
      !Array.isArray(page.candidates) ||
      page.candidates.length > MAX_LOCAL_COMPLETION_RECEIPT_JOURNAL_PAGE ||
      typeof page.truncated !== 'boolean'
    ) {
      throw new TypeError('Completion receipt cleanup page is invalid');
    }
    let removed = 0;
    let expiredMissing = 0;
    let purgedQuarantines = 0;
    let remaining = 0;
    let failed = 0;
    for (const candidate of page.candidates) {
      try {
        if (candidate.executorType !== 'local_process') {
          remaining += 1;
          continue;
        }
        if (candidate.state === 'quarantined') {
          if (!this.receipts.quarantine || !this.receipts.purgeQuarantine) {
            remaining += 1;
            continue;
          }
          await this.receipts.quarantine(candidate.attemptId);
          await this.receipts.purgeQuarantine(candidate.attemptId);
          await this.journal.resolve(candidate.attemptId);
          purgedQuarantines += 1;
          continue;
        }
        if (!TERMINAL_ATTEMPT_STATUSES.has(candidate.attemptStatus)) {
          remaining += 1;
          continue;
        }
        const receiptRemoved = await this.receipts.remove(candidate.attemptId);
        if (receiptRemoved) {
          await this.journal.resolve(candidate.attemptId);
          removed += 1;
          continue;
        }
        if (
          candidate.finishedAtMs !== undefined &&
          candidate.finishedAtMs + this.terminalMissingRetentionMs <=
            observedAtMs
        ) {
          await this.journal.resolve(candidate.attemptId);
          expiredMissing += 1;
        } else {
          remaining += 1;
        }
      } catch {
        failed += 1;
      }
    }
    return Object.freeze({
      scanned: page.candidates.length,
      removed,
      expiredMissing,
      purgedQuarantines,
      remaining,
      failed,
      truncated: page.truncated,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  }
}

export interface LocalCompletionReceiptCleanupLifecycleOptions {
  readonly intervalMs: number;
  readonly pageSize: number;
  readonly stopTimeoutMs?: number;
  readonly onDiagnostic?: (
    error: unknown,
    summary?: LocalCompletionReceiptCleanupSummary,
  ) => void | Promise<void>;
}

export class LocalCompletionReceiptCleanupLifecycle {
  private readonly stopTimeoutMs: number;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private running = false;
  private cursor: LocalCompletionReceiptJournalCursor | undefined;

  constructor(
    private readonly scanner: LocalCompletionReceiptCleanupScanner,
    private readonly options: LocalCompletionReceiptCleanupLifecycleOptions,
  ) {
    if (
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 1_000 ||
      options.intervalMs > 24 * 60 * 60_000
    ) {
      throw new RangeError(
        'cleanup interval must be between 1 second and 24 hours',
      );
    }
    assertLocalCompletionReceiptJournalLimit(options.pageSize);
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    if (
      !Number.isSafeInteger(this.stopTimeoutMs) ||
      this.stopTimeoutMs < 100 ||
      this.stopTimeoutMs > 30_000
    ) {
      throw new RangeError(
        'cleanup stop timeout must be between 100 and 30000 ms',
      );
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  async runOnce(): Promise<LocalCompletionReceiptCleanupSummary> {
    const summary = await this.scanner.scan({
      limit: this.options.pageSize,
      ...(this.cursor === undefined ? {} : { cursor: this.cursor }),
    });
    this.cursor = summary.truncated ? summary.nextCursor : undefined;
    return summary;
  }

  async stop(): Promise<'stopped' | 'timed_out'> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const inFlight = this.inFlight;
    if (!inFlight) return 'stopped';
    return Promise.race([
      inFlight.then(() => 'stopped' as const),
      new Promise<'timed_out'>((resolve) => {
        setTimeout(() => resolve('timed_out'), this.stopTimeoutMs).unref?.();
      }),
    ]);
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      if (!this.running || this.inFlight) {
        this.schedule();
        return;
      }
      this.inFlight = this.tick().finally(() => {
        this.inFlight = undefined;
        this.schedule();
      });
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const summary = await this.scanner.scan({
        limit: this.options.pageSize,
        ...(this.cursor === undefined ? {} : { cursor: this.cursor }),
      });
      this.cursor = summary.truncated ? summary.nextCursor : undefined;
      await this.options.onDiagnostic?.(undefined, summary);
    } catch (error) {
      await this.options.onDiagnostic?.(error);
    }
  }
}
