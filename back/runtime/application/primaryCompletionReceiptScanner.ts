import type {
  PrimaryRunRecoveryCursor,
  PrimaryRunRecoverySource,
} from '../ports/primaryRunRecoverySource';
import type { PrimaryCompletionReceiptConsumer } from './primaryCompletionReceiptConsumer';

export interface PrimaryCompletionReceiptScanSummary {
  scanned: number;
  applied: number;
  alreadyTerminal: number;
  quarantined: number;
  purgedQuarantines: number;
  expiredMissing: number;
  missing: number;
  cleanupPending: number;
  skipped: number;
  ambiguous: number;
  failed: number;
  truncated: boolean;
  unsafeAttemptOverflow: boolean;
  nextCursor?: PrimaryRunRecoveryCursor;
}

/**
 * One bounded database-driven receipt pass. The database is the index: this
 * scanner never watches or enumerates the receipt directory.
 */
export class PrimaryCompletionReceiptScanner {
  constructor(
    private readonly source: PrimaryRunRecoverySource,
    private readonly consumer: Pick<
      PrimaryCompletionReceiptConsumer,
      'consume'
    >,
  ) {}

  async scanBatch(
    options: {
      cursor?: PrimaryRunRecoveryCursor;
      limit?: number;
    } = {},
  ): Promise<PrimaryCompletionReceiptScanSummary> {
    const page = await this.source.listCandidates(options);
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
      unsafeAttemptOverflow: page.unsafeAttemptOverflow,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
    if (page.unsafeAttemptOverflow) return summary;

    for (const candidate of page.candidates) {
      if (candidate.attempts.length !== 1) {
        summary.ambiguous += 1;
        continue;
      }
      const attempt = candidate.attempts[0];
      if (attempt.executorType !== 'local_process') {
        summary.skipped += 1;
        continue;
      }
      try {
        const result = await this.consumer.consume(attempt.attemptId);
        if (result.status === 'missing') {
          summary.missing += 1;
          continue;
        }
        if (result.status === 'quarantined') {
          summary.quarantined += 1;
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
