import {
  MAX_PRIMARY_RECOVERY_BATCH_SIZE,
  type PrimaryRunRecoveryCursor,
} from '../ports/primaryRunRecoverySource';
import type {
  PrimaryCompletionReceiptScanner,
  PrimaryCompletionReceiptScanSummary,
} from './primaryCompletionReceiptScanner';

export const MAX_PRIMARY_COMPLETION_RECEIPT_PAGES = 64;

export type PrimaryCompletionReceiptStopReason =
  | 'complete'
  | 'page_limit'
  | 'unsafe_attempt_overflow'
  | 'cursor_stalled';

export interface PrimaryCompletionReceiptSupervisorOptions {
  cursor?: PrimaryRunRecoveryCursor;
  pageSize?: number;
  maxPages?: number;
}

export interface PrimaryCompletionReceiptSupervisorSummary
  extends Omit<
    PrimaryCompletionReceiptScanSummary,
    'truncated' | 'unsafeAttemptOverflow' | 'nextCursor'
  > {
  pages: number;
  stopReason: PrimaryCompletionReceiptStopReason;
  remaining: boolean;
  nextCursor?: PrimaryRunRecoveryCursor;
}

function sameCursor(
  left: PrimaryRunRecoveryCursor | undefined,
  right: PrimaryRunRecoveryCursor,
): boolean {
  return (
    left !== undefined &&
    left.createdAtMs === right.createdAtMs &&
    left.runId === right.runId
  );
}

export class PrimaryCompletionReceiptSupervisor {
  constructor(
    private readonly scanner: Pick<
      PrimaryCompletionReceiptScanner,
      'scanBatch'
    >,
  ) {}

  async run(
    options: PrimaryCompletionReceiptSupervisorOptions = {},
  ): Promise<PrimaryCompletionReceiptSupervisorSummary> {
    const pageSize = options.pageSize ?? 32;
    const maxPages = options.maxPages ?? 4;
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAX_PRIMARY_RECOVERY_BATCH_SIZE
    ) {
      throw new RangeError(
        'pageSize must be between 1 and MAX_PRIMARY_RECOVERY_BATCH_SIZE',
      );
    }
    if (
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > MAX_PRIMARY_COMPLETION_RECEIPT_PAGES
    ) {
      throw new RangeError(
        'maxPages must be between 1 and MAX_PRIMARY_COMPLETION_RECEIPT_PAGES',
      );
    }

    const total: PrimaryCompletionReceiptSupervisorSummary = {
      pages: 0,
      scanned: 0,
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
      stopReason: 'complete',
      remaining: false,
    };
    let cursor = options.cursor;

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await this.scanner.scanBatch({
        ...(cursor === undefined ? {} : { cursor }),
        limit: pageSize,
      });
      total.pages += 1;
      total.scanned += page.scanned;
      total.applied += page.applied;
      total.alreadyTerminal += page.alreadyTerminal;
      total.quarantined += page.quarantined;
      total.purgedQuarantines += page.purgedQuarantines;
      total.expiredMissing += page.expiredMissing;
      total.missing += page.missing;
      total.cleanupPending += page.cleanupPending;
      total.skipped += page.skipped;
      total.ambiguous += page.ambiguous;
      total.failed += page.failed;

      if (page.unsafeAttemptOverflow) {
        total.stopReason = 'unsafe_attempt_overflow';
        total.remaining = true;
        return total;
      }
      if (!page.truncated) return total;
      if (!page.nextCursor || sameCursor(cursor, page.nextCursor)) {
        total.stopReason = 'cursor_stalled';
        total.remaining = true;
        if (page.nextCursor) total.nextCursor = page.nextCursor;
        return total;
      }
      cursor = page.nextCursor;
      if (pageNumber === maxPages - 1) {
        total.stopReason = 'page_limit';
        total.remaining = true;
        total.nextCursor = cursor;
        return total;
      }
    }
    return total;
  }
}
