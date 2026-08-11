import { v7 as uuidV7 } from 'uuid';
import type {
  RunAttemptRecord,
  RunCancellationReason,
  RunEventActorType,
  RunEventRecord,
  RunRecord,
} from '../domain/run';
import {
  isTerminalRunAttemptStatus,
  requestRunCancellation,
  transitionRun,
  transitionRunAttempt,
  type RunAttemptTransitionCommand,
  type RunTransitionCommand,
} from '../domain/runStateMachine';
import { RunVersionConflictError } from '../domain/stateMachineErrors';
import type { RunRepository } from '../ports/runRepository';
import {
  RunAttemptConcurrentWriteError,
  RunAttemptNotFoundError,
  RunNotFoundError,
} from './commandErrors';

export interface RunCommandActor {
  type: RunEventActorType;
  id?: string;
}

export interface TransitionRunCommand extends RunTransitionCommand {
  runId: string;
  actor: RunCommandActor;
  dedupeKey?: string;
}

export interface TransitionRunAttemptCommand
  extends RunAttemptTransitionCommand {
  runId: string;
  attemptId: string;
  actor: RunCommandActor;
  dedupeKey?: string;
}

export interface RunCommandResult {
  run: RunRecord;
  event: RunEventRecord;
}

export interface RunAttemptCommandResult extends RunCommandResult {
  attempt: RunAttemptRecord;
}

export interface RequestRunCancellationCommand {
  runId: string;
  attemptId: string;
  atMs: number;
  reason: RunCancellationReason;
  actor: RunCommandActor;
  dedupeKey?: string;
}

export type RequestRunCancellationResult =
  | {
      status: 'accepted';
      run: RunRecord;
      attempt: RunAttemptRecord;
      event: RunEventRecord;
    }
  | {
      status: 'already_requested' | 'already_terminal';
      run: RunRecord;
      attempt: RunAttemptRecord;
    };

export type RunEventIdFactory = () => string;

export class RunCommandService {
  constructor(
    private readonly repository: RunRepository,
    private readonly createEventId: RunEventIdFactory = uuidV7,
  ) {}

  async transitionRun(
    command: TransitionRunCommand,
  ): Promise<RunCommandResult> {
    return this.repository.transaction(async (transaction) => {
      const current = await transaction.findRunById(command.runId);
      if (!current) throw new RunNotFoundError(command.runId);

      const decision = transitionRun(current, command);
      const updated = await transaction.compareAndSetRun(
        decision.run,
        command.expectedVersion,
      );
      if (!updated) {
        const latest = await transaction.findRunById(command.runId);
        if (!latest) throw new RunNotFoundError(command.runId);
        throw new RunVersionConflictError(
          command.runId,
          command.expectedVersion,
          latest.version,
        );
      }

      const event = this.createRunEvent({
        runId: command.runId,
        decision: decision.event,
        actor: command.actor,
        dedupeKey:
          command.dedupeKey ??
          `run-transition:${command.expectedVersion}:${command.to}`,
        createdAtMs: command.atMs,
      });
      await transaction.appendEvent(event);
      return { run: decision.run, event };
    });
  }

  async transitionRunAttempt(
    command: TransitionRunAttemptCommand,
  ): Promise<RunAttemptCommandResult> {
    return this.repository.transaction(async (transaction) => {
      const currentRun = await transaction.findRunById(command.runId);
      if (!currentRun) throw new RunNotFoundError(command.runId);

      const currentAttempt = await transaction.findAttemptById(
        command.attemptId,
      );
      if (!currentAttempt) {
        throw new RunAttemptNotFoundError(command.attemptId);
      }

      const decision = transitionRunAttempt(
        currentRun,
        currentAttempt,
        command,
      );
      const runUpdated = await transaction.compareAndSetRun(
        decision.run,
        command.expectedRunVersion,
      );
      if (!runUpdated) {
        const latest = await transaction.findRunById(command.runId);
        if (!latest) throw new RunNotFoundError(command.runId);
        throw new RunVersionConflictError(
          command.runId,
          command.expectedRunVersion,
          latest.version,
        );
      }

      const attemptUpdated = await transaction.compareAndSetAttempt(
        decision.attempt,
        {
          status: currentAttempt.status,
          callbackSequence: currentAttempt.callbackSequence,
        },
      );
      if (!attemptUpdated) {
        throw new RunAttemptConcurrentWriteError(
          currentAttempt.id,
          currentAttempt.status,
          currentAttempt.callbackSequence,
        );
      }

      const event = this.createRunEvent({
        runId: command.runId,
        attemptId: command.attemptId,
        decision: decision.event,
        actor: command.actor,
        dedupeKey:
          command.dedupeKey ??
          `attempt-transition:${command.attemptId}:${command.expectedRunVersion}:${command.to}`,
        createdAtMs: command.atMs,
      });
      await transaction.appendEvent(event);
      return { run: decision.run, attempt: decision.attempt, event };
    });
  }

  async requestCancellation(
    command: RequestRunCancellationCommand,
  ): Promise<RequestRunCancellationResult> {
    return this.repository.transaction(async (transaction) => {
      const currentRun = await transaction.findRunById(command.runId);
      if (!currentRun) throw new RunNotFoundError(command.runId);

      const currentAttempt = await transaction.findAttemptById(
        command.attemptId,
      );
      if (!currentAttempt) {
        throw new RunAttemptNotFoundError(command.attemptId);
      }
      if (currentAttempt.runId !== currentRun.id) {
        throw new RunAttemptNotFoundError(command.attemptId);
      }
      if (isTerminalRunAttemptStatus(currentAttempt.status)) {
        return {
          status: 'already_terminal',
          run: currentRun,
          attempt: currentAttempt,
        };
      }

      const decision = requestRunCancellation(currentRun, {
        expectedVersion: currentRun.version,
        atMs: command.atMs,
        reason: command.reason,
      });
      if (decision.status !== 'accepted') {
        return {
          status: decision.status,
          run: decision.run,
          attempt: currentAttempt,
        };
      }

      const updated = await transaction.compareAndSetRun(
        decision.run,
        currentRun.version,
      );
      if (!updated) {
        const latest = await transaction.findRunById(command.runId);
        if (!latest) throw new RunNotFoundError(command.runId);
        throw new RunVersionConflictError(
          command.runId,
          currentRun.version,
          latest.version,
        );
      }

      const event = this.createRunEvent({
        runId: command.runId,
        attemptId: command.attemptId,
        decision: decision.event,
        actor: command.actor,
        dedupeKey:
          command.dedupeKey ?? `run-cancel-request:${command.attemptId}`,
        createdAtMs: command.atMs,
      });
      await transaction.appendEvent(event);
      return {
        status: 'accepted',
        run: decision.run,
        attempt: currentAttempt,
        event,
      };
    });
  }

  private createRunEvent(input: {
    runId: string;
    attemptId?: string;
    decision: {
      sequence: number;
      type: string;
      payload: Readonly<Record<string, unknown>>;
    };
    actor: RunCommandActor;
    dedupeKey: string;
    createdAtMs: number;
  }): RunEventRecord {
    return {
      id: this.createEventId(),
      runId: input.runId,
      sequence: input.decision.sequence,
      type: input.decision.type,
      dedupeKey: input.dedupeKey,
      actorType: input.actor.type,
      ...(input.actor.id === undefined ? {} : { actorId: input.actor.id }),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      payload: input.decision.payload,
      createdAtMs: input.createdAtMs,
    };
  }
}
