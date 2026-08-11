import type { RunLostRetryStatus } from './runLostRetryService';
import type {
  RunLostRetrySource,
  RunLostRetryCandidate,
} from '../ports/runLostRetrySource';
import { MAX_RUN_LOST_RETRY_PAGE_SIZE } from '../ports/runLostRetrySource';

export interface RunLostRetryReconciler {
  reconcile(runId: string): Promise<{ status: RunLostRetryStatus }>;
}

export interface RunLostRetryScanSummary {
  observedAtMs: number;
  scanned: number;
  failed: number;
  truncated: boolean;
  counts: Readonly<Partial<Record<RunLostRetryStatus, number>>>;
  failures: readonly { runId: string; reason: 'reconcile_failed' }[];
}

export class RunLostRetryScanner {
  private readonly clock: { now(): number };

  constructor(
    private readonly source: RunLostRetrySource,
    private readonly reconciler: RunLostRetryReconciler,
    options: { clock?: { now(): number } } = {},
  ) {
    this.clock = options.clock ?? Date;
  }

  async scan(
    options: { limit?: number } = {},
  ): Promise<RunLostRetryScanSummary> {
    const observedAtMs = this.clock.now();
    const limit = options.limit ?? 16;
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new RangeError('observedAtMs must be a non-negative safe integer');
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_RUN_LOST_RETRY_PAGE_SIZE
    ) {
      throw new RangeError(
        `limit must be between 1 and ${MAX_RUN_LOST_RETRY_PAGE_SIZE}`,
      );
    }
    const candidates = await this.source.listCandidates({
      observedAtMs,
      limit,
    });
    this.assertPage(candidates, observedAtMs, limit);
    const counts: Partial<Record<RunLostRetryStatus, number>> = {};
    const failures: { runId: string; reason: 'reconcile_failed' }[] = [];
    for (const candidate of candidates) {
      try {
        const result = await this.reconciler.reconcile(candidate.runId);
        counts[result.status] = (counts[result.status] ?? 0) + 1;
      } catch {
        failures.push({
          runId: candidate.runId,
          reason: 'reconcile_failed',
        });
      }
    }
    return {
      observedAtMs,
      scanned: candidates.length,
      failed: failures.length,
      truncated: candidates.length === limit,
      counts,
      failures,
    };
  }

  private assertPage(
    candidates: readonly RunLostRetryCandidate[],
    observedAtMs: number,
    limit: number,
  ): void {
    if (candidates.length > limit) {
      throw new TypeError('Lost retry source exceeded page size');
    }
    let previous: RunLostRetryCandidate | undefined;
    for (const candidate of candidates) {
      if (
        !candidate.runId ||
        (candidate.phase !== 'lost' && candidate.phase !== 'retry_wait') ||
        !Number.isSafeInteger(candidate.availableAtMs) ||
        candidate.availableAtMs < 0 ||
        candidate.availableAtMs > observedAtMs
      ) {
        throw new TypeError('Lost retry source returned an invalid candidate');
      }
      if (
        previous &&
        (candidate.availableAtMs < previous.availableAtMs ||
          (candidate.availableAtMs === previous.availableAtMs &&
            candidate.runId <= previous.runId))
      ) {
        throw new TypeError('Lost retry source page is not strictly ordered');
      }
      previous = candidate;
    }
  }
}
