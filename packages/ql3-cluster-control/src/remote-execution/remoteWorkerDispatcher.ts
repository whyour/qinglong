// Remote execution owns bounded offer selection, placement, and lease claiming.
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ClusterDispatchCandidate,
  ClusterDispatchCandidateCursor,
  ClusterDispatchSource,
  ClusterRemoteExecutionOffer,
} from '@qinglong/runtime-core/remote-dispatch';
import {
  assertRemoteDispatchPageSize,
  createClusterRemoteExecutionOffer,
  evaluateRemoteWorkerPlacement,
  leaseTokenMatchesDigest,
  normalizeClusterDispatchCandidate,
} from '@qinglong/runtime-core/remote-dispatch';
import type {
  ClusterTaskExecutionRevision,
  ClusterTaskExecutionRevisionSource,
} from '@qinglong/runtime-core/cluster-execution-revision';
import type {
  ClaimRunDispatchLeaseResult,
  RunDispatchLeaseRepository,
  WorkerSessionRecord,
  WorkerSessionRepository,
} from '@qinglong/runtime-core';
import {
  assertRunDispatchId,
  assertRunDispatchLeaseDuration,
  assertRunDispatchLeaseToken,
  assertWorkerId,
  assertWorkerSessionId,
} from '@qinglong/runtime-core';
import { parseTaskDefinitionRevisionRef } from '@qinglong/runtime-core/task-definition-execution-compiler';

const DEFAULT_PAGE_SIZE = 8;
const DEFAULT_MAX_PAGES = 2;
const DEFAULT_MAX_CLAIMS = 8;
const DEFAULT_LEASE_MS = 30_000;
const MAX_PAGES = 16;
const MAX_CLAIMS = 64;

export interface ClusterRemoteWorkerOfferPrincipal {
  readonly workerId: string;
}

export interface ClaimClusterRemoteWorkerOfferCommand {
  readonly workerSessionId: string;
  readonly workerGeneration: number;
  /** Worker-generated stable idempotency key for this poll attempt. */
  readonly offerId: string;
  /** Worker-generated high-entropy capability; PostgreSQL stores only its digest. */
  readonly leaseToken: string;
}

export interface ClusterRemoteWorkerOfferStats {
  readonly pages: number;
  readonly candidates: number;
  readonly plansUnavailable: number;
  readonly placementMismatches: number;
  readonly claimAttempts: number;
  readonly claimRaces: number;
}

type MutableClusterRemoteWorkerOfferStats = {
  -readonly [Key in keyof ClusterRemoteWorkerOfferStats]: ClusterRemoteWorkerOfferStats[Key];
};

export type ClaimClusterRemoteWorkerOfferResult =
  | Readonly<{
      status: 'offered';
      offer: ClusterRemoteExecutionOffer;
      stats: ClusterRemoteWorkerOfferStats;
      truncated: boolean;
    }>
  | Readonly<{
      status: 'idle';
      reason:
        | 'worker_unavailable'
        | 'no_candidates'
        | 'no_match'
        | 'plans_unavailable'
        | 'claim_raced'
        | 'claim_budget_exhausted'
        | 'scan_budget_exhausted';
      stats: ClusterRemoteWorkerOfferStats;
      truncated: boolean;
    }>;

export class ClusterRemoteWorkerOfferFenceRejectedError extends Error {
  readonly code = 'REMOTE_WORKER_OFFER_FENCED';

  constructor() {
    super('Remote Worker offer authority was fenced');
    this.name = 'ClusterRemoteWorkerOfferFenceRejectedError';
  }
}

export interface ClusterRemoteWorkerOfferClaimServiceOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxClaimAttempts?: number;
  readonly leaseDurationMs?: number;
  readonly createEventId?: () => string;
}

function bounded(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function emptyStats(): MutableClusterRemoteWorkerOfferStats {
  return {
    pages: 0,
    candidates: 0,
    plansUnavailable: 0,
    placementMismatches: 0,
    claimAttempts: 0,
    claimRaces: 0,
  };
}

function cursor(candidate: ClusterDispatchCandidate): ClusterDispatchCandidateCursor {
  return Object.freeze({
    priority: candidate.priority,
    queuedAtMs: candidate.queuedAtMs,
    attemptCreatedAtMs: candidate.attemptCreatedAtMs,
    attemptId: candidate.attemptId,
  });
}

export class ClusterRemoteWorkerOfferClaimService {
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxClaimAttempts: number;
  private readonly leaseDurationMs: number;
  private readonly createEventId: () => string;

  constructor(
    private readonly source: ClusterDispatchSource,
    private readonly workers: Pick<WorkerSessionRepository, 'findById'>,
    private readonly revisions: ClusterTaskExecutionRevisionSource,
    private readonly leases: Pick<RunDispatchLeaseRepository, 'claim'>,
    options: ClusterRemoteWorkerOfferClaimServiceOptions = {},
  ) {
    if (
      !source || typeof source.listClusterDispatchCandidates !== 'function' ||
      typeof source.findClusterDispatchRecovery !== 'function' ||
      !workers || typeof workers.findById !== 'function' ||
      !revisions || typeof revisions.resolveClusterTaskExecutionRevision !== 'function' ||
      !leases || typeof leases.claim !== 'function'
    ) throw new TypeError('Remote Worker offer service dependencies are invalid');
    const allowed = new Set([
      'createEventId', 'leaseDurationMs', 'maxClaimAttempts', 'maxPages', 'pageSize',
    ]);
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => !allowed.has(key))) {
      throw new TypeError('Remote Worker offer service options are invalid');
    }
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    assertRemoteDispatchPageSize(this.pageSize);
    this.maxPages = bounded('Remote Worker offer maxPages', options.maxPages ?? DEFAULT_MAX_PAGES, 1, MAX_PAGES);
    this.maxClaimAttempts = bounded('Remote Worker offer maxClaimAttempts', options.maxClaimAttempts ?? DEFAULT_MAX_CLAIMS, 1, MAX_CLAIMS);
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS;
    assertRunDispatchLeaseDuration(this.leaseDurationMs);
    this.createEventId = options.createEventId ?? randomUUID;
    if (typeof this.createEventId !== 'function') {
      throw new TypeError('Remote Worker offer event ID factory is invalid');
    }
  }

  async claimNext(
    principal: ClusterRemoteWorkerOfferPrincipal,
    command: ClaimClusterRemoteWorkerOfferCommand,
  ): Promise<ClaimClusterRemoteWorkerOfferResult> {
    this.assertCommand(principal, command);
    const stats = emptyStats();
    const recovered = await this.source.findClusterDispatchRecovery(command.offerId);
    if (recovered) {
      if (
        recovered.lease.status !== 'leased' ||
        recovered.lease.expiresAtMs <= recovered.observedAtMs ||
        !recovered.workerCurrent ||
        recovered.lease.workerId !== principal.workerId ||
        recovered.lease.workerSessionId !== command.workerSessionId ||
        recovered.lease.workerGeneration !== command.workerGeneration ||
        !leaseTokenMatchesDigest(command.leaseToken, recovered.lease.leaseTokenDigest)
      ) throw new ClusterRemoteWorkerOfferFenceRejectedError();
      const revision = await this.resolveRevision(recovered.candidate);
      if (!revision) throw new ClusterRemoteWorkerOfferFenceRejectedError();
      return Object.freeze({
        status: 'offered' as const,
        offer: this.offer(
          'lease_recovery', command, recovered.candidate,
          recovered.lease, revision, 0,
        ),
        stats: Object.freeze(stats),
        truncated: false,
      });
    }

    let after: ClusterDispatchCandidateCursor | undefined;
    let worker: WorkerSessionRecord | null | undefined;
    let sawCandidate = false;
    let sawMatch = false;
    let sawRace = false;
    let lastTruncated = false;
    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const page = await this.source.listClusterDispatchCandidates({
        limit: this.pageSize,
        ...(after === undefined ? {} : { after }),
      });
      stats.pages += 1;
      lastTruncated = page.truncated;
      if (page.candidates.length > this.pageSize) {
        throw new RangeError('Remote Worker candidate source exceeded page size');
      }
      worker ??= await this.workers.findById(principal.workerId);
      if (
        !worker || worker.sessionId !== command.workerSessionId ||
        worker.generation !== command.workerGeneration ||
        worker.status !== 'online' || worker.availableSlots < 1 ||
        worker.leaseExpiresAtMs <= page.observedAtMs
      ) return this.idle('worker_unavailable', stats, false);

      for (const rawCandidate of page.candidates) {
        const candidate = normalizeClusterDispatchCandidate(rawCandidate);
        sawCandidate = true;
        stats.candidates += 1;
        const revision = await this.resolveRevision(candidate);
        if (!revision) {
          stats.plansUnavailable += 1;
          continue;
        }
        const placement = evaluateRemoteWorkerPlacement(
          worker,
          revision.placement ?? {},
          page.observedAtMs,
        );
        if (!placement.matches) {
          stats.placementMismatches += 1;
          continue;
        }
        sawMatch = true;
        if (stats.claimAttempts >= this.maxClaimAttempts) {
          return this.idle('claim_budget_exhausted', stats, true);
        }
        const eventId = this.createEventId();
        assertRunDispatchId('eventId', eventId);
        stats.claimAttempts += 1;
        const claim = await this.leases.claim({
          runId: candidate.runId,
          attemptId: candidate.attemptId,
          workerId: principal.workerId,
          workerSessionId: command.workerSessionId,
          workerGeneration: command.workerGeneration,
          leaseToken: command.leaseToken,
          leaseDurationMs: this.leaseDurationMs,
          eventId,
          offerId: command.offerId,
        });
        if (claim.status === 'claimed' || claim.status === 'idempotent') {
          return Object.freeze({
            status: 'offered' as const,
            offer: this.offer(
              'new_claim', command, candidate, claim.lease, revision,
              placement.score,
            ),
            stats: Object.freeze(stats),
            truncated: page.truncated,
          });
        }
        if (claim.status === 'worker_unavailable' || claim.status === 'capacity_exhausted') {
          return this.idle('worker_unavailable', stats, false);
        }
        stats.claimRaces += 1;
        sawRace = true;
      }
      if (!page.truncated || page.candidates.length === 0) break;
      const last = page.candidates.at(-1);
      if (!last) break;
      const next = page.next ?? cursor(last);
      if (after && next.attemptId === after.attemptId) {
        throw new Error('Remote Worker candidate cursor did not advance');
      }
      after = next;
    }
    if (lastTruncated) return this.idle('scan_budget_exhausted', stats, true);
    if (!sawCandidate) return this.idle('no_candidates', stats, false);
    if (stats.plansUnavailable === stats.candidates) return this.idle('plans_unavailable', stats, false);
    return this.idle(sawRace ? 'claim_raced' : sawMatch ? 'claim_raced' : 'no_match', stats, false);
  }

  private async resolveRevision(
    candidate: ClusterDispatchCandidate,
  ): Promise<ClusterTaskExecutionRevision | null> {
    let sourceRevision: number;
    try {
      sourceRevision = parseTaskDefinitionRevisionRef(candidate.taskRevision).revision;
    } catch {
      return null;
    }
    const revision = await this.revisions.resolveClusterTaskExecutionRevision({
      projectId: candidate.projectId,
      taskId: candidate.taskId,
      sourceRevision,
    });
    if (
      !revision || revision.projectId !== candidate.projectId ||
      revision.taskId !== candidate.taskId ||
      revision.taskRevision !== candidate.taskRevision
    ) return null;
    return revision;
  }

  private offer(
    deliveryKind: ClusterRemoteExecutionOffer['deliveryKind'],
    command: ClaimClusterRemoteWorkerOfferCommand,
    candidate: ClusterDispatchCandidate,
    lease: Extract<ClaimRunDispatchLeaseResult, { lease: unknown }>['lease'],
    revision: ClusterTaskExecutionRevision,
    placementScore: number,
  ): ClusterRemoteExecutionOffer {
    return createClusterRemoteExecutionOffer({
      offerId: command.offerId,
      deliveryKind,
      executionDigest: revision.contentDigest,
      candidate,
      worker: {
        workerId: lease.workerId,
        sessionId: lease.workerSessionId,
        generation: lease.workerGeneration,
      },
      lease,
      leaseToken: command.leaseToken,
      executionRevision: revision,
      placementScore,
    });
  }

  private idle(
    reason: Extract<ClaimClusterRemoteWorkerOfferResult, { status: 'idle' }>['reason'],
    stats: ClusterRemoteWorkerOfferStats,
    truncated: boolean,
  ): ClaimClusterRemoteWorkerOfferResult {
    return Object.freeze({
      status: 'idle' as const,
      reason,
      stats: Object.freeze({ ...stats }),
      truncated,
    });
  }

  private assertCommand(
    principal: ClusterRemoteWorkerOfferPrincipal,
    command: ClaimClusterRemoteWorkerOfferCommand,
  ): void {
    if (!principal || typeof principal !== 'object' || Array.isArray(principal)) {
      throw new TypeError('Remote Worker offer principal is invalid');
    }
    assertWorkerId(principal.workerId);
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new TypeError('Remote Worker offer command is invalid');
    }
    const keys = Object.keys(command).sort().join(',');
    if (keys !== 'leaseToken,offerId,workerGeneration,workerSessionId') {
      throw new TypeError('Remote Worker offer command shape is invalid');
    }
    assertWorkerSessionId(command.workerSessionId);
    if (!Number.isSafeInteger(command.workerGeneration) || command.workerGeneration < 1) {
      throw new RangeError('Remote Worker offer generation is invalid');
    }
    assertRunDispatchId('offerId', command.offerId);
    assertRunDispatchLeaseToken(command.leaseToken);
  }
}

export function createRemoteWorkerLeaseToken(): string {
  return randomBytes(32).toString('base64url');
}
