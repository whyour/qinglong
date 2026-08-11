import { v7 as uuidV7 } from 'uuid';
import type {
  ExecutionOrigin,
  RunAttemptRecord,
  RunEventRecord,
  RunRecord,
} from '../domain/run';
import {
  reserveRunEvent,
  transitionRun,
  type RunDomainEventDraft,
} from '../domain/runStateMachine';
import { RunVersionConflictError } from '../domain/stateMachineErrors';
import type { ExecutorType } from '../domain/execution';
import {
  assertAdmittedRunRetryPolicy,
  type RunRetryPolicyDefinition,
  type RunRetryPolicyRecord,
} from '../domain/runRetryPolicy';
import type { RunRepository } from '../ports/runRepository';
import type { RunCommandActor } from './runCommandService';

export interface PrimaryRunDefinition {
  projectId: string;
  taskId: string;
  taskRevision: string;
  taskName?: string;
  taskSnapshotRef?: string;
  legacyCronId?: number;
  triggerId?: string;
  triggerType: string;
  executionOrigin: ExecutionOrigin;
  triggeredBy?: string;
  requestId?: string;
  scheduledForMs?: number;
  priority?: number;
  idempotencyKey?: string;
  inputRef?: string;
  outputRef?: string;
  acceptedAtMs: number;
  actor: RunCommandActor;
  retryPolicy?: RunRetryPolicyDefinition;
}

export interface PrimaryRunReference {
  run: RunRecord;
  attempt: RunAttemptRecord;
}

export type PrimaryRunIdFactory = () => string;

/**
 * Creates the durable runtime-owned aggregate before an Executor can observe it.
 */
export class PrimaryRunCreator {
  constructor(
    private readonly repository: RunRepository,
    private readonly createId: PrimaryRunIdFactory = uuidV7,
  ) {}

  async create(
    definition: PrimaryRunDefinition,
    executorType: ExecutorType,
  ): Promise<PrimaryRunReference> {
    const initialRun: RunRecord = {
      id: this.createId(),
      projectId: definition.projectId,
      taskId: definition.taskId,
      taskRevision: definition.taskRevision,
      ...(definition.taskName === undefined
        ? {}
        : { taskName: definition.taskName }),
      ...(definition.taskSnapshotRef === undefined
        ? {}
        : { taskSnapshotRef: definition.taskSnapshotRef }),
      ...(definition.legacyCronId === undefined
        ? {}
        : { legacyCronId: definition.legacyCronId }),
      ...(definition.triggerId === undefined
        ? {}
        : { triggerId: definition.triggerId }),
      triggerType: definition.triggerType,
      executionOrigin: definition.executionOrigin,
      executionOwner: 'runtime',
      ...(definition.triggeredBy === undefined
        ? {}
        : { triggeredBy: definition.triggeredBy }),
      ...(definition.requestId === undefined
        ? {}
        : { requestId: definition.requestId }),
      ...(definition.scheduledForMs === undefined
        ? {}
        : { scheduledForMs: definition.scheduledForMs }),
      status: 'created',
      version: 0,
      eventSequence: 0,
      priority: definition.priority ?? 0,
      ...(definition.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: definition.idempotencyKey }),
      ...(definition.inputRef === undefined
        ? {}
        : { inputRef: definition.inputRef }),
      ...(definition.outputRef === undefined
        ? {}
        : { outputRef: definition.outputRef }),
      createdAtMs: definition.acceptedAtMs,
    };
    const initialAttempt: RunAttemptRecord = {
      id: this.createId(),
      runId: initialRun.id,
      attempt: 1,
      status: 'claimed',
      executorType,
      callbackSequence: 0,
      createdAtMs: definition.acceptedAtMs,
    };
    let retryPolicy: RunRetryPolicyRecord | undefined;
    if (definition.retryPolicy !== undefined) {
      assertAdmittedRunRetryPolicy(definition.retryPolicy);
      retryPolicy = {
        runId: initialRun.id,
        ...definition.retryPolicy,
        version: 0,
        createdAtMs: definition.acceptedAtMs,
        updatedAtMs: definition.acceptedAtMs,
      };
    }

    const run = await this.repository.transaction(async (transaction) => {
      await transaction.insertRun(initialRun);
      await transaction.insertAttempt(initialAttempt);
      if (retryPolicy !== undefined) {
        await transaction.insertRetryPolicy(retryPolicy);
      }

      const created = reserveRunEvent(initialRun, 0);
      const createdUpdated = await transaction.compareAndSetRun(created.run, 0);
      if (!createdUpdated) {
        throw new RunVersionConflictError(initialRun.id, 0, initialRun.version);
      }
      await transaction.appendEvent(
        this.event(
          created.run,
          {
            sequence: created.sequence,
            type: 'run.created',
            payload: {
              status: 'created',
              version: created.run.version,
              execution_owner: 'runtime',
            },
          },
          definition.actor,
          `primary-run-created:${initialRun.id}`,
          definition.acceptedAtMs,
        ),
      );

      const queued = transitionRun(created.run, {
        to: 'queued',
        expectedVersion: created.run.version,
        atMs: definition.acceptedAtMs,
      });
      const queuedUpdated = await transaction.compareAndSetRun(
        queued.run,
        created.run.version,
      );
      if (!queuedUpdated) {
        throw new RunVersionConflictError(
          initialRun.id,
          created.run.version,
          created.run.version,
        );
      }
      await transaction.appendEvent(
        this.event(
          queued.run,
          queued.event,
          definition.actor,
          `primary-run-queued:${initialRun.id}`,
          definition.acceptedAtMs,
        ),
      );
      return queued.run;
    });

    return { run, attempt: initialAttempt };
  }

  private event(
    run: RunRecord,
    draft: RunDomainEventDraft,
    actor: RunCommandActor,
    dedupeKey: string,
    createdAtMs: number,
  ): RunEventRecord {
    return {
      id: this.createId(),
      runId: run.id,
      sequence: draft.sequence,
      type: draft.type,
      dedupeKey,
      actorType: actor.type,
      ...(actor.id === undefined ? {} : { actorId: actor.id }),
      payload: draft.payload,
      createdAtMs,
    };
  }
}
