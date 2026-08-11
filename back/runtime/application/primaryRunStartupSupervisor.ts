import { MAX_PRIMARY_RECOVERY_BATCH_SIZE } from '../ports/primaryRunRecoverySource';
import type { PrimaryRunRecoveryCursor } from '../ports/primaryRunRecoverySource';
import type {
  PrimaryRunStartupReconcileSummary,
  PrimaryRunStartupReconciler,
} from './primaryRunStartupReconciler';

export const MAX_PRIMARY_RECOVERY_PAGES_PER_STARTUP = 64;

export type PrimaryRunStartupStopReason =
  | 'complete'
  | 'page_limit'
  | 'unsafe_attempt_overflow'
  | 'cursor_stalled';

export interface PrimaryRunStartupSummary
  extends Omit<
    PrimaryRunStartupReconcileSummary,
    'truncated' | 'unsafeAttemptOverflow' | 'nextCursor'
  > {
  pages: number;
  stopReason: PrimaryRunStartupStopReason;
  remaining: boolean;
  nextCursor?: PrimaryRunRecoveryCursor;
}

export interface PrimaryRunStartupOptions {
  cursor?: PrimaryRunRecoveryCursor;
  pageSize?: number;
  maxPages?: number;
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

/** Runs a complete but bounded startup reconciliation before Primary activates. */
export class PrimaryRunStartupSupervisor {
  constructor(
    private readonly reconciler: Pick<
      PrimaryRunStartupReconciler,
      'reconcileBatch'
    >,
  ) {}

  async run(
    options: PrimaryRunStartupOptions = {},
  ): Promise<PrimaryRunStartupSummary> {
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
      maxPages > MAX_PRIMARY_RECOVERY_PAGES_PER_STARTUP
    ) {
      throw new RangeError(
        'maxPages must be between 1 and MAX_PRIMARY_RECOVERY_PAGES_PER_STARTUP',
      );
    }

    const total: PrimaryRunStartupSummary = {
      pages: 0,
      scanned: 0,
      verifiedRunning: 0,
      recoveredRunning: 0,
      completedFromReceipt: 0,
      quarantinedReceipts: 0,
      publishGraceWaits: 0,
      markedLost: 0,
      skipped: 0,
      ambiguous: 0,
      failed: 0,
      stopReason: 'complete',
      remaining: false,
    };
    let cursor = options.cursor;

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await this.reconciler.reconcileBatch({
        ...(cursor === undefined ? {} : { cursor }),
        limit: pageSize,
      });
      total.pages += 1;
      total.scanned += page.scanned;
      total.verifiedRunning += page.verifiedRunning;
      total.recoveredRunning += page.recoveredRunning;
      total.completedFromReceipt += page.completedFromReceipt;
      total.quarantinedReceipts += page.quarantinedReceipts;
      total.publishGraceWaits += page.publishGraceWaits;
      total.markedLost += page.markedLost;
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
