import {
  LOCAL_PROCESS_EXECUTOR_TYPE,
  assertLocalDispatchPageSize,
  normalizeLocalDispatchCandidate,
  type LocalDispatchCandidate,
  type LocalDispatchCandidateCursor,
  type LocalDispatchCandidateSource,
} from '@qinglong/runtime-core/local-dispatch';
import {
  LocalExecutionLaunchError,
  LocalExecutionRejectedError,
  type LocalExecutionStartCommand,
  type LocalExecutionStartResult,
} from '../execution/coordinator';
import type { LocalDispatchPlanSource } from './materializer';

export interface LocalDispatchActivator {
  start(
    command: LocalExecutionStartCommand,
  ): Promise<LocalExecutionStartResult>;
}

export interface LocalRunDispatcherOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly onCompletion?: (attemptId: string) => void | Promise<void>;
}

export interface LocalRunDispatcherStats {
  readonly pages: number;
  readonly candidatesScanned: number;
  readonly plansUnavailable: number;
  readonly activationRaces: number;
}

export type LocalRunDispatcherResult =
  | Readonly<{
      status: 'activated';
      runId: string;
      attemptId: string;
      stats: LocalRunDispatcherStats;
      truncated: boolean;
    }>
  | Readonly<{
      status: 'activation_failed';
      runId: string;
      attemptId: string;
      stats: LocalRunDispatcherStats;
      truncated: boolean;
    }>
  | Readonly<{
      status: 'idle';
      reason:
        | 'no_candidates'
        | 'plans_unavailable'
        | 'activation_raced'
        | 'scan_budget_exhausted';
      stats: LocalRunDispatcherStats;
      truncated: boolean;
    }>;

function cursorOf(
  candidate: LocalDispatchCandidate,
): LocalDispatchCandidateCursor {
  return Object.freeze({
    priority: candidate.priority,
    queuedAtMs: candidate.queuedAtMs,
    attemptCreatedAtMs: candidate.attemptCreatedAtMs,
    attemptId: candidate.attemptId,
  });
}

function advances(
  previous: LocalDispatchCandidateCursor,
  next: LocalDispatchCandidateCursor,
): boolean {
  return (
    next.priority < previous.priority ||
    (next.priority === previous.priority &&
      (next.queuedAtMs > previous.queuedAtMs ||
        (next.queuedAtMs === previous.queuedAtMs &&
          (next.attemptCreatedAtMs > previous.attemptCreatedAtMs ||
            (next.attemptCreatedAtMs === previous.attemptCreatedAtMs &&
              next.attemptId > previous.attemptId)))))
  );
}

export class LocalRunDispatcher {
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly onCompletion?: LocalRunDispatcherOptions['onCompletion'];

  constructor(
    private readonly candidates: LocalDispatchCandidateSource,
    private readonly plans: LocalDispatchPlanSource,
    private readonly activator: LocalDispatchActivator,
    options: LocalRunDispatcherOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 8;
    this.maxPages = options.maxPages ?? 1;
    this.onCompletion = options.onCompletion;
    assertLocalDispatchPageSize(this.pageSize);
    if (
      !Number.isSafeInteger(this.maxPages) ||
      this.maxPages < 1 ||
      this.maxPages > 16
    ) {
      throw new RangeError('Local dispatch maxPages must be between 1 and 16');
    }
  }

  async dispatchOnce(): Promise<LocalRunDispatcherResult> {
    const stats = {
      pages: 0,
      candidatesScanned: 0,
      plansUnavailable: 0,
      activationRaces: 0,
    };
    const seen = new Set<string>();
    let after: LocalDispatchCandidateCursor | undefined;
    let truncated = false;
    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const page = await this.candidates.listLocalDispatchCandidates({
        limit: this.pageSize,
        ...(after === undefined ? {} : { after }),
      });
      if (page.candidates.length > this.pageSize) {
        throw new RangeError('Local dispatch source exceeded its page size');
      }
      stats.pages += 1;
      truncated = page.truncated;
      let previous = after;
      for (const value of page.candidates) {
        const candidate = normalizeLocalDispatchCandidate(value);
        if (candidate.executorType !== LOCAL_PROCESS_EXECUTOR_TYPE) {
          throw new TypeError(
            'Local dispatch source returned another executor',
          );
        }
        const cursor = cursorOf(candidate);
        if (
          seen.has(candidate.attemptId) ||
          (previous !== undefined && !advances(previous, cursor))
        ) {
          throw new TypeError('Local dispatch page is not strictly ordered');
        }
        seen.add(candidate.attemptId);
        previous = cursor;
        stats.candidatesScanned += 1;
        const plan = await this.plans.prepare(candidate);
        if (!plan) {
          stats.plansUnavailable += 1;
          continue;
        }
        try {
          const active = await this.activator.start(plan.command);
          void active.handle.completion
            .then(
              () => this.onCompletion?.(active.attempt.id),
              () => this.onCompletion?.(active.attempt.id),
            )
            .catch(() => undefined);
          return Object.freeze({
            status: 'activated' as const,
            runId: active.run.id,
            attemptId: active.attempt.id,
            stats: Object.freeze({ ...stats }),
            truncated,
          });
        } catch (error) {
          if (error instanceof LocalExecutionRejectedError) {
            if (
              error.reason === 'aggregate_mismatch' ||
              error.reason === 'executor_mismatch'
            ) {
              throw error;
            }
            stats.activationRaces += 1;
            continue;
          }
          if (error instanceof LocalExecutionLaunchError) {
            return Object.freeze({
              status: 'activation_failed' as const,
              runId: candidate.runId,
              attemptId: candidate.attemptId,
              stats: Object.freeze({ ...stats }),
              truncated,
            });
          }
          throw error;
        }
      }
      if (!page.truncated) return this.idle(stats, false);
      const last = page.candidates.at(-1);
      if (!last) {
        throw new TypeError(
          'Local dispatch source reported an empty truncated page',
        );
      }
      after = cursorOf(last);
    }
    return Object.freeze({
      status: 'idle' as const,
      reason: 'scan_budget_exhausted' as const,
      stats: Object.freeze({ ...stats }),
      truncated: true,
    });
  }

  private idle(
    stats: LocalRunDispatcherStats,
    truncated: boolean,
  ): LocalRunDispatcherResult {
    const reason =
      stats.candidatesScanned === 0
        ? 'no_candidates'
        : stats.plansUnavailable === stats.candidatesScanned
        ? 'plans_unavailable'
        : 'activation_raced';
    return Object.freeze({
      status: 'idle' as const,
      reason,
      stats: Object.freeze({ ...stats }),
      truncated,
    });
  }
}
