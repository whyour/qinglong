import { v7 as uuidV7 } from 'uuid';
import type {
  RunAttemptRecord,
  RunAttemptStatus,
  RunEventRecord,
  RunRecord,
  RunStatus,
} from '../domain/run';
import {
  assertRunDispatchId,
  assertRunDispatchLeaseToken,
  assertRunDispatchLeaseVersion,
  assertRunDispatchWorkerFence,
  type RunDispatchLeaseRecord,
} from '../domain/runDispatchLease';
import {
  MAX_EXECUTOR_HANDLE_LENGTH,
  MAX_LOG_ARTIFACT_ID_LENGTH,
  transitionRun,
  transitionRunAttempt,
  type RunDomainEventDraft,
} from '../domain/runStateMachine';
import type { RunDispatchLeaseRepository } from '../ports/runDispatchLeaseRepository';
import type { RunRepositoryTransaction } from '../ports/runRepository';
import type { AuthenticatedWorkerPrincipal } from './workerControlService';
import { WorkerPrincipalMismatchError } from './workerControlService';

export interface RemoteRunLeaseFence {
  runId: string;
  attemptId: string;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseGeneration: number;
  leaseToken: string;
  expectedLeaseVersion: number;
  executorType: string;
}

export interface AcknowledgeRemoteRunStartingCommand
  extends RemoteRunLeaseFence {}

export interface AcknowledgeRemoteRunRunningCommand
  extends RemoteRunLeaseFence {
  startedAtMs: number;
  executorHandle: string;
  logArtifactId?: string;
}

export interface FailRemoteRunStartCommand extends RemoteRunLeaseFence {}

export interface RemoteRunActivationResult {
  status:
    | 'applied'
    | 'already_starting'
    | 'already_running'
    | 'already_terminal';
  run: RunRecord;
  attempt: RunAttemptRecord;
  lease: RunDispatchLeaseRecord;
  events: readonly RunEventRecord[];
}

export class RemoteRunActivationNotFoundError extends Error {
  constructor() {
    super('Remote Run activation target was not found');
    this.name = 'RemoteRunActivationNotFoundError';
  }
}

export class RemoteRunActivationUnauthorizedError extends Error {
  constructor() {
    super('Remote Run activation target is not owned by this execution path');
    this.name = 'RemoteRunActivationUnauthorizedError';
  }
}

export class RemoteRunActivationStateError extends Error {
  constructor(message = 'Remote Run activation state is inconsistent') {
    super(message);
    this.name = 'RemoteRunActivationStateError';
  }
}

class RemoteRunActivationConcurrentWriteError extends Error {}

interface StartFailureMapping {
  attemptStatus: Extract<
    RunAttemptStatus,
    'failed' | 'cancelled' | 'timed_out'
  >;
  runStatus: Extract<RunStatus, 'failed' | 'cancelled' | 'timed_out'>;
  errorCode:
    | 'EXECUTOR_START_FAILED'
    | 'EXECUTION_CANCELLED'
    | 'EXECUTION_TIMED_OUT';
  errorSummary: string;
}

function assertExecutorType(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError('Remote Run executorType is invalid');
  }
}

function startFailureMapping(run: RunRecord): StartFailureMapping {
  if (run.cancelRequestedAtMs !== undefined) {
    if (run.cancelReason === 'timeout') {
      return {
        attemptStatus: 'timed_out',
        runStatus: 'timed_out',
        errorCode: 'EXECUTION_TIMED_OUT',
        errorSummary: 'Execution timed out before the executor started',
      };
    }
    return {
      attemptStatus: 'cancelled',
      runStatus: 'cancelled',
      errorCode: 'EXECUTION_CANCELLED',
      errorSummary: 'Execution was cancelled before the executor started',
    };
  }
  return {
    attemptStatus: 'failed',
    runStatus: 'failed',
    errorCode: 'EXECUTOR_START_FAILED',
    errorSummary: 'Executor failed before execution ownership was established',
  };
}

export class RemoteRunActivationService {
  private readonly clock: { now(): number };
  private readonly createEventId: () => string;

  constructor(
    private readonly leases: RunDispatchLeaseRepository,
    options: { clock?: { now(): number }; createEventId?: () => string } = {},
  ) {
    this.clock = options.clock ?? Date;
    this.createEventId = options.createEventId ?? uuidV7;
  }

  async acknowledgeStarting(
    principal: AuthenticatedWorkerPrincipal,
    command: AcknowledgeRemoteRunStartingCommand,
  ): Promise<RemoteRunActivationResult> {
    this.assertCommand(principal, command);
    const observedAtMs = this.now();
    const eventId = this.createEventId();
    assertRunDispatchId('eventId', eventId);
    const result = await this.leases.withLease(
      this.useLeaseCommand(command, observedAtMs),
      async (transaction, lease) => {
        const { run, attempt } = await this.loadTarget(transaction, command);
        if (attempt.status === 'starting') {
          if (
            run.status !== 'dispatching' ||
            attempt.workerId !== command.workerId
          ) {
            throw new RemoteRunActivationStateError();
          }
          return {
            status: 'already_starting' as const,
            run,
            attempt,
            events: [] as RunEventRecord[],
          };
        }
        if (attempt.status === 'running') {
          if (
            run.status !== 'running' ||
            attempt.workerId !== command.workerId
          ) {
            throw new RemoteRunActivationStateError();
          }
          return {
            status: 'already_running' as const,
            run,
            attempt,
            events: [] as RunEventRecord[],
          };
        }
        if (attempt.status !== 'claimed' || run.status !== 'dispatching') {
          throw new RemoteRunActivationStateError(
            'Remote Run must be claimed and dispatching before start acknowledgement',
          );
        }
        const atMs = Math.max(
          observedAtMs,
          run.createdAtMs,
          attempt.createdAtMs,
        );
        const decision = transitionRunAttempt(run, attempt, {
          to: 'starting',
          expectedRunVersion: run.version,
          atMs,
        });
        const activatedAttempt: RunAttemptRecord = {
          ...decision.attempt,
          workerId: command.workerId,
        };
        await this.persistAttemptTransition(
          transaction,
          run,
          attempt,
          decision.run,
          activatedAttempt,
        );
        const event = this.event(
          eventId,
          decision.run,
          decision.event,
          attempt.id,
          lease,
          command.workerId,
          'starting',
          atMs,
        );
        await transaction.appendEvent(event);
        return {
          status: 'applied' as const,
          run: decision.run,
          attempt: activatedAttempt,
          events: [event],
        };
      },
    );
    return { ...result.value, lease: result.lease };
  }

  async acknowledgeRunning(
    principal: AuthenticatedWorkerPrincipal,
    command: AcknowledgeRemoteRunRunningCommand,
  ): Promise<RemoteRunActivationResult> {
    this.assertCommand(principal, command);
    assertRunDispatchLeaseVersion('startedAtMs', command.startedAtMs);
    if (
      typeof command.executorHandle !== 'string' ||
      command.executorHandle.length < 1 ||
      command.executorHandle.length > MAX_EXECUTOR_HANDLE_LENGTH
    ) {
      throw new TypeError('Remote Run executorHandle is invalid');
    }
    if (
      command.logArtifactId !== undefined &&
      (typeof command.logArtifactId !== 'string' ||
        command.logArtifactId.length < 1 ||
        command.logArtifactId.length > MAX_LOG_ARTIFACT_ID_LENGTH)
    ) {
      throw new TypeError('Remote Run logArtifactId is invalid');
    }
    const observedAtMs = this.now();
    if (command.startedAtMs > observedAtMs) {
      throw new TypeError('Remote Run cannot start in the future');
    }
    const attemptEventId = this.createEventId();
    const runEventId = this.createEventId();
    assertRunDispatchId('attemptEventId', attemptEventId);
    assertRunDispatchId('runEventId', runEventId);
    const result = await this.leases.withLease(
      this.useLeaseCommand(command, observedAtMs),
      async (transaction, lease) => {
        const { run, attempt } = await this.loadTarget(transaction, command);
        if (attempt.status === 'running') {
          if (
            run.status !== 'running' ||
            attempt.workerId !== command.workerId ||
            attempt.executorHandle !== command.executorHandle ||
            attempt.logArtifactId !== command.logArtifactId
          ) {
            throw new RemoteRunActivationStateError(
              'Remote Run running acknowledgement metadata does not match',
            );
          }
          return {
            status: 'already_running' as const,
            run,
            attempt,
            events: [] as RunEventRecord[],
          };
        }
        if (attempt.status !== 'starting' || run.status !== 'dispatching') {
          throw new RemoteRunActivationStateError(
            'Remote Run must be starting before running acknowledgement',
          );
        }
        const atMs = Math.max(
          command.startedAtMs,
          run.createdAtMs,
          attempt.createdAtMs,
        );
        const attemptDecision = transitionRunAttempt(run, attempt, {
          to: 'running',
          expectedRunVersion: run.version,
          atMs,
          executorHandle: command.executorHandle,
          ...(command.logArtifactId === undefined
            ? {}
            : { logArtifactId: command.logArtifactId }),
        });
        const runDecision = transitionRun(attemptDecision.run, {
          to: 'running',
          expectedVersion: attemptDecision.run.version,
          atMs,
        });
        await this.persistAttemptTransition(
          transaction,
          run,
          attempt,
          attemptDecision.run,
          attemptDecision.attempt,
        );
        const attemptEvent = this.event(
          attemptEventId,
          attemptDecision.run,
          attemptDecision.event,
          attempt.id,
          lease,
          command.workerId,
          'running-attempt',
          atMs,
        );
        await transaction.appendEvent(attemptEvent);
        if (
          !(await transaction.compareAndSetRun(
            runDecision.run,
            attemptDecision.run.version,
          ))
        ) {
          throw new RemoteRunActivationConcurrentWriteError();
        }
        const runEvent = this.event(
          runEventId,
          runDecision.run,
          runDecision.event,
          attempt.id,
          lease,
          command.workerId,
          'running-run',
          atMs,
        );
        await transaction.appendEvent(runEvent);
        return {
          status: 'applied' as const,
          run: runDecision.run,
          attempt: attemptDecision.attempt,
          events: [attemptEvent, runEvent],
        };
      },
    );
    return { ...result.value, lease: result.lease };
  }

  async failStart(
    principal: AuthenticatedWorkerPrincipal,
    command: FailRemoteRunStartCommand,
  ): Promise<RemoteRunActivationResult> {
    this.assertCommand(principal, command);
    const failedAtMs = this.now();
    const attemptEventId = this.createEventId();
    const runEventId = this.createEventId();
    assertRunDispatchId('attemptEventId', attemptEventId);
    assertRunDispatchId('runEventId', runEventId);
    const result = await this.leases.completeWithLease(
      {
        ...this.useLeaseCommand(command, failedAtMs),
        completedAtMs: failedAtMs,
      },
      async (transaction, lease) => {
        const { run, attempt } = await this.loadTarget(transaction, command);
        const mapping = startFailureMapping(run);
        if (
          attempt.status === mapping.attemptStatus &&
          run.status === mapping.runStatus &&
          attempt.errorCode === mapping.errorCode &&
          run.errorCode === mapping.errorCode
        ) {
          return {
            status: 'already_terminal' as const,
            run,
            attempt,
            events: [] as RunEventRecord[],
          };
        }
        if (attempt.status !== 'starting' || run.status !== 'dispatching') {
          throw new RemoteRunActivationStateError(
            'Only a starting Remote Run can report executor start failure',
          );
        }
        const atMs = Math.max(failedAtMs, run.createdAtMs, attempt.createdAtMs);
        const attemptDecision = transitionRunAttempt(run, attempt, {
          to: mapping.attemptStatus,
          expectedRunVersion: run.version,
          atMs,
          callbackSequence: attempt.callbackSequence + 1,
          errorCode: mapping.errorCode,
          errorSummary: mapping.errorSummary,
        });
        const runDecision = transitionRun(attemptDecision.run, {
          to: mapping.runStatus,
          expectedVersion: attemptDecision.run.version,
          atMs,
          errorCode: mapping.errorCode,
          errorSummary: mapping.errorSummary,
        });
        await this.persistAttemptTransition(
          transaction,
          run,
          attempt,
          attemptDecision.run,
          attemptDecision.attempt,
        );
        const attemptEvent = this.event(
          attemptEventId,
          attemptDecision.run,
          attemptDecision.event,
          attempt.id,
          lease,
          command.workerId,
          'start-failed-attempt',
          atMs,
        );
        await transaction.appendEvent(attemptEvent);
        if (
          !(await transaction.compareAndSetRun(
            runDecision.run,
            attemptDecision.run.version,
          ))
        ) {
          throw new RemoteRunActivationConcurrentWriteError();
        }
        const runEvent = this.event(
          runEventId,
          runDecision.run,
          runDecision.event,
          attempt.id,
          lease,
          command.workerId,
          'start-failed-run',
          atMs,
        );
        await transaction.appendEvent(runEvent);
        return {
          status: 'applied' as const,
          run: runDecision.run,
          attempt: attemptDecision.attempt,
          events: [attemptEvent, runEvent],
        };
      },
    );
    return { ...result.value, lease: result.lease };
  }

  private useLeaseCommand(command: RemoteRunLeaseFence, observedAtMs: number) {
    return {
      runId: command.runId,
      attemptId: command.attemptId,
      workerId: command.workerId,
      workerSessionId: command.workerSessionId,
      workerGeneration: command.workerGeneration,
      leaseGeneration: command.leaseGeneration,
      leaseToken: command.leaseToken,
      expectedVersion: command.expectedLeaseVersion,
      observedAtMs,
    };
  }

  private async loadTarget(
    transaction: RunRepositoryTransaction,
    command: RemoteRunLeaseFence,
  ): Promise<{ run: RunRecord; attempt: RunAttemptRecord }> {
    const [run, attempt] = await Promise.all([
      transaction.findRunById(command.runId),
      transaction.findAttemptById(command.attemptId),
    ]);
    if (!run || !attempt || attempt.runId !== run.id) {
      throw new RemoteRunActivationNotFoundError();
    }
    if (
      run.executionOwner !== 'runtime' ||
      attempt.executorType !== command.executorType
    ) {
      throw new RemoteRunActivationUnauthorizedError();
    }
    return { run, attempt };
  }

  private async persistAttemptTransition(
    transaction: RunRepositoryTransaction,
    previousRun: RunRecord,
    previousAttempt: RunAttemptRecord,
    run: RunRecord,
    attempt: RunAttemptRecord,
  ): Promise<void> {
    if (
      !(await transaction.compareAndSetRun(run, previousRun.version)) ||
      !(await transaction.compareAndSetAttempt(attempt, {
        status: previousAttempt.status,
        callbackSequence: previousAttempt.callbackSequence,
      }))
    ) {
      throw new RemoteRunActivationConcurrentWriteError();
    }
  }

  private event(
    id: string,
    run: RunRecord,
    draft: RunDomainEventDraft,
    attemptId: string,
    lease: RunDispatchLeaseRecord,
    workerId: string,
    phase: string,
    createdAtMs: number,
  ): RunEventRecord {
    return {
      id,
      runId: run.id,
      sequence: draft.sequence,
      type: draft.type,
      dedupeKey: `remote-activation:${attemptId}:${lease.leaseGeneration}:${phase}`,
      actorType: 'worker',
      actorId: workerId,
      attemptId,
      payload: {
        ...draft.payload,
        lease_generation: lease.leaseGeneration,
      },
      createdAtMs,
    };
  }

  private assertCommand(
    principal: AuthenticatedWorkerPrincipal,
    command: RemoteRunLeaseFence,
  ): void {
    if (principal.workerId !== command.workerId) {
      throw new WorkerPrincipalMismatchError();
    }
    assertRunDispatchId('runId', command.runId);
    assertRunDispatchId('attemptId', command.attemptId);
    assertRunDispatchWorkerFence(command);
    assertRunDispatchLeaseToken(command.leaseToken);
    assertRunDispatchLeaseVersion(
      'leaseGeneration',
      command.leaseGeneration,
      true,
    );
    assertRunDispatchLeaseVersion(
      'expectedLeaseVersion',
      command.expectedLeaseVersion,
    );
    assertExecutorType(command.executorType);
  }

  private now(): number {
    const nowMs = this.clock.now();
    assertRunDispatchLeaseVersion('observedAtMs', nowMs);
    return nowMs;
  }
}
