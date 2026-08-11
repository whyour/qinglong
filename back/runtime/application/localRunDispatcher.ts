import { EXECUTOR_TYPES, type ExecutorType } from '../domain/execution';
import {
  assertRunDispatchCandidate,
  assertRunDispatchCandidatePageSize,
  type RunDispatchCandidate,
  type RunDispatchCandidateCursor,
} from '../domain/runDispatchCandidate';
import { assertRunDispatchLeaseVersion } from '../domain/runDispatchLease';
import { executionSpecForRunDispatchCandidate } from '../domain/runDispatchPlan';
import type { RunDispatchCandidateSource } from '../ports/runDispatchCandidateSource';
import type { LocalRunDispatchPlanSource } from '../ports/localRunDispatchPlanSource';
import type {
  ActivePrimaryRun,
  PrimaryClaimedRunStartCommand,
} from './primaryRunOrchestrator';
import {
  PrimaryClaimedRunRejectedError,
  PrimaryRunLaunchError,
} from './primaryRunOrchestrator';

const DEFAULT_LOCAL_DISPATCH_PAGE_SIZE = 8;
const DEFAULT_LOCAL_DISPATCH_MAX_PAGES = 1;
const MAX_LOCAL_DISPATCH_PAGES = 16;

export interface LocalClaimedRunActivator {
  activateClaimed(
    command: PrimaryClaimedRunStartCommand,
  ): Promise<ActivePrimaryRun>;
}

export interface LocalRunDispatcherOptions {
  executorType: ExecutorType;
  pageSize?: number;
  maxPages?: number;
  clock?: { now(): number };
  onDisposeError?: (error: unknown) => void;
}

export interface LocalRunDispatcherStats {
  pages: number;
  candidatesScanned: number;
  executorMismatches: number;
  plansUnavailable: number;
  activationRaces: number;
}

export type LocalRunDispatcherIdleReason =
  | 'no_candidates'
  | 'no_matching_executor'
  | 'plans_unavailable'
  | 'activation_raced'
  | 'scan_budget_exhausted';

export type LocalRunDispatcherResult =
  | {
      status: 'activated';
      runId: string;
      attemptId: string;
      completion: ActivePrimaryRun['completion'];
      stats: LocalRunDispatcherStats;
      truncated: boolean;
    }
  | {
      status: 'activation_failed';
      runId: string;
      attemptId: string;
      stats: LocalRunDispatcherStats;
      truncated: boolean;
    }
  | {
      status: 'idle';
      reason: LocalRunDispatcherIdleReason;
      stats: LocalRunDispatcherStats;
      truncated: boolean;
    };

function cursorOf(candidate: RunDispatchCandidate): RunDispatchCandidateCursor {
  return {
    priority: candidate.priority,
    queuedAtMs: candidate.queuedAtMs,
    attemptCreatedAtMs: candidate.attemptCreatedAtMs,
    attemptId: candidate.attemptId,
  };
}

function cursorAdvances(
  previous: RunDispatchCandidateCursor,
  next: RunDispatchCandidateCursor,
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

function emptyStats(): LocalRunDispatcherStats {
  return {
    pages: 0,
    candidatesScanned: 0,
    executorMismatches: 0,
    plansUnavailable: 0,
    activationRaces: 0,
  };
}

/** One bounded local dispatch cycle. It owns neither a timer nor task storage. */
export class LocalRunDispatcher {
  private readonly executorType: ExecutorType;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly clock: { now(): number };
  private readonly onDisposeError?: (error: unknown) => void;

  constructor(
    private readonly candidates: RunDispatchCandidateSource,
    private readonly plans: LocalRunDispatchPlanSource,
    private readonly activator: LocalClaimedRunActivator,
    options: LocalRunDispatcherOptions,
  ) {
    this.executorType = options.executorType;
    this.pageSize = options.pageSize ?? DEFAULT_LOCAL_DISPATCH_PAGE_SIZE;
    this.maxPages = options.maxPages ?? DEFAULT_LOCAL_DISPATCH_MAX_PAGES;
    this.clock = options.clock ?? Date;
    this.onDisposeError = options.onDisposeError;
    if (!EXECUTOR_TYPES.includes(this.executorType)) {
      throw new TypeError('Local Run Dispatcher executorType is invalid');
    }
    assertRunDispatchCandidatePageSize(this.pageSize);
    if (
      !Number.isSafeInteger(this.maxPages) ||
      this.maxPages < 1 ||
      this.maxPages > MAX_LOCAL_DISPATCH_PAGES
    ) {
      throw new RangeError(
        `maxPages must be between 1 and ${MAX_LOCAL_DISPATCH_PAGES}`,
      );
    }
  }

  async dispatchOnce(): Promise<LocalRunDispatcherResult> {
    const observedAtMs = this.clock.now();
    assertRunDispatchLeaseVersion('observedAtMs', observedAtMs);
    const stats = emptyStats();
    const seen = new Set<string>();
    let after: RunDispatchCandidateCursor | undefined;

    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const page = await this.candidates.listCandidates({
        observedAtMs,
        ...(after === undefined ? {} : { after }),
        limit: this.pageSize,
      });
      if (page.length > this.pageSize) {
        throw new RangeError('Local Run candidate source exceeded page size');
      }
      stats.pages += 1;
      let previous = after;
      for (const candidate of page) {
        assertRunDispatchCandidate(candidate);
        const cursor = cursorOf(candidate);
        if (
          seen.has(candidate.attemptId) ||
          (previous !== undefined && !cursorAdvances(previous, cursor))
        ) {
          throw new Error('Local Run candidate page is not strictly ordered');
        }
        seen.add(candidate.attemptId);
        previous = cursor;
        stats.candidatesScanned += 1;
        if (candidate.executorType !== this.executorType) {
          stats.executorMismatches += 1;
          continue;
        }

        const plan = await this.plans.prepare(Object.freeze({ ...candidate }));
        if (!plan) {
          stats.plansUnavailable += 1;
          continue;
        }
        try {
          const spec = executionSpecForRunDispatchCandidate(
            candidate,
            plan.executionSpec,
          );
          const active = await this.activator.activateClaimed({
            runId: candidate.runId,
            attemptId: candidate.attemptId,
            ...(spec.timeoutMs === undefined
              ? {}
              : { timeoutMs: spec.timeoutMs }),
            createSpec: () => spec,
            context: plan.context,
            ...(plan.logArtifactId === undefined
              ? {}
              : { logArtifactId: plan.logArtifactId }),
          });
          this.disposeAfterCompletion(active, plan.dispose);
          return {
            status: 'activated',
            runId: active.run.id,
            attemptId: active.attempt.id,
            completion: active.completion,
            stats,
            truncated: page.length === this.pageSize,
          };
        } catch (error) {
          await this.dispose(plan.dispose);
          if (error instanceof PrimaryClaimedRunRejectedError) {
            if (
              error.reason === 'aggregate_mismatch' ||
              error.reason === 'executor_mismatch'
            ) {
              throw error;
            }
            stats.activationRaces += 1;
            continue;
          }
          if (error instanceof PrimaryRunLaunchError) {
            return {
              status: 'activation_failed',
              runId: candidate.runId,
              attemptId: candidate.attemptId,
              stats,
              truncated: page.length === this.pageSize,
            };
          }
          throw error;
        }
      }

      if (page.length < this.pageSize) {
        return this.idle(stats, false);
      }
      after = cursorOf(page[page.length - 1]);
    }
    return {
      status: 'idle',
      reason: 'scan_budget_exhausted',
      stats,
      truncated: true,
    };
  }

  private idle(
    stats: LocalRunDispatcherStats,
    truncated: boolean,
  ): LocalRunDispatcherResult {
    const eligible = stats.candidatesScanned - stats.executorMismatches;
    const reason: LocalRunDispatcherIdleReason =
      stats.candidatesScanned === 0
        ? 'no_candidates'
        : eligible === 0
        ? 'no_matching_executor'
        : stats.plansUnavailable === eligible
        ? 'plans_unavailable'
        : 'activation_raced';
    return { status: 'idle', reason, stats, truncated };
  }

  private disposeAfterCompletion(
    active: ActivePrimaryRun,
    dispose: (() => void | Promise<void>) | undefined,
  ): void {
    if (!dispose) return;
    void active.completion.then(
      () => this.dispose(dispose),
      () => this.dispose(dispose),
    );
  }

  private async dispose(
    dispose: (() => void | Promise<void>) | undefined,
  ): Promise<void> {
    if (!dispose) return;
    try {
      await dispose();
    } catch (error) {
      try {
        this.onDisposeError?.(error);
      } catch {
        // Diagnostics must not change activation ownership.
      }
    }
  }
}
