import { v7 as uuidV7 } from 'uuid';
import {
  assertRunDispatchCandidate,
  assertRunDispatchCandidatePageSize,
  type RunDispatchCandidate,
  type RunDispatchCandidateCursor,
} from '../domain/runDispatchCandidate';
import {
  assertRunDispatchLeaseToken,
  assertRunDispatchLeaseVersion,
  RunDispatchLeaseFenceRejectedError,
} from '../domain/runDispatchLease';
import {
  createExecutionSpecDigest,
  createRunDispatchOfferId,
  type RunDispatcherIdleReason,
  type RunDispatcherResult,
  type RunDispatcherStats,
} from '../domain/runDispatchOffer';
import {
  assertRecoverableRunDispatch,
  assertRunDispatchRecoveryPageSize,
  type RunDispatchRecoveryCursor,
} from '../domain/runDispatchRecovery';
import {
  MAX_PLACEMENT_CANDIDATES,
  normalizeWorkerPlacementSpec,
  selectWorkerCandidates,
  type WorkerPlacementSpec,
} from '../domain/workerPlacement';
import type { RunDispatchCandidateSource } from '../ports/runDispatchCandidateSource';
import type { ClaimRunDispatchLeaseResult } from '../ports/runDispatchLeaseRepository';
import type { RunDispatchPlanSource } from '../ports/runDispatchPlanSource';
import type { RunDispatchRecoverySource } from '../ports/runDispatchRecoverySource';
import { executionSpecForRunDispatchCandidate } from '../domain/runDispatchPlan';
import {
  MAX_AVAILABLE_WORKER_PAGE_SIZE,
  type WorkerRegistryRepository,
} from '../ports/workerRegistryRepository';
import type { ClaimRunDispatchLeaseRequest } from './runDispatchLeaseService';
import type { AuthenticatedWorkerPrincipal } from './workerControlService';

const DEFAULT_CANDIDATE_PAGE_SIZE = 8;
const DEFAULT_MAX_CANDIDATE_PAGES = 2;
const DEFAULT_RECOVERY_PAGE_SIZE = 8;
const DEFAULT_MAX_RECOVERY_PAGES = 2;
const DEFAULT_WORKER_PAGE_SIZE = 8;
const DEFAULT_MAX_WORKER_PAGES = 2;
const DEFAULT_MAX_CLAIM_ATTEMPTS = 8;
const MAX_DISPATCH_SCAN_PAGES = 16;

export interface RunDispatchClaimer {
  claim(
    principal: AuthenticatedWorkerPrincipal,
    request: ClaimRunDispatchLeaseRequest,
  ): Promise<ClaimRunDispatchLeaseResult>;
}

export interface RunDispatcherOptions {
  recoveryPageSize?: number;
  maxRecoveryPages?: number;
  candidatePageSize?: number;
  maxCandidatePages?: number;
  workerPageSize?: number;
  maxWorkerPages?: number;
  maxClaimAttempts?: number;
  clock?: { now(): number };
  createLeaseToken?: () => string;
}

interface CandidatePageState {
  candidates: RunDispatchCandidate[];
  cursor?: RunDispatchCandidateCursor;
  more: boolean;
}

function assertIntegerBetween(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

function cursorOf(candidate: RunDispatchCandidate): RunDispatchCandidateCursor {
  return {
    priority: candidate.priority,
    queuedAtMs: candidate.queuedAtMs,
    attemptCreatedAtMs: candidate.attemptCreatedAtMs,
    attemptId: candidate.attemptId,
  };
}

function cursorKey(cursor: RunDispatchCandidateCursor): string {
  return `${cursor.priority}\0${cursor.queuedAtMs}\0${cursor.attemptCreatedAtMs}\0${cursor.attemptId}`;
}

function effectivePlacement(
  placementValue: unknown,
  executorType: string,
): WorkerPlacementSpec {
  const placement = normalizeWorkerPlacementSpec(placementValue);
  const configuredExecutors = placement.required?.executors;
  if (
    configuredExecutors !== undefined &&
    !configuredExecutors.includes(executorType)
  ) {
    throw new TypeError(
      'Run dispatch plan executor placement does not match its candidate',
    );
  }
  return {
    ...placement,
    required: {
      ...placement.required,
      executors: configuredExecutors ?? [executorType],
    },
  };
}

function emptyStats(): RunDispatcherStats {
  return {
    recoveryPages: 0,
    recoveriesScanned: 0,
    recoveryPlansUnavailable: 0,
    candidatePages: 0,
    candidatesScanned: 0,
    workerPages: 0,
    workersScanned: 0,
    plansUnavailable: 0,
    matchingWorkers: 0,
    claimAttempts: 0,
    claimRaces: 0,
  };
}

/** One bounded dispatch cycle. The caller owns scheduling and offer delivery. */
export class RunDispatcher {
  private readonly recoveryPageSize: number;
  private readonly maxRecoveryPages: number;
  private readonly candidatePageSize: number;
  private readonly maxCandidatePages: number;
  private readonly workerPageSize: number;
  private readonly maxWorkerPages: number;
  private readonly maxClaimAttempts: number;
  private readonly clock: { now(): number };
  private readonly createLeaseToken: () => string;

  constructor(
    private readonly recoveries: RunDispatchRecoverySource,
    private readonly candidates: RunDispatchCandidateSource,
    private readonly workers: WorkerRegistryRepository,
    private readonly plans: RunDispatchPlanSource,
    private readonly leases: RunDispatchClaimer,
    options: RunDispatcherOptions = {},
  ) {
    this.recoveryPageSize =
      options.recoveryPageSize ?? DEFAULT_RECOVERY_PAGE_SIZE;
    this.maxRecoveryPages =
      options.maxRecoveryPages ?? DEFAULT_MAX_RECOVERY_PAGES;
    this.candidatePageSize =
      options.candidatePageSize ?? DEFAULT_CANDIDATE_PAGE_SIZE;
    this.maxCandidatePages =
      options.maxCandidatePages ?? DEFAULT_MAX_CANDIDATE_PAGES;
    this.workerPageSize = options.workerPageSize ?? DEFAULT_WORKER_PAGE_SIZE;
    this.maxWorkerPages = options.maxWorkerPages ?? DEFAULT_MAX_WORKER_PAGES;
    this.maxClaimAttempts =
      options.maxClaimAttempts ?? DEFAULT_MAX_CLAIM_ATTEMPTS;
    this.clock = options.clock ?? Date;
    this.createLeaseToken = options.createLeaseToken ?? uuidV7;

    assertRunDispatchRecoveryPageSize(this.recoveryPageSize);
    assertIntegerBetween(
      'maxRecoveryPages',
      this.maxRecoveryPages,
      1,
      MAX_DISPATCH_SCAN_PAGES,
    );
    assertRunDispatchCandidatePageSize(this.candidatePageSize);
    assertIntegerBetween(
      'maxCandidatePages',
      this.maxCandidatePages,
      1,
      MAX_DISPATCH_SCAN_PAGES,
    );
    assertIntegerBetween(
      'workerPageSize',
      this.workerPageSize,
      1,
      MAX_AVAILABLE_WORKER_PAGE_SIZE,
    );
    assertIntegerBetween(
      'maxWorkerPages',
      this.maxWorkerPages,
      1,
      MAX_DISPATCH_SCAN_PAGES,
    );
    if (this.workerPageSize * this.maxWorkerPages > MAX_PLACEMENT_CANDIDATES) {
      throw new RangeError(
        `workerPageSize * maxWorkerPages must not exceed ${MAX_PLACEMENT_CANDIDATES}`,
      );
    }
    assertIntegerBetween(
      'maxClaimAttempts',
      this.maxClaimAttempts,
      1,
      MAX_PLACEMENT_CANDIDATES,
    );
  }

  async dispatchOnce(): Promise<RunDispatcherResult> {
    const observedAtMs = this.now();
    const stats = emptyStats();
    const recoveryResult = await this.recoverOffer(observedAtMs, stats);
    if (recoveryResult) return recoveryResult;

    const seenAttempts = new Set<string>();
    let page = await this.loadCandidatePage(
      observedAtMs,
      undefined,
      seenAttempts,
      stats,
    );
    if (page.candidates.length === 0) {
      return this.idle(
        stats.recoveryPlansUnavailable > 0
          ? 'recovery_plans_unavailable'
          : 'no_candidates',
        stats,
        false,
      );
    }

    const workerState = await this.loadWorkers(observedAtMs, stats);
    if (workerState.workers.length === 0) {
      return this.idle('no_workers', stats, workerState.truncated);
    }

    let raced = false;
    while (true) {
      for (const candidate of page.candidates) {
        stats.candidatesScanned += 1;
        const plan = await this.plans.prepare({ ...candidate });
        if (!plan) {
          stats.plansUnavailable += 1;
          continue;
        }
        const executionSpec = executionSpecForRunDispatchCandidate(
          candidate,
          plan.executionSpec,
        );
        const selected = selectWorkerCandidates(
          workerState.workers,
          effectivePlacement(plan.placement, candidate.executorType),
          observedAtMs,
          MAX_PLACEMENT_CANDIDATES,
        );
        stats.matchingWorkers += selected.length;
        if (selected.length === 0) continue;
        for (const selectedWorker of selected) {
          if (stats.claimAttempts >= this.maxClaimAttempts) {
            return this.idle('claim_budget_exhausted', stats, true);
          }
          const leaseToken = this.createLeaseToken();
          assertRunDispatchLeaseToken(leaseToken);
          stats.claimAttempts += 1;
          let claim: ClaimRunDispatchLeaseResult;
          try {
            claim = await this.leases.claim(
              { workerId: selectedWorker.worker.id },
              {
                runId: candidate.runId,
                attemptId: candidate.attemptId,
                workerId: selectedWorker.worker.id,
                workerSessionId: selectedWorker.worker.sessionId,
                workerGeneration: selectedWorker.worker.generation,
                leaseToken,
              },
            );
          } catch (error) {
            if (
              error instanceof RunDispatchLeaseFenceRejectedError &&
              error.reason === 'version_mismatch'
            ) {
              stats.claimRaces += 1;
              raced = true;
              break;
            }
            throw error;
          }
          if (claim.status === 'claimed' || claim.status === 'idempotent') {
            return {
              status: 'offered',
              offer: {
                offerId: createRunDispatchOfferId(claim.lease),
                executionSpecDigest: createExecutionSpecDigest(executionSpec),
                deliveryKind: 'new_claim',
                candidate: { ...candidate },
                worker: {
                  id: selectedWorker.worker.id,
                  sessionId: selectedWorker.worker.sessionId,
                  generation: selectedWorker.worker.generation,
                },
                lease: claim.lease,
                executionSpec,
                placementScore: selectedWorker.score,
              },
              stats,
              truncated: workerState.truncated || page.more,
            };
          }
          if (claim.status === 'leased' || claim.status === 'not_eligible') {
            stats.claimRaces += 1;
            raced = true;
            break;
          }
          stats.claimRaces += 1;
          raced = true;
        }
      }

      if (!page.more) break;
      if (stats.candidatePages >= this.maxCandidatePages) {
        return this.idle('scan_budget_exhausted', stats, true);
      }
      page = await this.loadCandidatePage(
        observedAtMs,
        page.cursor,
        seenAttempts,
        stats,
      );
      if (page.candidates.length === 0) break;
    }

    const truncated = workerState.truncated || page.more;
    if (stats.plansUnavailable === stats.candidatesScanned) {
      return this.idle('plans_unavailable', stats, truncated);
    }
    return this.idle(raced ? 'claim_raced' : 'no_match', stats, truncated);
  }

  /**
   * Rebuilds one offer from durable lease authority before claiming new work.
   * A future Worker transport must deduplicate repeated delivery by offerId.
   */
  private async recoverOffer(
    observedAtMs: number,
    stats: RunDispatcherStats,
  ): Promise<RunDispatcherResult | null> {
    const seenAttempts = new Set<string>();
    let after: RunDispatchRecoveryCursor | undefined;
    for (let pageIndex = 0; pageIndex < this.maxRecoveryPages; pageIndex += 1) {
      const recoveries = await this.recoveries.listRecoverable({
        observedAtMs,
        ...(after === undefined ? {} : { after }),
        limit: this.recoveryPageSize,
      });
      if (recoveries.length > this.recoveryPageSize) {
        throw new RangeError('Run dispatch recovery source exceeded page size');
      }
      stats.recoveryPages += 1;
      for (const recovery of recoveries) {
        assertRecoverableRunDispatch(recovery);
        if (recovery.lease.expiresAtMs <= observedAtMs) {
          throw new Error(
            'Run dispatch recovery source returned an expired lease',
          );
        }
        if (seenAttempts.has(recovery.candidate.attemptId)) {
          throw new Error('Run dispatch recovery source repeated an attempt');
        }
        if (
          after !== undefined &&
          (recovery.lease.expiresAtMs < after.expiresAtMs ||
            (recovery.lease.expiresAtMs === after.expiresAtMs &&
              recovery.candidate.attemptId.localeCompare(after.attemptId) <= 0))
        ) {
          throw new Error('Run dispatch recovery cursor did not advance');
        }
        seenAttempts.add(recovery.candidate.attemptId);
        stats.recoveriesScanned += 1;
        const plan = await this.plans.prepare({ ...recovery.candidate });
        if (!plan) {
          stats.recoveryPlansUnavailable += 1;
          continue;
        }
        const executionSpec = executionSpecForRunDispatchCandidate(
          recovery.candidate,
          plan.executionSpec,
        );
        return {
          status: 'offered',
          offer: {
            offerId: createRunDispatchOfferId(recovery.lease),
            executionSpecDigest: createExecutionSpecDigest(executionSpec),
            deliveryKind: 'lease_recovery',
            candidate: { ...recovery.candidate },
            worker: {
              id: recovery.lease.workerId,
              sessionId: recovery.lease.workerSessionId,
              generation: recovery.lease.workerGeneration,
            },
            lease: { ...recovery.lease },
            executionSpec,
          },
          stats,
          truncated: recoveries.length === this.recoveryPageSize,
        };
      }
      if (recoveries.length < this.recoveryPageSize) return null;
      const last = recoveries[recoveries.length - 1];
      after = {
        expiresAtMs: last.lease.expiresAtMs,
        attemptId: last.candidate.attemptId,
      };
    }
    return this.idle('recovery_scan_budget_exhausted', stats, true);
  }

  private async loadCandidatePage(
    observedAtMs: number,
    after: RunDispatchCandidateCursor | undefined,
    seenAttempts: Set<string>,
    stats: RunDispatcherStats,
  ): Promise<CandidatePageState> {
    const candidates = await this.candidates.listCandidates({
      observedAtMs,
      ...(after === undefined ? {} : { after }),
      limit: this.candidatePageSize,
    });
    if (candidates.length > this.candidatePageSize) {
      throw new RangeError('Run dispatch candidate source exceeded page size');
    }
    stats.candidatePages += 1;
    for (const candidate of candidates) {
      assertRunDispatchCandidate(candidate);
      if (seenAttempts.has(candidate.attemptId)) {
        throw new Error('Run dispatch candidate source repeated an attempt');
      }
      seenAttempts.add(candidate.attemptId);
    }
    const cursor =
      candidates.length === 0
        ? after
        : cursorOf(candidates[candidates.length - 1]);
    if (
      after !== undefined &&
      cursor !== undefined &&
      cursorKey(after) === cursorKey(cursor)
    ) {
      throw new Error('Run dispatch candidate cursor did not advance');
    }
    return {
      candidates,
      ...(cursor === undefined ? {} : { cursor }),
      more: candidates.length === this.candidatePageSize,
    };
  }

  private async loadWorkers(observedAtMs: number, stats: RunDispatcherStats) {
    const workers = [];
    const seen = new Set<string>();
    let afterWorkerId: string | undefined;
    let truncated = false;
    for (let pageIndex = 0; pageIndex < this.maxWorkerPages; pageIndex += 1) {
      const page = await this.workers.listAvailable({
        observedAtMs,
        ...(afterWorkerId === undefined ? {} : { afterWorkerId }),
        limit: this.workerPageSize,
      });
      if (page.workers.length > this.workerPageSize) {
        throw new RangeError('Worker source exceeded page size');
      }
      stats.workerPages += 1;
      for (const worker of page.workers) {
        if (seen.has(worker.id)) {
          throw new Error('Worker source repeated a Worker');
        }
        if (
          afterWorkerId !== undefined &&
          worker.id.localeCompare(afterWorkerId) <= 0
        ) {
          throw new Error('Worker source cursor did not advance');
        }
        seen.add(worker.id);
        workers.push(worker);
      }
      stats.workersScanned += page.workers.length;
      if (!page.truncated) {
        truncated = false;
        break;
      }
      truncated = true;
      if (
        !page.nextCursor ||
        page.nextCursor === afterWorkerId ||
        page.workers.length === 0 ||
        page.nextCursor !== page.workers[page.workers.length - 1].id
      ) {
        throw new Error('Truncated Worker page has no advancing cursor');
      }
      afterWorkerId = page.nextCursor;
    }
    return { workers, truncated };
  }

  private idle(
    reason: RunDispatcherIdleReason,
    stats: RunDispatcherStats,
    truncated: boolean,
  ): RunDispatcherResult {
    return { status: 'idle', reason, stats, truncated };
  }

  private now(): number {
    const nowMs = this.clock.now();
    assertRunDispatchLeaseVersion('observedAtMs', nowMs);
    return nowMs;
  }
}
