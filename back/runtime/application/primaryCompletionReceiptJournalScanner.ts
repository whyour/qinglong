import type { CompletionReceiptJournal } from '../ports/completionReceiptJournal';
import type { CompletionReceiptStore } from '../ports/completionReceiptStore';
import type { PrimaryRunRecoveryCursor } from '../ports/primaryRunRecoverySource';
import { isTerminalRunAttemptStatus } from '../domain/runStateMachine';
import type { PrimaryCompletionReceiptConsumer } from './primaryCompletionReceiptConsumer';
import type { PrimaryCompletionReceiptScanSummary } from './primaryCompletionReceiptScanner';

export interface PrimaryCompletionReceiptJournalScannerOptions {
  terminalMissingRetentionMs?: number;
  clock?: { now(): number };
}

/**
 * Database-indexed receipt retention. The supervisor cursor is only a transport
 * shape here: createdAtMs carries journal.updatedAtMs and runId carries Attempt
 * id. No directory enumeration is performed.
 */
export class PrimaryCompletionReceiptJournalScanner {
  private readonly terminalMissingRetentionMs: number;
  private readonly clock: { now(): number };

  constructor(
    private readonly journal: CompletionReceiptJournal,
    private readonly store: CompletionReceiptStore,
    private readonly consumer: Pick<
      PrimaryCompletionReceiptConsumer,
      'consume'
    >,
    options: PrimaryCompletionReceiptJournalScannerOptions = {},
  ) {
    this.terminalMissingRetentionMs =
      options.terminalMissingRetentionMs ?? 60_000;
    this.clock = options.clock ?? { now: Date.now };
    if (
      !Number.isSafeInteger(this.terminalMissingRetentionMs) ||
      this.terminalMissingRetentionMs < 0 ||
      this.terminalMissingRetentionMs > 24 * 60 * 60_000
    ) {
      throw new RangeError(
        'terminalMissingRetentionMs must be between 0 and 24 hours',
      );
    }
  }

  async scanBatch(
    options: { cursor?: PrimaryRunRecoveryCursor; limit?: number } = {},
  ): Promise<PrimaryCompletionReceiptScanSummary> {
    const observedAtMs = this.clock.now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new RangeError('Completion receipt observation time is invalid');
    }
    const page = await this.journal.listCandidates({
      observedAtMs,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined
        ? {}
        : {
            cursor: {
              updatedAtMs: options.cursor.createdAtMs,
              attemptId: options.cursor.runId,
            },
          }),
    });
    const summary: PrimaryCompletionReceiptScanSummary = {
      scanned: page.candidates.length,
      applied: 0,
      alreadyTerminal: 0,
      quarantined: 0,
      purgedQuarantines: 0,
      expiredMissing: 0,
      missing: 0,
      cleanupPending: 0,
      skipped: 0,
      ambiguous: 0,
      failed: 0,
      truncated: page.truncated,
      unsafeAttemptOverflow: false,
      ...(page.nextCursor === undefined
        ? {}
        : {
            nextCursor: {
              createdAtMs: page.nextCursor.updatedAtMs,
              runId: page.nextCursor.attemptId,
            },
          }),
    };

    for (const candidate of page.candidates) {
      if (candidate.executorType !== 'local_process') {
        summary.skipped += 1;
        continue;
      }
      try {
        if (candidate.state === 'quarantined') {
          await this.store.quarantine(candidate.attemptId);
          await this.store.purgeQuarantine(candidate.attemptId);
          await this.journal.resolve(candidate.attemptId);
          summary.purgedQuarantines += 1;
          continue;
        }

        const result = await this.consumer.consume(candidate.attemptId);
        if (result.status === 'quarantined') {
          summary.quarantined += 1;
          continue;
        }
        if (result.status === 'missing') {
          if (
            isTerminalRunAttemptStatus(candidate.attemptStatus) &&
            candidate.finishedAtMs !== undefined &&
            candidate.finishedAtMs + this.terminalMissingRetentionMs <=
              observedAtMs
          ) {
            await this.journal.resolve(candidate.attemptId);
            summary.expiredMissing += 1;
          } else {
            summary.missing += 1;
          }
          continue;
        }
        if (result.status === 'applied') summary.applied += 1;
        else summary.alreadyTerminal += 1;
        if (!result.cleaned) summary.cleanupPending += 1;
      } catch {
        summary.failed += 1;
      }
    }
    return summary;
  }
}
