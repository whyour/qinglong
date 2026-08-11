import type { CompletionReceipt } from '../domain/completionReceipt';
import { InvalidCompletionReceiptError } from '../domain/completionReceipt';
import type { CompletionReceiptStore } from '../ports/completionReceiptStore';
import type { CompletionReceiptJournal } from '../ports/completionReceiptJournal';
import type {
  PrimaryRunCompletionResult,
  PrimaryRunCompletionService,
} from './primaryRunCompletionService';
import {
  PrimaryCompletionNotFoundError,
  PrimaryCompletionSequenceError,
  PrimaryCompletionStateError,
  PrimaryCompletionUnauthorizedError,
} from './primaryRunCompletionService';

export interface PrimaryCompletionReceiptConsumeResult {
  status: 'missing' | 'quarantined' | PrimaryRunCompletionResult['status'];
  cleaned: boolean;
  quarantineRef?: string;
  completion?: PrimaryRunCompletionResult;
}

export interface PrimaryCompletionReceiptConsumerOptions {
  journal?: Pick<CompletionReceiptJournal, 'markQuarantined' | 'resolve'>;
  quarantineRetentionMs?: number;
  clock?: { now(): number };
}

function mustQuarantine(error: unknown): boolean {
  return (
    error instanceof InvalidCompletionReceiptError ||
    error instanceof PrimaryCompletionNotFoundError ||
    error instanceof PrimaryCompletionUnauthorizedError ||
    error instanceof PrimaryCompletionSequenceError ||
    error instanceof PrimaryCompletionStateError
  );
}

function receiptResult(receipt: CompletionReceipt) {
  return {
    outcome:
      receipt.exitCode === 0 ? ('succeeded' as const) : ('failed' as const),
    startedAtMs: receipt.startedAtMs,
    finishedAtMs: receipt.finishedAtMs,
    exitCode: receipt.exitCode,
  };
}

/**
 * Reads only a database-discovered Attempt receipt. Cleanup happens after the
 * terminal transaction; failures leave the immutable receipt replayable.
 */
export class PrimaryCompletionReceiptConsumer {
  private readonly journal?: Pick<
    CompletionReceiptJournal,
    'markQuarantined' | 'resolve'
  >;
  private readonly quarantineRetentionMs: number;
  private readonly clock: { now(): number };

  constructor(
    private readonly store: CompletionReceiptStore,
    private readonly completions: Pick<PrimaryRunCompletionService, 'complete'>,
    options: PrimaryCompletionReceiptConsumerOptions = {},
  ) {
    this.journal = options.journal;
    this.quarantineRetentionMs = options.quarantineRetentionMs ?? 60 * 60_000;
    this.clock = options.clock ?? { now: Date.now };
    if (
      !Number.isSafeInteger(this.quarantineRetentionMs) ||
      this.quarantineRetentionMs < 1 ||
      this.quarantineRetentionMs > 30 * 24 * 60 * 60_000
    ) {
      throw new RangeError(
        'quarantineRetentionMs must be between 1 and 30 days',
      );
    }
  }

  async consume(
    attemptId: string,
  ): Promise<PrimaryCompletionReceiptConsumeResult> {
    let completion: PrimaryRunCompletionResult;
    try {
      const receipt = await this.store.read(attemptId);
      if (!receipt) return { status: 'missing', cleaned: false };
      completion = await this.completions.complete({
        runId: receipt.runId,
        attemptId: receipt.attemptId,
        callbackSequence: receipt.callbackSequence,
        result: receiptResult(receipt),
        source: { kind: 'receipt', token: receipt.token },
      });
    } catch (error) {
      if (!mustQuarantine(error)) throw error;
      const quarantineRef = this.store.quarantineReference(attemptId);
      if (this.journal) {
        const updatedAtMs = this.clock.now();
        const purgeAfterMs = updatedAtMs + this.quarantineRetentionMs;
        if (
          !Number.isSafeInteger(updatedAtMs) ||
          updatedAtMs < 0 ||
          !Number.isSafeInteger(purgeAfterMs)
        ) {
          throw new RangeError('Completion receipt quarantine time is invalid');
        }
        await this.journal.markQuarantined({
          attemptId,
          quarantineRef,
          updatedAtMs,
          purgeAfterMs,
        });
      }
      const quarantined = await this.store.quarantine(attemptId);
      if (!quarantined) return { status: 'missing', cleaned: false };
      return {
        status: 'quarantined',
        cleaned: true,
        quarantineRef: quarantined,
      };
    }
    const cleaned = await this.store.remove(attemptId);
    if (cleaned) await this.journal?.resolve(attemptId);
    return { status: completion.status, cleaned, completion };
  }
}
