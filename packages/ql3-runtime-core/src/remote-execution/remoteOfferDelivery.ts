import type { ClusterRemoteExecutionOffer } from './remoteDispatch';
import {
  createClusterRemoteExecutionOffer,
  normalizeClusterDispatchCandidate,
} from './remoteDispatch';
import {
  assertRunDispatchId,
  assertRunDispatchLeaseToken,
  digestRunDispatchLeaseToken,
} from '../run/runDispatchLease';
import {
  assertWorkerId,
  assertWorkerSessionId,
} from '../worker/workerSession';

export const REMOTE_EXECUTION_OFFER_DELIVERY_SCHEMA =
  'qinglong/remote-execution-offer@v1';
export const MAX_REMOTE_EXECUTION_OFFER_RESPONSE_BYTES = 128 * 1024;

const IDLE_REASONS = [
  'worker_unavailable',
  'no_candidates',
  'no_match',
  'plans_unavailable',
  'claim_raced',
  'claim_budget_exhausted',
  'scan_budget_exhausted',
] as const;

export type RemoteExecutionOfferIdleReason = (typeof IDLE_REASONS)[number];

export interface RemoteExecutionOfferClaimAuthority {
  readonly workerId: string;
  readonly workerSessionId: string;
  readonly workerGeneration: number;
  readonly offerId: string;
  readonly leaseToken: string;
}

export interface RemoteExecutionOfferDeliveryStats {
  readonly pages: number;
  readonly candidates: number;
  readonly plansUnavailable: number;
  readonly placementMismatches: number;
  readonly claimAttempts: number;
  readonly claimRaces: number;
}

export type RemoteExecutionOfferPullResult =
  | Readonly<{
      status: 'offered';
      offer: ClusterRemoteExecutionOffer;
      stats: RemoteExecutionOfferDeliveryStats;
      truncated: boolean;
    }>
  | Readonly<{
      status: 'idle';
      reason: RemoteExecutionOfferIdleReason;
      stats: RemoteExecutionOfferDeliveryStats;
      truncated: boolean;
    }>;

export type RemoteExecutionOfferPullBody =
  | Readonly<{
      schema: typeof REMOTE_EXECUTION_OFFER_DELIVERY_SCHEMA;
      status: 'offered';
      offer: Readonly<{
        offerId: string;
        deliveryKind: ClusterRemoteExecutionOffer['deliveryKind'];
        executionDigest: string;
        candidate: ClusterRemoteExecutionOffer['candidate'];
        worker: ClusterRemoteExecutionOffer['worker'];
        lease: Readonly<{
          version: number;
          leaseGeneration: number;
          acquiredAtMs: number;
          renewedAtMs: number;
          expiresAtMs: number;
          updatedAtMs: number;
        }>;
        executionRevision: ClusterRemoteExecutionOffer['executionRevision'];
        placementScore: number;
      }>;
      stats: RemoteExecutionOfferDeliveryStats;
      truncated: boolean;
    }>
  | Readonly<{
      schema: typeof REMOTE_EXECUTION_OFFER_DELIVERY_SCHEMA;
      status: 'idle';
      reason: RemoteExecutionOfferIdleReason;
      stats: RemoteExecutionOfferDeliveryStats;
      truncated: boolean;
    }>;

export class InvalidRemoteExecutionOfferDeliveryError extends TypeError {
  readonly code = 'REMOTE_EXECUTION_OFFER_DELIVERY_INVALID';

  constructor(message: string) {
    super(`Remote execution offer delivery is invalid: ${message}`);
    this.name = 'InvalidRemoteExecutionOfferDeliveryError';
  }
}

function invalid(message: string): never {
  throw new InvalidRemoteExecutionOfferDeliveryError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') return invalid(`${label} is invalid`);
  return value;
}

function normalizeOffer(
  value: ClusterRemoteExecutionOffer,
): ClusterRemoteExecutionOffer {
  try {
    return createClusterRemoteExecutionOffer(value);
  } catch (error) {
    if (error instanceof InvalidRemoteExecutionOfferDeliveryError) throw error;
    return invalid('offered payload is invalid');
  }
}

function normalizeStats(value: unknown): RemoteExecutionOfferDeliveryStats {
  const candidate = object(value, 'stats');
  const keys = [
    'pages',
    'candidates',
    'plansUnavailable',
    'placementMismatches',
    'claimAttempts',
    'claimRaces',
  ] as const;
  exactKeys(candidate, keys, 'stats');
  const normalized = Object.freeze({
    pages: safeInteger(candidate.pages, 'stats.pages'),
    candidates: safeInteger(candidate.candidates, 'stats.candidates'),
    plansUnavailable: safeInteger(
      candidate.plansUnavailable,
      'stats.plansUnavailable',
    ),
    placementMismatches: safeInteger(
      candidate.placementMismatches,
      'stats.placementMismatches',
    ),
    claimAttempts: safeInteger(
      candidate.claimAttempts,
      'stats.claimAttempts',
    ),
    claimRaces: safeInteger(candidate.claimRaces, 'stats.claimRaces'),
  });
  if (
    normalized.pages > 16 ||
    normalized.candidates > 1024 ||
    normalized.plansUnavailable > normalized.candidates ||
    normalized.placementMismatches > normalized.candidates ||
    normalized.claimAttempts > 64 ||
    normalized.claimRaces > normalized.claimAttempts
  ) {
    invalid('stats exceed the reviewed budget');
  }
  return normalized;
}

export function normalizeRemoteExecutionOfferClaimAuthority(
  value: RemoteExecutionOfferClaimAuthority,
): RemoteExecutionOfferClaimAuthority {
  const candidate = object(value, 'claim authority');
  exactKeys(candidate, [
    'workerId',
    'workerSessionId',
    'workerGeneration',
    'offerId',
    'leaseToken',
  ], 'claim authority');
  assertWorkerId(value.workerId);
  assertWorkerSessionId(value.workerSessionId);
  safeInteger(value.workerGeneration, 'workerGeneration', 1);
  assertRunDispatchId('offerId', value.offerId);
  assertRunDispatchLeaseToken(value.leaseToken);
  return Object.freeze({ ...value });
}

export function createRemoteExecutionOfferPullBody(
  result: RemoteExecutionOfferPullResult,
): RemoteExecutionOfferPullBody {
  const stats = normalizeStats(result.stats);
  if (result.status === 'idle') {
    if (!IDLE_REASONS.includes(result.reason)) invalid('idle reason is invalid');
    return Object.freeze({
      schema: REMOTE_EXECUTION_OFFER_DELIVERY_SCHEMA,
      status: 'idle' as const,
      reason: result.reason,
      stats,
      truncated: boolean(result.truncated, 'truncated'),
    });
  }
  const offer = normalizeOffer(result.offer);
  return Object.freeze({
    schema: REMOTE_EXECUTION_OFFER_DELIVERY_SCHEMA,
    status: 'offered' as const,
    offer: Object.freeze({
      offerId: offer.offerId,
      deliveryKind: offer.deliveryKind,
      executionDigest: offer.executionDigest,
      candidate: offer.candidate,
      worker: offer.worker,
      lease: Object.freeze({
        version: offer.lease.version,
        leaseGeneration: offer.lease.leaseGeneration,
        acquiredAtMs: offer.lease.acquiredAtMs,
        renewedAtMs: offer.lease.renewedAtMs,
        expiresAtMs: offer.lease.expiresAtMs,
        updatedAtMs: offer.lease.updatedAtMs,
      }),
      executionRevision: offer.executionRevision,
      placementScore: offer.placementScore,
    }),
    stats,
    truncated: boolean(result.truncated, 'truncated'),
  });
}

export function parseRemoteExecutionOfferPullResponse(
  serialized: Uint8Array | string,
  authorityValue: RemoteExecutionOfferClaimAuthority,
): RemoteExecutionOfferPullResult {
  const bytes = typeof serialized === 'string'
    ? Buffer.from(serialized, 'utf8')
    : Buffer.from(serialized);
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > MAX_REMOTE_EXECUTION_OFFER_RESPONSE_BYTES
  ) {
    invalid('response byte size is outside the allowed range');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return invalid('response is not valid JSON');
  }
  const authority = normalizeRemoteExecutionOfferClaimAuthority(authorityValue);
  const response = object(parsed, 'response');
  if (response.status === 'idle') {
    exactKeys(response, [
      'schema', 'status', 'reason', 'stats', 'truncated',
    ], 'idle response');
    if (
      response.schema !== REMOTE_EXECUTION_OFFER_DELIVERY_SCHEMA ||
      typeof response.reason !== 'string' ||
      !IDLE_REASONS.includes(response.reason as RemoteExecutionOfferIdleReason)
    ) {
      invalid('idle response fence is invalid');
    }
    return Object.freeze({
      status: 'idle' as const,
      reason: response.reason as RemoteExecutionOfferIdleReason,
      stats: normalizeStats(response.stats),
      truncated: boolean(response.truncated, 'truncated'),
    });
  }
  exactKeys(response, [
    'schema', 'status', 'offer', 'stats', 'truncated',
  ], 'offered response');
  if (
    response.schema !== REMOTE_EXECUTION_OFFER_DELIVERY_SCHEMA ||
    response.status !== 'offered'
  ) {
    invalid('response schema or status is invalid');
  }
  const wire = object(response.offer, 'offer');
  exactKeys(wire, [
    'offerId', 'deliveryKind', 'executionDigest', 'candidate', 'worker',
    'lease', 'executionRevision', 'placementScore',
  ], 'offer');
  if (wire.offerId !== authority.offerId) invalid('offerId does not match claim');
  const worker = object(wire.worker, 'offer.worker');
  exactKeys(worker, ['workerId', 'sessionId', 'generation'], 'offer.worker');
  if (
    worker.workerId !== authority.workerId ||
    worker.sessionId !== authority.workerSessionId ||
    worker.generation !== authority.workerGeneration
  ) {
    invalid('Worker target does not match claim');
  }
  let candidate: ClusterRemoteExecutionOffer['candidate'];
  try {
    candidate = normalizeClusterDispatchCandidate(
      wire.candidate as ClusterRemoteExecutionOffer['candidate'],
    );
  } catch {
    return invalid('offer candidate is invalid');
  }
  const lease = object(wire.lease, 'offer.lease');
  exactKeys(lease, [
    'version', 'leaseGeneration', 'acquiredAtMs', 'renewedAtMs',
    'expiresAtMs', 'updatedAtMs',
  ], 'offer.lease');
  const offer = normalizeOffer({
    offerId: authority.offerId,
    deliveryKind: wire.deliveryKind as ClusterRemoteExecutionOffer['deliveryKind'],
    executionDigest: wire.executionDigest as string,
    candidate,
    worker: {
      workerId: authority.workerId,
      sessionId: authority.workerSessionId,
      generation: authority.workerGeneration,
    },
    lease: {
      attemptId: candidate.attemptId,
      runId: candidate.runId,
      status: 'leased',
      version: safeInteger(lease.version, 'offer.lease.version'),
      leaseGeneration: safeInteger(
        lease.leaseGeneration,
        'offer.lease.leaseGeneration',
        1,
      ),
      workerId: authority.workerId,
      workerSessionId: authority.workerSessionId,
      workerGeneration: authority.workerGeneration,
      leaseTokenDigest: digestRunDispatchLeaseToken(authority.leaseToken),
      acquiredAtMs: safeInteger(
        lease.acquiredAtMs,
        'offer.lease.acquiredAtMs',
      ),
      renewedAtMs: safeInteger(
        lease.renewedAtMs,
        'offer.lease.renewedAtMs',
      ),
      expiresAtMs: safeInteger(
        lease.expiresAtMs,
        'offer.lease.expiresAtMs',
      ),
      updatedAtMs: safeInteger(
        lease.updatedAtMs,
        'offer.lease.updatedAtMs',
      ),
    },
    leaseToken: authority.leaseToken,
    executionRevision:
      wire.executionRevision as ClusterRemoteExecutionOffer['executionRevision'],
    placementScore: wire.placementScore as number,
  });
  return Object.freeze({
    status: 'offered' as const,
    offer,
    stats: normalizeStats(response.stats),
    truncated: boolean(response.truncated, 'truncated'),
  });
}
