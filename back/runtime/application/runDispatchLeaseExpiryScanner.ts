import { assertRunDispatchLeaseVersion } from '../domain/runDispatchLease';
import {
  MAX_RUN_DISPATCH_LEASE_EXPIRY_PAGE_SIZE,
  type RunDispatchLeaseExpiryCursor,
  type RunDispatchLeaseExpirySource,
} from '../ports/runDispatchLeaseExpirySource';
import type {
  RunDispatchLeaseExpiryResult,
  RunDispatchLeaseExpiryService,
  RunDispatchLeaseExpiryStatus,
} from './runDispatchLeaseExpiryService';

export interface RunDispatchLeaseExpiryScanSummary {
  observedAtMs: number;
  scanned: number;
  counts: Readonly<Record<RunDispatchLeaseExpiryStatus, number>>;
  failed: number;
  truncated: boolean;
  nextCursor?: RunDispatchLeaseExpiryCursor;
}

const STATUSES: readonly RunDispatchLeaseExpiryStatus[] = [
  'lost',
  'cancellation_pending',
  'unstarted_released',
  'terminal_released',
  'already_expired',
  'not_due',
  'not_eligible',
  'not_found',
];

/** One bounded expiry page. The caller owns cadence and cursor persistence. */
export class RunDispatchLeaseExpiryScanner {
  private readonly clock: { now(): number };

  constructor(
    private readonly source: RunDispatchLeaseExpirySource,
    private readonly service: Pick<RunDispatchLeaseExpiryService, 'reconcile'>,
    options: { clock?: { now(): number } } = {},
  ) {
    this.clock = options.clock ?? Date;
  }

  async scan(
    options: { after?: RunDispatchLeaseExpiryCursor; limit?: number } = {},
  ): Promise<RunDispatchLeaseExpiryScanSummary> {
    const observedAtMs = this.now();
    const limit = options.limit ?? 16;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_RUN_DISPATCH_LEASE_EXPIRY_PAGE_SIZE
    ) {
      throw new RangeError(
        `limit must be between 1 and ${MAX_RUN_DISPATCH_LEASE_EXPIRY_PAGE_SIZE}`,
      );
    }
    const candidates = await this.source.listExpired({
      observedAtMs,
      ...(options.after === undefined ? {} : { after: options.after }),
      limit,
    });
    if (candidates.length > limit) {
      throw new RangeError('Run lease expiry source exceeded page size');
    }
    const counts = Object.fromEntries(
      STATUSES.map((status) => [status, 0]),
    ) as Record<RunDispatchLeaseExpiryStatus, number>;
    let failed = 0;
    let previous = options.after;
    let resumeCursor = options.after;
    for (const candidate of candidates) {
      if (
        candidate.expiresAtMs > observedAtMs ||
        (previous !== undefined &&
          (candidate.expiresAtMs < previous.expiresAtMs ||
            (candidate.expiresAtMs === previous.expiresAtMs &&
              candidate.attemptId <= previous.attemptId)))
      ) {
        throw new TypeError('Run lease expiry cursor did not advance');
      }
      previous = {
        expiresAtMs: candidate.expiresAtMs,
        attemptId: candidate.attemptId,
      };
      try {
        const result: RunDispatchLeaseExpiryResult =
          await this.service.reconcile(candidate.runId, candidate.attemptId);
        counts[result.status] += 1;
      } catch {
        failed += 1;
        return {
          observedAtMs,
          scanned: candidates.length,
          counts,
          failed,
          truncated: true,
          ...(resumeCursor === undefined
            ? {}
            : { nextCursor: resumeCursor }),
        };
      }
      resumeCursor = previous;
    }
    const truncated = candidates.length === limit;
    return {
      observedAtMs,
      scanned: candidates.length,
      counts,
      failed,
      truncated,
      ...(truncated && resumeCursor !== undefined
        ? { nextCursor: resumeCursor }
        : {}),
    };
  }

  private now(): number {
    const nowMs = this.clock.now();
    assertRunDispatchLeaseVersion('observedAtMs', nowMs);
    return nowMs;
  }
}
