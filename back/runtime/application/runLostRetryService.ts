import { v7 as uuidV7 } from 'uuid';
import type {
  RunAttemptRecord,
  RunEventRecord,
  RunRecord,
} from '../domain/run';
import {
  assertRunRetryPolicyRecord,
  runRetryDelayMs,
  type RunRetryPolicyRecord,
} from '../domain/runRetryPolicy';
import {
  reserveRunEvent,
  transitionRun,
  type RunDomainEventDraft,
} from '../domain/runStateMachine';
import { RunVersionConflictError } from '../domain/stateMachineErrors';
import type {
  RunRepository,
  RunRepositoryTransaction,
} from '../ports/runRepository';

export type RunLostRetryStatus =
  | 'scheduled'
  | 'requeued'
  | 'cancelled'
  | 'failed_disabled'
  | 'failed_unsafe'
  | 'failed_exhausted'
  | 'not_due'
  | 'not_eligible'
  | 'not_found';

export interface RunLostRetryResult {
  status: RunLostRetryStatus;
  run?: RunRecord;
  attempt?: RunAttemptRecord;
  policy?: RunRetryPolicyRecord;
  events?: readonly RunEventRecord[];
}

export class RunLostRetryTargetError extends Error {
  readonly code = 'RUN_LOST_RETRY_TARGET_INCONSISTENT';

  constructor(message: string) {
    super(`Run lost retry target is inconsistent: ${message}`);
    this.name = 'RunLostRetryTargetError';
  }
}

export class RunLostRetryService {
  private readonly clock: { now(): number };
  private readonly createId: () => string;

  constructor(
    private readonly repository: RunRepository,
    options: { clock?: { now(): number }; createId?: () => string } = {},
  ) {
    this.clock = options.clock ?? Date;
    this.createId = options.createId ?? uuidV7;
  }

  reconcile(runId: string): Promise<RunLostRetryResult> {
    if (!runId) throw new TypeError('runId is required');
    const observedAtMs = this.clock.now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new RangeError('observedAtMs must be a non-negative safe integer');
    }
    return this.repository.transaction((transaction) =>
      this.reconcileInTransaction(transaction, runId, observedAtMs),
    );
  }

  private async reconcileInTransaction(
    transaction: RunRepositoryTransaction,
    runId: string,
    observedAtMs: number,
  ): Promise<RunLostRetryResult> {
    const run = await transaction.findRunById(runId);
    if (!run) return { status: 'not_found' };
    if (
      run.executionOwner !== 'runtime' ||
      (run.status !== 'lost' && run.status !== 'retry_wait')
    ) {
      return { status: 'not_eligible', run };
    }
    const [attempt, policy] = await Promise.all([
      transaction.findLatestAttemptByRunId(run.id),
      transaction.findRetryPolicyByRunId(run.id),
    ]);
    if (!attempt || attempt.runId !== run.id || attempt.status !== 'lost') {
      throw new RunLostRetryTargetError('latest Attempt is not lost');
    }
    if (policy) assertRunRetryPolicyRecord(policy);

    const atMs = Math.max(
      observedAtMs,
      run.createdAtMs,
      run.startedAtMs ?? 0,
      attempt.createdAtMs,
      attempt.startedAtMs ?? 0,
      attempt.finishedAtMs ?? 0,
      policy?.updatedAtMs ?? 0,
    );
    if (run.cancelRequestedAtMs !== undefined) {
      return this.finishRun(
        transaction,
        run,
        attempt,
        policy,
        atMs,
        'cancelled',
        'cancelled',
        'RUN_CANCELLED_DURING_LOST_RECOVERY',
        'Cancellation won before a replacement Attempt was created',
      );
    }
    if (!policy || !policy.retryOnLost || policy.maxAttempts <= 1) {
      return this.finishRun(
        transaction,
        run,
        attempt,
        policy,
        atMs,
        'failed_disabled',
        'failed',
        'RUN_LOST_RETRY_DISABLED',
        'Run was lost and automatic retry was not enabled at admission',
      );
    }
    if (policy.safety === 'unknown') {
      return this.finishRun(
        transaction,
        run,
        attempt,
        policy,
        atMs,
        'failed_unsafe',
        'failed',
        'RUN_LOST_RETRY_UNSAFE',
        'Run was lost but execution safety was not declared',
      );
    }
    if (attempt.attempt >= policy.maxAttempts) {
      return this.finishRun(
        transaction,
        run,
        attempt,
        policy,
        atMs,
        'failed_exhausted',
        'failed',
        'RUN_LOST_RETRY_EXHAUSTED',
        'Run exhausted its admitted automatic retry attempts',
      );
    }
    if (run.status === 'lost') {
      return this.schedule(transaction, run, attempt, policy, atMs);
    }
    if (
      policy.nextAttemptAtMs === undefined ||
      policy.nextAttemptAtMs > observedAtMs
    ) {
      return { status: 'not_due', run, attempt, policy };
    }
    return this.requeue(transaction, run, attempt, policy, atMs);
  }

  private async schedule(
    transaction: RunRepositoryTransaction,
    run: RunRecord,
    attempt: RunAttemptRecord,
    policy: RunRetryPolicyRecord,
    atMs: number,
  ): Promise<RunLostRetryResult> {
    const lostAtMs = Math.max(
      run.createdAtMs,
      attempt.createdAtMs,
      attempt.finishedAtMs ?? 0,
    );
    const nextAttemptAtMs = lostAtMs + runRetryDelayMs(policy, attempt.attempt);
    if (!Number.isSafeInteger(nextAttemptAtMs)) {
      throw new RunLostRetryTargetError('next Attempt time overflowed');
    }
    const decision = transitionRun(run, {
      to: 'retry_wait',
      expectedVersion: run.version,
      atMs,
      errorCode: 'RUN_LOST_RETRY_SCHEDULED',
      errorSummary:
        'A fresh Attempt will be created after the admitted backoff',
    });
    const nextPolicy: RunRetryPolicyRecord = {
      ...policy,
      nextAttemptAtMs,
      version: policy.version + 1,
      updatedAtMs: atMs,
    };
    if (
      !(await transaction.compareAndSetRun(decision.run, run.version)) ||
      !(await transaction.compareAndSetRetryPolicy(nextPolicy, policy.version))
    ) {
      throw new RunVersionConflictError(run.id, run.version, run.version);
    }
    const event = this.event(
      decision.run,
      decision.event,
      attempt.id,
      `run-lost-retry-scheduled:${attempt.id}`,
      atMs,
      {
        attempt: attempt.attempt,
        max_attempts: policy.maxAttempts,
        safety: policy.safety,
        next_attempt_at_ms: nextAttemptAtMs,
      },
    );
    await transaction.appendEvent(event);
    return {
      status: 'scheduled',
      run: decision.run,
      attempt,
      policy: nextPolicy,
      events: [event],
    };
  }

  private async requeue(
    transaction: RunRepositoryTransaction,
    run: RunRecord,
    lostAttempt: RunAttemptRecord,
    policy: RunRetryPolicyRecord,
    atMs: number,
  ): Promise<RunLostRetryResult> {
    const attempt: RunAttemptRecord = {
      id: this.createId(),
      runId: run.id,
      attempt: lostAttempt.attempt + 1,
      status: 'claimed',
      executorType: lostAttempt.executorType,
      callbackSequence: 0,
      createdAtMs: atMs,
    };
    const queued = transitionRun(run, {
      to: 'queued',
      expectedVersion: run.version,
      atMs,
    });
    const nextPolicy: RunRetryPolicyRecord = {
      ...policy,
      version: policy.version + 1,
      updatedAtMs: atMs,
    };
    delete nextPolicy.nextAttemptAtMs;
    if (
      !(await transaction.compareAndSetRun(queued.run, run.version)) ||
      !(await transaction.compareAndSetRetryPolicy(nextPolicy, policy.version))
    ) {
      throw new RunVersionConflictError(run.id, run.version, run.version);
    }
    await transaction.insertAttempt(attempt);
    const queuedEvent = this.event(
      queued.run,
      queued.event,
      attempt.id,
      `run-lost-retry-queued:${attempt.id}`,
      atMs,
      { previous_attempt_id: lostAttempt.id },
    );
    await transaction.appendEvent(queuedEvent);

    const claimed = reserveRunEvent(queued.run, queued.run.version);
    if (
      !(await transaction.compareAndSetRun(claimed.run, queued.run.version))
    ) {
      throw new RunVersionConflictError(
        run.id,
        queued.run.version,
        queued.run.version,
      );
    }
    const claimedEvent = this.event(
      claimed.run,
      {
        sequence: claimed.sequence,
        type: 'attempt.claimed',
        payload: {
          attempt: attempt.attempt,
          executor_type: attempt.executorType,
          version: claimed.run.version,
        },
      },
      attempt.id,
      `run-lost-retry-attempt-claimed:${attempt.id}`,
      atMs,
      { previous_attempt_id: lostAttempt.id },
    );
    await transaction.appendEvent(claimedEvent);
    return {
      status: 'requeued',
      run: claimed.run,
      attempt,
      policy: nextPolicy,
      events: [queuedEvent, claimedEvent],
    };
  }

  private async finishRun(
    transaction: RunRepositoryTransaction,
    run: RunRecord,
    attempt: RunAttemptRecord,
    policy: RunRetryPolicyRecord | null,
    atMs: number,
    status:
      | 'cancelled'
      | 'failed_disabled'
      | 'failed_unsafe'
      | 'failed_exhausted',
    to: 'cancelled' | 'failed',
    errorCode: string,
    errorSummary: string,
  ): Promise<RunLostRetryResult> {
    const decision = transitionRun(run, {
      to,
      expectedVersion: run.version,
      atMs,
      errorCode,
      errorSummary,
    });
    if (!(await transaction.compareAndSetRun(decision.run, run.version))) {
      throw new RunVersionConflictError(run.id, run.version, run.version);
    }
    let nextPolicy = policy ?? undefined;
    if (policy?.nextAttemptAtMs !== undefined) {
      nextPolicy = {
        ...policy,
        version: policy.version + 1,
        updatedAtMs: atMs,
      };
      delete nextPolicy.nextAttemptAtMs;
      if (
        !(await transaction.compareAndSetRetryPolicy(
          nextPolicy,
          policy.version,
        ))
      ) {
        throw new RunLostRetryTargetError('retry policy update lost its race');
      }
    }
    const event = this.event(
      decision.run,
      decision.event,
      attempt.id,
      `run-lost-retry-${status}:${attempt.id}`,
      atMs,
      { attempt: attempt.attempt },
    );
    await transaction.appendEvent(event);
    return {
      status,
      run: decision.run,
      attempt,
      ...(nextPolicy === undefined ? {} : { policy: nextPolicy }),
      events: [event],
    };
  }

  private event(
    run: RunRecord,
    draft: RunDomainEventDraft,
    attemptId: string,
    dedupeKey: string,
    createdAtMs: number,
    extraPayload: Readonly<Record<string, unknown>>,
  ): RunEventRecord {
    return {
      id: this.createId(),
      runId: run.id,
      sequence: draft.sequence,
      type: draft.type,
      dedupeKey,
      actorType: 'reconciler',
      attemptId,
      payload: { ...draft.payload, ...extraPayload },
      createdAtMs,
    };
  }
}
