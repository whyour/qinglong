import { MAX_PRIMARY_CANCELLATION_BATCH_SIZE } from '../ports/primaryCancellationSource';
import type { PrimaryCancellationCursor } from '../ports/primaryCancellationSource';
import type {
  PrimaryCancellationDispatcher,
  PrimaryCancellationDispatchSummary,
} from './primaryCancellationDispatcher';

export const MAX_PRIMARY_CANCELLATION_PAGES_PER_CYCLE = 64;

export type PrimaryCancellationCycleStopReason =
  | 'complete'
  | 'page_limit'
  | 'unsafe_attempt_overflow'
  | 'cursor_stalled';

export interface PrimaryCancellationCycleSummary
  extends Omit<
    PrimaryCancellationDispatchSummary,
    'truncated' | 'unsafeAttemptOverflow' | 'nextCursor'
  > {
  pages: number;
  stopReason: PrimaryCancellationCycleStopReason;
  remaining: boolean;
  nextCursor?: PrimaryCancellationCursor;
}

export interface PrimaryCancellationCycleOptions {
  cursor?: PrimaryCancellationCursor;
  pageSize?: number;
  maxPages?: number;
}

function sameCursor(
  left: PrimaryCancellationCursor | undefined,
  right: PrimaryCancellationCursor,
): boolean {
  return (
    left !== undefined &&
    left.requestedAtMs === right.requestedAtMs &&
    left.runId === right.runId
  );
}

/**
 * Runs a bounded recovery cycle. It deliberately owns no timer or process hook;
 * edge and cluster deployments choose their own cadence and lifecycle.
 */
export class PrimaryCancellationSupervisor {
  constructor(
    private readonly dispatcher: Pick<
      PrimaryCancellationDispatcher,
      'dispatchBatch'
    >,
  ) {}

  async runCycle(
    options: PrimaryCancellationCycleOptions = {},
  ): Promise<PrimaryCancellationCycleSummary> {
    const pageSize = options.pageSize ?? 32;
    const maxPages = options.maxPages ?? 4;
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAX_PRIMARY_CANCELLATION_BATCH_SIZE
    ) {
      throw new RangeError(
        'pageSize must be between 1 and MAX_PRIMARY_CANCELLATION_BATCH_SIZE',
      );
    }
    if (
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > MAX_PRIMARY_CANCELLATION_PAGES_PER_CYCLE
    ) {
      throw new RangeError(
        'maxPages must be between 1 and MAX_PRIMARY_CANCELLATION_PAGES_PER_CYCLE',
      );
    }

    const total: PrimaryCancellationCycleSummary = {
      pages: 0,
      scanned: 0,
      claimed: 0,
      terminationRequested: 0,
      alreadyExited: 0,
      pending: 0,
      ambiguous: 0,
      blocked: 0,
      deferred: 0,
      alreadyResolved: 0,
      notEligible: 0,
      failed: 0,
      stopReason: 'complete',
      remaining: false,
    };
    let cursor = options.cursor;

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await this.dispatcher.dispatchBatch({
        ...(cursor === undefined ? {} : { cursor }),
        limit: pageSize,
      });
      total.pages += 1;
      total.scanned += page.scanned;
      total.claimed += page.claimed;
      total.terminationRequested += page.terminationRequested;
      total.alreadyExited += page.alreadyExited;
      total.pending += page.pending;
      total.ambiguous += page.ambiguous;
      total.blocked += page.blocked;
      total.deferred += page.deferred;
      total.alreadyResolved += page.alreadyResolved;
      total.notEligible += page.notEligible;
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
