import { createHash } from 'crypto';
import type { ExecutionSpec } from './execution';
import { cloneExecutionSpec } from './executionSpec';
import type { RunDispatchCandidate } from './runDispatchCandidate';
import {
  assertRunDispatchLeaseRecord,
  type RunDispatchLeaseRecord,
} from './runDispatchLease';

export const RUN_DISPATCH_OFFER_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface RunDispatchPlan {
  /** Untrusted until normalized by the Dispatcher. */
  placement: unknown;
  executionSpec: ExecutionSpec;
}

export interface ClaimedExecutionOffer {
  /** Stable for one Attempt lease generation, including crash recovery. */
  offerId: string;
  /** Worker dedupe must reject the same offerId with a different digest. */
  executionSpecDigest: string;
  deliveryKind: 'new_claim' | 'lease_recovery';
  candidate: RunDispatchCandidate;
  worker: {
    id: string;
    sessionId: string;
    generation: number;
  };
  /** Contains the opaque lease capability; never log or persist outside its owner. */
  lease: RunDispatchLeaseRecord;
  executionSpec: ExecutionSpec;
  placementScore?: number;
}

export interface RunDispatcherStats {
  recoveryPages: number;
  recoveriesScanned: number;
  recoveryPlansUnavailable: number;
  candidatePages: number;
  candidatesScanned: number;
  workerPages: number;
  workersScanned: number;
  plansUnavailable: number;
  matchingWorkers: number;
  claimAttempts: number;
  claimRaces: number;
}

export type RunDispatcherIdleReason =
  | 'recovery_plans_unavailable'
  | 'recovery_scan_budget_exhausted'
  | 'no_candidates'
  | 'no_workers'
  | 'plans_unavailable'
  | 'no_match'
  | 'claim_raced'
  | 'claim_budget_exhausted'
  | 'scan_budget_exhausted';

export type RunDispatcherResult =
  | {
      status: 'offered';
      offer: ClaimedExecutionOffer;
      stats: RunDispatcherStats;
      truncated: boolean;
    }
  | {
      status: 'idle';
      reason: RunDispatcherIdleReason;
      stats: RunDispatcherStats;
      truncated: boolean;
    };

export function createRunDispatchOfferId(
  lease: RunDispatchLeaseRecord,
): string {
  assertRunDispatchLeaseRecord(lease);
  if (lease.status !== 'leased') {
    throw new TypeError(
      'Execution offer requires an active Run dispatch lease',
    );
  }
  return createHash('sha256')
    .update('qinglong-run-dispatch-offer-v1\0', 'utf8')
    .update(lease.attemptId, 'utf8')
    .update('\0', 'utf8')
    .update(String(lease.leaseGeneration), 'utf8')
    .update('\0', 'utf8')
    .update(lease.workerId, 'utf8')
    .update('\0', 'utf8')
    .update(lease.workerSessionId, 'utf8')
    .update('\0', 'utf8')
    .update(String(lease.workerGeneration), 'utf8')
    .digest('hex');
}

export function createExecutionSpecDigest(spec: ExecutionSpec): string {
  return createHash('sha256')
    .update(JSON.stringify(cloneExecutionSpec(spec)), 'utf8')
    .digest('hex');
}

export function assertRunDispatchOfferId(value: string): void {
  if (!RUN_DISPATCH_OFFER_ID_PATTERN.test(value)) {
    throw new TypeError('Run dispatch offer ID is invalid');
  }
}
