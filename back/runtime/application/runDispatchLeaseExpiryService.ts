import { v7 as uuidV7 } from 'uuid';
import type {
  RunAttemptRecord,
  RunEventRecord,
  RunRecord,
} from '../domain/run';
import {
  assertRunDispatchId,
  assertRunDispatchLeaseVersion,
  type RunDispatchLeaseRecord,
} from '../domain/runDispatchLease';
import {
  isTerminalRunAttemptStatus,
  isTerminalRunStatus,
  transitionRun,
  transitionRunAttempt,
  type RunDomainEventDraft,
} from '../domain/runStateMachine';
import type { RunDispatchLeaseRepository } from '../ports/runDispatchLeaseRepository';
import type { RunRepositoryTransaction } from '../ports/runRepository';

export type RunDispatchLeaseExpiryStatus =
  | 'lost'
  | 'cancellation_pending'
  | 'unstarted_released'
  | 'terminal_released'
  | 'already_expired'
  | 'not_due'
  | 'not_eligible'
  | 'not_found';

export interface RunDispatchLeaseExpiryResult {
  status: RunDispatchLeaseExpiryStatus;
  lease?: RunDispatchLeaseRecord;
  run?: RunRecord;
  attempt?: RunAttemptRecord;
  events?: readonly RunEventRecord[];
}

export class RunDispatchLeaseExpiryTargetError extends Error {
  constructor(message: string) {
    super(`Run dispatch lease expiry target is inconsistent: ${message}`);
    this.name = 'RunDispatchLeaseExpiryTargetError';
  }
}

interface ExpiryMutation {
  status:
    | 'lost'
    | 'cancellation_pending'
    | 'unstarted_released'
    | 'terminal_released';
  run: RunRecord;
  attempt: RunAttemptRecord;
  events: readonly RunEventRecord[];
}

/**
 * Server-owned expiry decision. No Worker principal can call this path with a
 * stale fence; the repository locks the authoritative lease and releases it
 * in the same transaction as any Attempt/Run lost transition.
 */
export class RunDispatchLeaseExpiryService {
  private readonly clock: { now(): number };
  private readonly createEventId: () => string;

  constructor(
    private readonly leases: RunDispatchLeaseRepository,
    options: { clock?: { now(): number }; createEventId?: () => string } = {},
  ) {
    this.clock = options.clock ?? Date;
    this.createEventId = options.createEventId ?? uuidV7;
  }

  async reconcile(
    runId: string,
    attemptId: string,
  ): Promise<RunDispatchLeaseExpiryResult> {
    assertRunDispatchId('runId', runId);
    assertRunDispatchId('attemptId', attemptId);
    const observedAtMs = this.now();
    const attemptEventId = this.eventId('attemptEventId');
    const runEventId = this.eventId('runEventId');
    const result = await this.leases.expireWithLease(
      { runId, attemptId, observedAtMs },
      (transaction, lease) =>
        this.reconcileTarget(
          transaction,
          lease,
          observedAtMs,
          attemptEventId,
          runEventId,
        ),
    );
    if (result.status === 'expired') {
      return {
        ...result.value,
        lease: result.lease,
      };
    }
    return {
      status: result.status,
      ...(result.lease === undefined ? {} : { lease: result.lease }),
    };
  }

  private async reconcileTarget(
    transaction: RunRepositoryTransaction,
    lease: RunDispatchLeaseRecord,
    observedAtMs: number,
    attemptEventId: string,
    runEventId: string,
  ): Promise<ExpiryMutation> {
    const [run, attempt] = await Promise.all([
      transaction.findRunById(lease.runId),
      transaction.findAttemptById(lease.attemptId),
    ]);
    if (!run || !attempt || attempt.runId !== run.id) {
      throw new RunDispatchLeaseExpiryTargetError('Run or Attempt is missing');
    }
    if (
      run.executionOwner !== 'runtime' ||
      (attempt.workerId !== undefined && attempt.workerId !== lease.workerId)
    ) {
      throw new RunDispatchLeaseExpiryTargetError(
        'execution ownership does not match the expired lease',
      );
    }
    if (isTerminalRunStatus(run.status) || isTerminalRunAttemptStatus(attempt.status)) {
      return {
        status: 'terminal_released',
        run,
        attempt,
        events: [],
      };
    }
    if (run.cancelRequestedAtMs !== undefined) {
      return {
        status: 'cancellation_pending',
        run,
        attempt,
        events: [],
      };
    }
    if (attempt.status === 'claimed' && run.status === 'dispatching') {
      return {
        status: 'unstarted_released',
        run,
        attempt,
        events: [],
      };
    }
    if (
      (attempt.status !== 'starting' && attempt.status !== 'running') ||
      (run.status !== 'dispatching' && run.status !== 'running')
    ) {
      throw new RunDispatchLeaseExpiryTargetError(
        'active Run and Attempt states do not match',
      );
    }

    const atMs = Math.max(
      observedAtMs,
      run.createdAtMs,
      run.startedAtMs ?? 0,
      attempt.createdAtMs,
      attempt.startedAtMs ?? 0,
    );
    const errorCode = 'REMOTE_RUN_LEASE_EXPIRED';
    const errorSummary =
      'Remote execution authority expired before completion was observed';
    const attemptDecision = transitionRunAttempt(run, attempt, {
      to: 'lost',
      expectedRunVersion: run.version,
      atMs,
      errorCode,
      errorSummary,
    });
    const runDecision = transitionRun(attemptDecision.run, {
      to: 'lost',
      expectedVersion: attemptDecision.run.version,
      atMs,
      errorCode,
      errorSummary,
    });
    if (
      !(await transaction.compareAndSetRun(
        attemptDecision.run,
        run.version,
      )) ||
      !(await transaction.compareAndSetAttempt(attemptDecision.attempt, {
        status: attempt.status,
        callbackSequence: attempt.callbackSequence,
      }))
    ) {
      throw new RunDispatchLeaseExpiryTargetError(
        'Attempt lost transition lost its compare-and-set race',
      );
    }
    const attemptEvent = this.event(
      attemptEventId,
      attemptDecision.run,
      attemptDecision.event,
      attempt.id,
      lease,
      'attempt',
      atMs,
    );
    await transaction.appendEvent(attemptEvent);
    if (
      !(await transaction.compareAndSetRun(
        runDecision.run,
        attemptDecision.run.version,
      ))
    ) {
      throw new RunDispatchLeaseExpiryTargetError(
        'Run lost transition lost its compare-and-set race',
      );
    }
    const runEvent = this.event(
      runEventId,
      runDecision.run,
      runDecision.event,
      attempt.id,
      lease,
      'run',
      atMs,
    );
    await transaction.appendEvent(runEvent);
    return {
      status: 'lost',
      run: runDecision.run,
      attempt: attemptDecision.attempt,
      events: [attemptEvent, runEvent],
    };
  }

  private event(
    id: string,
    run: RunRecord,
    draft: RunDomainEventDraft,
    attemptId: string,
    lease: RunDispatchLeaseRecord,
    phase: 'attempt' | 'run',
    createdAtMs: number,
  ): RunEventRecord {
    return {
      id,
      runId: run.id,
      sequence: draft.sequence,
      type: draft.type,
      dedupeKey: `run-lease-expiry:${attemptId}:${lease.leaseGeneration}:${phase}`,
      actorType: 'reconciler',
      attemptId,
      payload: {
        ...draft.payload,
        lease_generation: lease.leaseGeneration,
        worker_id: lease.workerId,
      },
      createdAtMs,
    };
  }

  private eventId(name: string): string {
    const id = this.createEventId();
    assertRunDispatchId(name, id);
    return id;
  }

  private now(): number {
    const nowMs = this.clock.now();
    assertRunDispatchLeaseVersion('observedAtMs', nowMs);
    return nowMs;
  }
}
