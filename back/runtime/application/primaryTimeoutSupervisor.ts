import {
  MAX_PRIMARY_TIMEOUT_BATCH_SIZE,
  type PrimaryTimeoutCursor,
} from '../ports/primaryTimeoutSource';
import type {
  PrimaryTimeoutRequester,
  PrimaryTimeoutRequestSummary,
} from './primaryTimeoutRequester';

export const MAX_PRIMARY_TIMEOUT_SUPERVISOR_PAGES = 64;

export type PrimaryTimeoutStopReason =
  | 'complete'
  | 'page_limit'
  | 'cursor_stalled';

export interface PrimaryTimeoutSupervisorSummary {
  pages: number;
  scanned: number;
  accepted: number;
  alreadyRequested: number;
  alreadyTerminal: number;
  failed: number;
  stopReason: PrimaryTimeoutStopReason;
  remaining: boolean;
  nextCursor?: PrimaryTimeoutCursor;
}

export interface PrimaryTimeoutSupervisorOptions {
  nowMs?: number;
  pageSize?: number;
  maxPages?: number;
  cursor?: PrimaryTimeoutCursor;
}

export interface PrimaryTimeoutSupervisorClock {
  now(): number;
}

function sameCursor(
  left: PrimaryTimeoutCursor | undefined,
  right: PrimaryTimeoutCursor | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.deadlineAtMs === right.deadlineAtMs &&
    left.attemptId === right.attemptId
  );
}

export class PrimaryTimeoutSupervisor {
  constructor(
    private readonly requester: Pick<PrimaryTimeoutRequester, 'requestBatch'>,
    private readonly clock: PrimaryTimeoutSupervisorClock = { now: Date.now },
  ) {}

  async run(
    options: PrimaryTimeoutSupervisorOptions = {},
  ): Promise<PrimaryTimeoutSupervisorSummary> {
    const pageSize = options.pageSize ?? 32;
    const maxPages = options.maxPages ?? 4;
    const nowMs = options.nowMs ?? this.clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError('nowMs must be a non-negative safe integer');
    }
    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAX_PRIMARY_TIMEOUT_BATCH_SIZE
    ) {
      throw new RangeError(
        'pageSize must be between 1 and MAX_PRIMARY_TIMEOUT_BATCH_SIZE',
      );
    }
    if (
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > MAX_PRIMARY_TIMEOUT_SUPERVISOR_PAGES
    ) {
      throw new RangeError(
        'maxPages must be between 1 and MAX_PRIMARY_TIMEOUT_SUPERVISOR_PAGES',
      );
    }

    const aggregate: PrimaryTimeoutSupervisorSummary = {
      pages: 0,
      scanned: 0,
      accepted: 0,
      alreadyRequested: 0,
      alreadyTerminal: 0,
      failed: 0,
      stopReason: 'complete',
      remaining: false,
    };
    let cursor = options.cursor;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page: PrimaryTimeoutRequestSummary =
        await this.requester.requestBatch({
          nowMs,
          ...(cursor === undefined ? {} : { cursor }),
          limit: pageSize,
        });
      aggregate.pages += 1;
      aggregate.scanned += page.scanned;
      aggregate.accepted += page.accepted;
      aggregate.alreadyRequested += page.alreadyRequested;
      aggregate.alreadyTerminal += page.alreadyTerminal;
      aggregate.failed += page.failed;

      if (!page.truncated) return aggregate;
      if (!page.nextCursor || sameCursor(cursor, page.nextCursor)) {
        aggregate.stopReason = 'cursor_stalled';
        aggregate.remaining = true;
        if (page.nextCursor) aggregate.nextCursor = page.nextCursor;
        return aggregate;
      }
      cursor = page.nextCursor;
    }
    aggregate.stopReason = 'page_limit';
    aggregate.remaining = true;
    if (cursor) aggregate.nextCursor = cursor;
    return aggregate;
  }
}
