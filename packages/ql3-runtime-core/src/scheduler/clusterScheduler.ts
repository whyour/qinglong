import {
  normalizeLocalScheduleCandidate,
  resolveLocalScheduleDecision,
  type LocalCronNextOccurrence,
  type LocalScheduleCandidate,
  type LocalScheduleDecision,
} from './localScheduler';

export const MAX_CLUSTER_SCHEDULE_CLAIM_LEASE_MS = 60_000;
export const MIN_CLUSTER_SCHEDULE_CLAIM_LEASE_MS = 1_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface ClusterScheduleClaim extends LocalScheduleCandidate {
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly claimVersion: number;
  readonly claimAcquiredAtMs: number;
  readonly claimExpiresAtMs: number;
}

export interface ClaimClusterScheduleCommand {
  readonly ownerId: string;
  readonly claimToken: string;
  readonly leaseMs: number;
}

export interface CommitClusterScheduleDecisionCommand {
  readonly claim: ClusterScheduleClaim;
  readonly decision: LocalScheduleDecision;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly createdEventId?: string;
  readonly queuedEventId?: string;
}

export type CommitClusterScheduleDecisionResult = Readonly<
  | { status: 'advanced'; disposition: 'initialize' | 'skip' }
  | {
      status: 'admitted';
      disposition: 'admit';
      runId: string;
      attemptId: string;
    }
  | { status: 'raced' }
>;

export interface ClusterScheduleStore {
  claimNextClusterSchedule(
    command: ClaimClusterScheduleCommand,
  ): Promise<ClusterScheduleClaim | null>;
  commitClusterScheduleDecision(
    command: CommitClusterScheduleDecisionCommand,
  ): Promise<CommitClusterScheduleDecisionResult>;
}

export class InvalidClusterScheduleError extends TypeError {
  readonly code = 'CLUSTER_SCHEDULE_INVALID';

  constructor(message: string) {
    super(`Cluster schedule is invalid: ${message}`);
    this.name = 'InvalidClusterScheduleError';
  }
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidClusterScheduleError(`${label} is invalid`);
  }
  return value as number;
}

export function normalizeClusterScheduleClaim(
  value: ClusterScheduleClaim,
): ClusterScheduleClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidClusterScheduleError('claim shape is invalid');
  }
  const candidate = normalizeLocalScheduleCandidate({
    projectId: value.projectId,
    triggerId: value.triggerId,
    triggerRevision: value.triggerRevision,
    triggerContentDigest: value.triggerContentDigest,
    triggerUpdatedAtMs: value.triggerUpdatedAtMs,
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    taskContentDigest: value.taskContentDigest,
    expression: value.expression,
    timezone: value.timezone,
    misfirePolicy: value.misfirePolicy,
    stateVersion: value.stateVersion,
    nextFireAtMs: value.nextFireAtMs,
  });
  const expectedKeys = new Set([
    ...Object.keys(candidate),
    'claimAcquiredAtMs',
    'claimExpiresAtMs',
    'claimOwner',
    'claimToken',
    'claimVersion',
  ]);
  if (
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    typeof value.claimOwner !== 'string' ||
    !OWNER_PATTERN.test(value.claimOwner) ||
    typeof value.claimToken !== 'string' ||
    !UUID_PATTERN.test(value.claimToken) ||
    !Number.isSafeInteger(value.claimVersion) ||
    value.claimVersion < 1 ||
    value.claimVersion > 2_147_483_647
  ) {
    throw new InvalidClusterScheduleError('claim fence is invalid');
  }
  const claimExpiresAtMs = timestamp(
    value.claimExpiresAtMs,
    'claimExpiresAtMs',
  );
  const claimAcquiredAtMs = timestamp(
    value.claimAcquiredAtMs,
    'claimAcquiredAtMs',
  );
  const leaseMs = claimExpiresAtMs - claimAcquiredAtMs;
  if (
    claimAcquiredAtMs < value.triggerUpdatedAtMs ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < MIN_CLUSTER_SCHEDULE_CLAIM_LEASE_MS ||
    leaseMs > MAX_CLUSTER_SCHEDULE_CLAIM_LEASE_MS
  ) {
    throw new InvalidClusterScheduleError('claim expiry is invalid');
  }
  return Object.freeze({
    ...candidate,
    claimOwner: value.claimOwner,
    claimToken: value.claimToken,
    claimVersion: value.claimVersion,
    claimAcquiredAtMs,
    claimExpiresAtMs,
  });
}

export function normalizeClaimClusterScheduleCommand(
  value: ClaimClusterScheduleCommand,
): ClaimClusterScheduleCommand {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'claimToken,leaseMs,ownerId' ||
    !OWNER_PATTERN.test(value.ownerId) ||
    !UUID_PATTERN.test(value.claimToken) ||
    !Number.isSafeInteger(value.leaseMs) ||
    value.leaseMs < MIN_CLUSTER_SCHEDULE_CLAIM_LEASE_MS ||
    value.leaseMs > MAX_CLUSTER_SCHEDULE_CLAIM_LEASE_MS
  ) {
    throw new InvalidClusterScheduleError('claim command is invalid');
  }
  return Object.freeze({
    ownerId: value.ownerId,
    claimToken: value.claimToken,
    leaseMs: value.leaseMs,
  });
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidClusterScheduleError(`${label} is invalid`);
  }
  return value;
}

export function normalizeCommitClusterScheduleDecisionCommand(
  value: CommitClusterScheduleDecisionCommand,
): CommitClusterScheduleDecisionCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidClusterScheduleError('commit command shape is invalid');
  }
  const allowed = new Set([
    'attemptId',
    'claim',
    'createdEventId',
    'decision',
    'queuedEventId',
    'runId',
  ]);
  const keys = Object.keys(value);
  if (
    !keys.includes('claim') ||
    !keys.includes('decision') ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new InvalidClusterScheduleError('commit command shape is invalid');
  }
  const claim = normalizeClusterScheduleClaim(value.claim);
  const decision = value.decision;
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new InvalidClusterScheduleError('decision shape is invalid');
  }
  const admitted = decision.disposition === 'admit';
  const decisionKeys = Object.keys(decision).sort().join(',');
  if (
    (admitted &&
      decisionKeys !==
        'candidate,disposition,nextFireAtMs,observedAtMs,scheduledForMs') ||
    (!admitted &&
      decisionKeys !== 'candidate,disposition,nextFireAtMs,observedAtMs') ||
    (!admitted &&
      decision.disposition !== 'initialize' &&
      decision.disposition !== 'skip')
  ) {
    throw new InvalidClusterScheduleError('decision shape is invalid');
  }
  const candidate = normalizeLocalScheduleCandidate(decision.candidate);
  const observedAtMs = timestamp(
    decision.observedAtMs,
    'decision.observedAtMs',
  );
  const nextFireAtMs = timestamp(
    decision.nextFireAtMs,
    'decision.nextFireAtMs',
  );
  if (
    JSON.stringify(candidate) !==
      JSON.stringify({
        projectId: claim.projectId,
        triggerId: claim.triggerId,
        triggerRevision: claim.triggerRevision,
        triggerContentDigest: claim.triggerContentDigest,
        triggerUpdatedAtMs: claim.triggerUpdatedAtMs,
        taskId: claim.taskId,
        taskRevision: claim.taskRevision,
        taskContentDigest: claim.taskContentDigest,
        expression: claim.expression,
        timezone: claim.timezone,
        misfirePolicy: claim.misfirePolicy,
        stateVersion: claim.stateVersion,
        nextFireAtMs: claim.nextFireAtMs,
      }) ||
    observedAtMs !== claim.claimAcquiredAtMs ||
    nextFireAtMs <= observedAtMs ||
    (decision.disposition === 'initialize' && candidate.nextFireAtMs !== null)
  ) {
    throw new InvalidClusterScheduleError('decision fence is invalid');
  }
  if (admitted) {
    const scheduledForMs = timestamp(
      decision.scheduledForMs,
      'decision.scheduledForMs',
    );
    if (scheduledForMs > observedAtMs) {
      throw new InvalidClusterScheduleError('scheduled occurrence is invalid');
    }
    return Object.freeze({
      claim,
      decision: Object.freeze({
        candidate,
        observedAtMs,
        nextFireAtMs,
        scheduledForMs,
        disposition: 'admit' as const,
      }),
      runId: uuid(value.runId, 'runId'),
      attemptId: uuid(value.attemptId, 'attemptId'),
      createdEventId: uuid(value.createdEventId, 'createdEventId'),
      queuedEventId: uuid(value.queuedEventId, 'queuedEventId'),
    });
  }
  if (
    value.runId !== undefined ||
    value.attemptId !== undefined ||
    value.createdEventId !== undefined ||
    value.queuedEventId !== undefined
  ) {
    throw new InvalidClusterScheduleError(
      'non-admission decision carries identities',
    );
  }
  return Object.freeze({
    claim,
    decision: Object.freeze({
      candidate,
      observedAtMs,
      nextFireAtMs,
      disposition: decision.disposition,
    }),
  });
}

export function resolveClusterScheduleDecision(
  claim: ClusterScheduleClaim,
  misfireGraceMs: number,
  nextOccurrence: LocalCronNextOccurrence,
): LocalScheduleDecision {
  const normalized = normalizeClusterScheduleClaim(claim);
  return resolveLocalScheduleDecision(
    {
      projectId: normalized.projectId,
      triggerId: normalized.triggerId,
      triggerRevision: normalized.triggerRevision,
      triggerContentDigest: normalized.triggerContentDigest,
      triggerUpdatedAtMs: normalized.triggerUpdatedAtMs,
      taskId: normalized.taskId,
      taskRevision: normalized.taskRevision,
      taskContentDigest: normalized.taskContentDigest,
      expression: normalized.expression,
      timezone: normalized.timezone,
      misfirePolicy: normalized.misfirePolicy,
      stateVersion: normalized.stateVersion,
      nextFireAtMs: normalized.nextFireAtMs,
    },
    normalized.claimAcquiredAtMs,
    misfireGraceMs,
    nextOccurrence,
  );
}
