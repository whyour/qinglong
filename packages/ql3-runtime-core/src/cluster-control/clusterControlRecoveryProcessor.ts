import type { RunAttemptRecord, RunEventRecord, RunRecord } from '../run/run';
import type {
  PluginPackageWorkflowTaskAttemptAdmissionReceipt,
} from '../plugin-package/workflow/pluginPackageWorkflowTaskAttemptAdmission';
import type { StepRunRecord } from '../run/stepRun';
import type {
  ClusterControlRecoveryClaim,
  ClusterControlRecoveryDisposition,
  ClusterControlRecoveryProcessor,
} from './clusterControlRecoverySupervisor';
import { MAX_CLUSTER_CONTROL_RECOVERY_RETRY_DELAY_MS } from './clusterControlRecoverySupervisor';

const ACTIVE_RUN_STATUSES = new Set(['dispatching', 'running']);
const ACTIVE_ATTEMPT_STATUSES = new Set(['claimed', 'starting', 'running']);
const TERMINAL_ATTEMPT_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);

export const CLUSTER_CONTROL_RECOVERY_UNKNOWN_REASONS = [
  'provider_unavailable',
  'identity_unverifiable',
  'conflicting_evidence',
] as const;

export type ClusterControlRecoveryUnknownReason =
  (typeof CLUSTER_CONTROL_RECOVERY_UNKNOWN_REASONS)[number];

export type ClusterControlRecoveryEvidence = Readonly<
  | { status: 'running' }
  | { status: 'not_running' }
  | {
      status: 'unknown';
      reason: ClusterControlRecoveryUnknownReason;
    }
>;

export interface ClusterControlRecoveryProbeTarget {
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptStatus: 'starting' | 'running';
  readonly executorType: string;
  readonly callbackSequence: number;
  readonly workerId?: string;
  readonly workerSessionId?: string;
  readonly workerGeneration?: number;
  readonly executorHandle?: string;
  readonly pid?: number;
  readonly leaseToken?: string;
  readonly leaseTokenDigest?: string;
  readonly leaseGeneration?: number;
  readonly leaseVersion?: number;
  readonly leaseExpiresAtMs?: number;
  readonly offerId?: string;
  readonly startedAtMs?: number;
}

export interface ClusterControlRecoveryEvidenceProvider {
  inspect(
    claim: ClusterControlRecoveryClaim,
    target: ClusterControlRecoveryProbeTarget,
  ): Promise<ClusterControlRecoveryEvidence>;
}

export interface ClusterControlRecoverySnapshot {
  /** Database-authoritative observation used to revalidate execution leases. */
  readonly observedAtMs: number;
  readonly run: Readonly<RunRecord> | null;
  /** Exact candidate Attempt, or latest Attempt when the candidate is a Run. */
  readonly attempt: Readonly<RunAttemptRecord> | null;
  /** Immutable Task admission authority when this is a Workflow Task Attempt. */
  readonly workflowTask?: Readonly<{
    admission:
      Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>;
    stepRun: Readonly<StepRunRecord>;
  }> | null;
}

export type ClusterControlRecoveryLostReason =
  | 'attempt_already_lost'
  | 'unstarted_claim_expired'
  | 'execution_not_running';

export type ClusterControlRecoveryLostAction = Readonly<
  | {
      kind: 'mark_run_lost';
      reason: 'attempt_already_lost';
    }
  | {
      kind: 'mark_attempt_lost';
      reason: 'unstarted_claim_expired' | 'execution_not_running';
    }
  | {
      kind: 'mark_attempt_and_run_lost';
      reason: 'unstarted_claim_expired' | 'execution_not_running';
    }
  | {
      kind: 'recover_workflow_task';
      reason: 'unstarted_claim_expired' | 'execution_not_running';
    }
>;

export interface ClusterControlRecoveryResolutionRepository {
  load(
    claim: ClusterControlRecoveryClaim,
  ): Promise<ClusterControlRecoverySnapshot | 'fenced'>;
  applyLost(
    claim: ClusterControlRecoveryClaim,
    snapshot: ClusterControlRecoverySnapshot,
    action: ClusterControlRecoveryLostAction,
  ): Promise<'applied' | 'stale' | 'fenced'>;
}

export class ClusterControlRecoveryFenceLostError extends Error {
  readonly retryable = true;

  constructor() {
    super('Cluster-control recovery claim fence was lost');
    this.name = 'ClusterControlRecoveryFenceLostError';
  }
}

export class InvalidClusterControlRecoveryTransitionError extends Error {
  readonly code = 'INVALID_CLUSTER_CONTROL_RECOVERY_TRANSITION';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidClusterControlRecoveryTransitionError';
  }
}

export interface ClusterControlRecoveryLostTransition {
  readonly attempt?: Readonly<{
    run: RunRecord;
    attempt: RunAttemptRecord;
    event: Readonly<
      Omit<RunEventRecord, 'id' | 'actorType' | 'actorId' | 'createdAtMs'>
    >;
  }>;
  readonly run?: Readonly<{
    run: RunRecord;
    event: Readonly<
      Omit<RunEventRecord, 'id' | 'actorType' | 'actorId' | 'createdAtMs'>
    >;
  }>;
}

function errorMetadata(reason: ClusterControlRecoveryLostReason): Readonly<{
  code: string;
  summary: string;
}> {
  if (reason === 'attempt_already_lost') {
    return Object.freeze({
      code: 'CLUSTER_RECOVERY_ATTEMPT_ALREADY_LOST',
      summary:
        'The latest Attempt was already lost before the Run was reconciled',
    });
  }
  if (reason === 'unstarted_claim_expired') {
    return Object.freeze({
      code: 'CLUSTER_RECOVERY_UNSTARTED_CLAIM_EXPIRED',
      summary:
        'The unstarted Attempt claim expired before execution was admitted',
    });
  }
  return Object.freeze({
    code: 'CLUSTER_RECOVERY_EXECUTION_NOT_RUNNING',
    summary:
      'Trusted execution evidence proved that the active Attempt is not running',
  });
}

function transitionTime(
  atMs: number,
  run: Readonly<RunRecord>,
  attempt?: Readonly<RunAttemptRecord>,
): number {
  if (!Number.isSafeInteger(atMs) || atMs < 0) {
    throw new InvalidClusterControlRecoveryTransitionError(
      'Recovery transition time is invalid',
    );
  }
  return Math.max(
    atMs,
    run.createdAtMs,
    run.startedAtMs ?? 0,
    attempt?.createdAtMs ?? 0,
    attempt?.startedAtMs ?? 0,
    attempt?.finishedAtMs ?? 0,
  );
}

function reserveEvent(run: Readonly<RunRecord>): Readonly<{
  run: RunRecord;
  sequence: number;
}> {
  const version = run.version + 1;
  const sequence = run.eventSequence + 1;
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1
  ) {
    throw new InvalidClusterControlRecoveryTransitionError(
      'Recovery transition version or event sequence overflowed',
    );
  }
  return Object.freeze({
    run: { ...run, version, eventSequence: sequence },
    sequence,
  });
}

function attemptLostTransition(
  run: Readonly<RunRecord>,
  attempt: Readonly<RunAttemptRecord>,
  reason: 'unstarted_claim_expired' | 'execution_not_running',
  atMs: number,
): NonNullable<ClusterControlRecoveryLostTransition['attempt']> {
  if (
    attempt.runId !== run.id ||
    !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)
  ) {
    throw new InvalidClusterControlRecoveryTransitionError(
      'Recovery Attempt is not an active member of the Run aggregate',
    );
  }
  const metadata = errorMetadata(reason);
  const reserved = reserveEvent(run);
  const nextAttempt: RunAttemptRecord = {
    ...attempt,
    status: 'lost',
    finishedAtMs: atMs,
    errorCode: metadata.code,
    errorSummary: metadata.summary,
  };
  return Object.freeze({
    run: reserved.run,
    attempt: nextAttempt,
    event: Object.freeze({
      runId: run.id,
      sequence: reserved.sequence,
      type: 'attempt.lost',
      dedupeKey: `cluster-recovery:attempt:${attempt.id}:${attempt.callbackSequence}`,
      attemptId: attempt.id,
      ...(attempt.stepRunId === undefined
        ? {}
        : { stepRunId: attempt.stepRunId }),
      payload: Object.freeze({
        attempt_id: attempt.id,
        attempt: attempt.attempt,
        from_status: attempt.status,
        to_status: 'lost',
        version: reserved.run.version,
        error_code: metadata.code,
      }),
    }),
  });
}

function runLostTransition(
  run: Readonly<RunRecord>,
  attemptId: string,
  reason: ClusterControlRecoveryLostReason,
): NonNullable<ClusterControlRecoveryLostTransition['run']> {
  if (!ACTIVE_RUN_STATUSES.has(run.status)) {
    throw new InvalidClusterControlRecoveryTransitionError(
      'Recovery Run is not active',
    );
  }
  const metadata = errorMetadata(reason);
  const reserved = reserveEvent(run);
  const nextRun: RunRecord = {
    ...reserved.run,
    status: 'lost',
    errorCode: metadata.code,
    errorSummary: metadata.summary,
  };
  return Object.freeze({
    run: nextRun,
    event: Object.freeze({
      runId: run.id,
      sequence: reserved.sequence,
      type: 'run.lost',
      dedupeKey: `cluster-recovery:run:${run.id}:${attemptId}:${run.version}`,
      attemptId,
      payload: Object.freeze({
        from_status: run.status,
        to_status: 'lost',
        version: nextRun.version,
        error_code: metadata.code,
      }),
    }),
  });
}

/**
 * Builds only the recovery-specific lost transition. It deliberately does not
 * create another Attempt, enqueue work, call an Executor or infer completion.
 */
export function buildClusterControlRecoveryLostTransition(
  currentRun: Readonly<RunRecord>,
  currentAttempt: Readonly<RunAttemptRecord> | null,
  action: ClusterControlRecoveryLostAction,
  observedAtMs: number,
): ClusterControlRecoveryLostTransition {
  if (
    currentRun.executionOwner !== 'runtime' ||
    currentRun.cancelRequestedAtMs !== undefined
  ) {
    throw new InvalidClusterControlRecoveryTransitionError(
      'Recovery lost transition has no runtime ownership authority',
    );
  }
  const atMs = transitionTime(
    observedAtMs,
    currentRun,
    currentAttempt ?? undefined,
  );
  if (action.kind === 'recover_workflow_task') {
    throw new InvalidClusterControlRecoveryTransitionError(
      'Workflow Task recovery requires its admission-bound StepRun authority',
    );
  }
  if (action.kind === 'mark_run_lost') {
    if (!currentAttempt || currentAttempt.status !== 'lost') {
      throw new InvalidClusterControlRecoveryTransitionError(
        'Run-only recovery requires an already-lost Attempt',
      );
    }
    return Object.freeze({
      run: runLostTransition(currentRun, currentAttempt.id, action.reason),
    });
  }
  if (!currentAttempt) {
    throw new InvalidClusterControlRecoveryTransitionError(
      'Attempt recovery requires an Attempt',
    );
  }
  if (action.kind === 'mark_attempt_lost') {
    if (currentRun.status !== 'lost') {
      throw new InvalidClusterControlRecoveryTransitionError(
        'Attempt-only recovery requires an already-lost Run',
      );
    }
    return Object.freeze({
      attempt: attemptLostTransition(
        currentRun,
        currentAttempt,
        action.reason,
        atMs,
      ),
    });
  }
  if (!ACTIVE_RUN_STATUSES.has(currentRun.status)) {
    throw new InvalidClusterControlRecoveryTransitionError(
      'Aggregate recovery requires an active Run',
    );
  }
  const attempt = attemptLostTransition(
    currentRun,
    currentAttempt,
    action.reason,
    atMs,
  );
  return Object.freeze({
    attempt,
    run: runLostTransition(attempt.run, currentAttempt.id, action.reason),
  });
}

function retryDelay(value: number | undefined): number {
  const delay = value ?? 5_000;
  if (
    !Number.isSafeInteger(delay) ||
    delay < 0 ||
    delay > MAX_CLUSTER_CONTROL_RECOVERY_RETRY_DELAY_MS
  ) {
    throw new RangeError(
      `Cluster-control evidence retry delay must be between 0 and ${MAX_CLUSTER_CONTROL_RECOVERY_RETRY_DELAY_MS}`,
    );
  }
  return delay;
}

function validSnapshot(
  claim: ClusterControlRecoveryClaim,
  snapshot: ClusterControlRecoverySnapshot,
): void {
  if (
    !Number.isSafeInteger(snapshot.observedAtMs) ||
    snapshot.observedAtMs < 0 ||
    (snapshot.run !== null && snapshot.run.id !== claim.candidate.runId) ||
    (claim.candidate.kind === 'attempt' &&
      snapshot.attempt !== null &&
      snapshot.attempt.id !== claim.candidate.id) ||
    (snapshot.workflowTask !== undefined &&
      snapshot.workflowTask !== null &&
      (claim.candidate.kind !== 'attempt' ||
        snapshot.workflowTask.admission.attemptId !==
          claim.candidate.id ||
        snapshot.workflowTask.admission.runId !==
          claim.candidate.runId ||
        snapshot.workflowTask.stepRun.id !==
          snapshot.workflowTask.admission.stepRunId ||
        snapshot.workflowTask.stepRun.runId !==
          claim.candidate.runId))
  ) {
    throw new TypeError(
      'Cluster-control recovery resolution repository returned an invalid snapshot',
    );
  }
}

function hasValidLease(
  attempt: Readonly<RunAttemptRecord>,
  observedAtMs: number,
): boolean {
  return (
    attempt.leaseExpiresAtMs !== undefined &&
    attempt.leaseExpiresAtMs > observedAtMs
  );
}

function probeTarget(
  attempt: Readonly<RunAttemptRecord>,
): ClusterControlRecoveryProbeTarget {
  if (attempt.status !== 'starting' && attempt.status !== 'running') {
    throw new TypeError('Cluster-control recovery probe target is not running');
  }
  return Object.freeze({
    runId: attempt.runId,
    attemptId: attempt.id,
    attemptStatus: attempt.status,
    executorType: attempt.executorType,
    callbackSequence: attempt.callbackSequence,
    ...(attempt.workerId === undefined ? {} : { workerId: attempt.workerId }),
    ...(attempt.workerSessionId === undefined
      ? {}
      : { workerSessionId: attempt.workerSessionId }),
    ...(attempt.workerGeneration === undefined
      ? {}
      : { workerGeneration: attempt.workerGeneration }),
    ...(attempt.executorHandle === undefined
      ? {}
      : { executorHandle: attempt.executorHandle }),
    ...(attempt.pid === undefined ? {} : { pid: attempt.pid }),
    ...(attempt.leaseToken === undefined
      ? {}
      : { leaseToken: attempt.leaseToken }),
    ...(attempt.leaseTokenDigest === undefined
      ? {}
      : { leaseTokenDigest: attempt.leaseTokenDigest }),
    ...(attempt.leaseGeneration === undefined
      ? {}
      : { leaseGeneration: attempt.leaseGeneration }),
    ...(attempt.leaseVersion === undefined
      ? {}
      : { leaseVersion: attempt.leaseVersion }),
    ...(attempt.leaseExpiresAtMs === undefined
      ? {}
      : { leaseExpiresAtMs: attempt.leaseExpiresAtMs }),
    ...(attempt.offerId === undefined ? {} : { offerId: attempt.offerId }),
    ...(attempt.startedAtMs === undefined
      ? {}
      : { startedAtMs: attempt.startedAtMs }),
  });
}

function normalizeEvidence(
  evidence: ClusterControlRecoveryEvidence,
): ClusterControlRecoveryEvidence {
  if (evidence?.status === 'running') {
    return Object.freeze({ status: 'running' });
  }
  if (evidence?.status === 'not_running') {
    return Object.freeze({ status: 'not_running' });
  }
  if (
    evidence?.status === 'unknown' &&
    CLUSTER_CONTROL_RECOVERY_UNKNOWN_REASONS.includes(evidence.reason)
  ) {
    return Object.freeze({ status: 'unknown', reason: evidence.reason });
  }
  throw new TypeError(
    'Cluster-control recovery evidence provider returned invalid evidence',
  );
}

/**
 * Revalidates durable state, requests external evidence only for attempts that
 * crossed the start barrier, and delegates fenced atomic mutation to storage.
 */
export class EvidenceBasedClusterControlRecoveryProcessor
  implements ClusterControlRecoveryProcessor
{
  private readonly retryDelayMs: number;

  constructor(
    private readonly repository: ClusterControlRecoveryResolutionRepository,
    private readonly evidence: ClusterControlRecoveryEvidenceProvider,
    options: Readonly<{ retryDelayMs?: number }> = {},
  ) {
    this.retryDelayMs = retryDelay(options.retryDelayMs);
  }

  async process(
    claim: ClusterControlRecoveryClaim,
  ): Promise<ClusterControlRecoveryDisposition> {
    const snapshot = await this.repository.load(claim);
    if (snapshot === 'fenced') throw new ClusterControlRecoveryFenceLostError();
    validSnapshot(claim, snapshot);
    const { run, attempt } = snapshot;
    if (!run || run.executionOwner !== 'runtime') {
      return Object.freeze({ status: 'resolved' });
    }

    if (claim.candidate.kind === 'run') {
      if (!['created', 'dispatching', 'running'].includes(run.status)) {
        return Object.freeze({ status: 'resolved' });
      }
      if (run.status === 'created' || !attempt) {
        return Object.freeze({ status: 'manual' });
      }
      if (attempt.status === 'lost') {
        if (run.cancelRequestedAtMs !== undefined) return this.retry();
        return this.apply(claim, snapshot, {
          kind: 'mark_run_lost',
          reason: 'attempt_already_lost',
        });
      }
      if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
        return Object.freeze({ status: 'manual' });
      }
    } else {
      if (!attempt || attempt.runId !== run.id) {
        return Object.freeze({ status: 'resolved' });
      }
      if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
        return Object.freeze({ status: 'resolved' });
      }
    }

    if (!attempt || !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
      return Object.freeze({ status: 'manual' });
    }
    if (hasValidLease(attempt, snapshot.observedAtMs)) {
      return Object.freeze({ status: 'resolved' });
    }
    if (
      run.status !== 'dispatching' &&
      run.status !== 'running' &&
      run.status !== 'lost'
    ) {
      return Object.freeze({ status: 'manual' });
    }
    if (run.cancelRequestedAtMs !== undefined) return this.retry();

    const actionKind = snapshot.workflowTask
      ? 'recover_workflow_task'
      : run.status === 'lost'
        ? 'mark_attempt_lost'
        : 'mark_attempt_and_run_lost';
    if (attempt.status === 'claimed') {
      return this.apply(claim, snapshot, {
        kind: actionKind,
        reason: 'unstarted_claim_expired',
      });
    }

    const evidence = normalizeEvidence(
      await this.evidence.inspect(claim, probeTarget(attempt)),
    );
    if (evidence.status === 'running') return this.retry();
    if (evidence.status === 'unknown') {
      return evidence.reason === 'provider_unavailable'
        ? this.retry()
        : Object.freeze({ status: 'manual' });
    }
    return this.apply(claim, snapshot, {
      kind: actionKind,
      reason: 'execution_not_running',
    });
  }

  private retry(): ClusterControlRecoveryDisposition {
    return Object.freeze({ status: 'retry', delayMs: this.retryDelayMs });
  }

  private async apply(
    claim: ClusterControlRecoveryClaim,
    snapshot: ClusterControlRecoverySnapshot,
    action: ClusterControlRecoveryLostAction,
  ): Promise<ClusterControlRecoveryDisposition> {
    const result = await this.repository.applyLost(claim, snapshot, action);
    if (result === 'fenced') throw new ClusterControlRecoveryFenceLostError();
    if (result !== 'applied' && result !== 'stale') {
      throw new TypeError(
        'Cluster-control recovery resolution repository returned an invalid result',
      );
    }
    return Object.freeze({ status: 'resolved' });
  }
}
