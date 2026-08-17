import { createHash } from 'node:crypto';
import { v7 as uuidV7 } from 'uuid';
import type {
  RunAttemptRecord,
  RunAttemptStatus,
  RunEventRecord,
  RunRecord,
  RunStatus,
} from '../domain/run';
import {
  isTerminalRunAttemptStatus,
  isTerminalRunStatus,
  reserveRunEvent,
  transitionRun,
  transitionRunAttempt,
  type RunAttemptTransitionCommand,
  type RunAttemptTransitionDecision,
  type RunDomainEventDraft,
  type RunTransitionCommand,
  type RunTransitionDecision,
} from '../domain/runStateMachine';
import { RunVersionConflictError } from '../domain/stateMachineErrors';
import type {
  LegacyExecutionAcceptedFact,
  LegacyExecutionCancelledFact,
  LegacyExecutionExitedFact,
  LegacyExecutionSpawnedFact,
  LegacyExecutionStartFailedFact,
} from '../ports/legacyExecutionObserver';
import type {
  RunRepository,
  RunRepositoryTransaction,
} from '../ports/runRepository';
import {
  RunAttemptConcurrentWriteError,
  RunAttemptNotFoundError,
  RunNotFoundError,
} from './commandErrors';

export interface LegacyShadowRunReference {
  runId: string;
  attemptId: string;
}

export type ShadowIdFactory = () => string;

function deterministicShadowId(
  requestId: string,
  acceptedAtMs: number,
  domain: 'run' | 'attempt',
): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId) ||
    !Number.isSafeInteger(acceptedAtMs) ||
    acceptedAtMs < 0 ||
    acceptedAtMs > 0xffffffffffff
  ) {
    throw new TypeError('Invalid deterministic Legacy Shadow identity');
  }
  const bytes = createHash('sha256')
    .update(`qinglong:legacy-shadow:${domain}:`)
    .update(requestId)
    .digest()
    .subarray(0, 16);
  let timestamp = acceptedAtMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(
    12,
    16,
  )}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export class LegacyShadowRunWriter {
  constructor(
    private readonly repository: RunRepository,
    private readonly createId: ShadowIdFactory = uuidV7,
  ) {}

  async accept(
    fact: LegacyExecutionAcceptedFact,
  ): Promise<LegacyShadowRunReference> {
    const reference =
      fact.requestId === undefined
        ? { runId: this.createId(), attemptId: this.createId() }
        : {
            runId: deterministicShadowId(
              fact.requestId,
              fact.acceptedAtMs,
              'run',
            ),
            attemptId: deterministicShadowId(
              fact.requestId,
              fact.acceptedAtMs,
              'attempt',
            ),
          };
    const idempotencyKey =
      fact.requestId === undefined
        ? undefined
        : `legacy-shadow:${fact.origin}:${fact.requestId}`;
    const initialRun: RunRecord = {
      id: reference.runId,
      projectId: fact.projectId,
      taskId: fact.taskId,
      taskRevision: fact.taskRevision,
      ...(fact.taskName === undefined ? {} : { taskName: fact.taskName }),
      ...(fact.legacyCronId === undefined
        ? {}
        : { legacyCronId: fact.legacyCronId }),
      triggerType: fact.triggerType,
      executionOrigin: fact.origin,
      executionOwner: 'legacy',
      ...(fact.triggeredBy === undefined
        ? {}
        : { triggeredBy: fact.triggeredBy }),
      ...(fact.requestId === undefined ? {} : { requestId: fact.requestId }),
      ...(fact.scheduledForMs === undefined
        ? {}
        : { scheduledForMs: fact.scheduledForMs }),
      status: 'created',
      version: 0,
      eventSequence: 0,
      priority: 0,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      createdAtMs: fact.acceptedAtMs,
    };
    const initialAttempt: RunAttemptRecord = {
      id: reference.attemptId,
      runId: reference.runId,
      attempt: 1,
      status: 'claimed',
      executorType: 'legacy_local',
      callbackSequence: 0,
      createdAtMs: fact.acceptedAtMs,
    };

    try {
      await this.repository.transaction(async (transaction) => {
        await transaction.insertRun(initialRun);
        await transaction.insertAttempt(initialAttempt);

        const created = reserveRunEvent(initialRun, 0);
        const createdRun = created.run;
        const createdUpdated = await transaction.compareAndSetRun(
          createdRun,
          0,
        );
        if (!createdUpdated) {
          throw new RunVersionConflictError(
            initialRun.id,
            0,
            initialRun.version,
          );
        }
        await transaction.appendEvent(
          this.event(
            createdRun,
            {
              sequence: created.sequence,
              type: 'run.created',
              payload: {
                status: 'created',
                version: createdRun.version,
                execution_owner: 'legacy',
                shadow: true,
              },
            },
            fact.acceptedAtMs,
          ),
        );

        const queued = transitionRun(createdRun, {
          to: 'queued',
          expectedVersion: createdRun.version,
          atMs: fact.acceptedAtMs,
        });
        await this.persistRunDecision(
          transaction,
          createdRun,
          queued,
          fact.acceptedAtMs,
        );
      });
    } catch (error) {
      if (
        fact.requestId === undefined ||
        !(await this.isExactReplay(
          reference,
          initialRun,
          initialAttempt,
          idempotencyKey!,
        ))
      ) {
        throw error;
      }
    }
    return reference;
  }

  private async isExactReplay(
    reference: LegacyShadowRunReference,
    expectedRun: RunRecord,
    expectedAttempt: RunAttemptRecord,
    idempotencyKey: string,
  ): Promise<boolean> {
    const [run, attempt] = await Promise.all([
      this.repository.findRunById(reference.runId),
      this.repository.findAttemptById(reference.attemptId),
    ]);
    if (!run || !attempt) return false;
    return (
      run.projectId === expectedRun.projectId &&
      run.taskId === expectedRun.taskId &&
      run.taskRevision === expectedRun.taskRevision &&
      run.taskName === expectedRun.taskName &&
      run.legacyCronId === expectedRun.legacyCronId &&
      run.triggerType === expectedRun.triggerType &&
      run.executionOrigin === expectedRun.executionOrigin &&
      run.executionOwner === 'legacy' &&
      run.triggeredBy === expectedRun.triggeredBy &&
      run.requestId === expectedRun.requestId &&
      run.idempotencyKey === idempotencyKey &&
      run.createdAtMs === expectedRun.createdAtMs &&
      attempt.runId === run.id &&
      attempt.attempt === 1 &&
      attempt.executorType === 'legacy_local' &&
      attempt.createdAtMs === expectedAttempt.createdAtMs
    );
  }

  async spawned(
    reference: LegacyShadowRunReference,
    fact: LegacyExecutionSpawnedFact,
  ): Promise<void> {
    await this.repository.transaction(async (transaction) => {
      const aggregate = await this.load(transaction, reference);
      await this.ensureSpawned(
        transaction,
        aggregate.run,
        aggregate.attempt,
        fact,
      );
    });
  }

  async running(
    reference: LegacyShadowRunReference,
    atMs: number,
  ): Promise<void> {
    await this.repository.transaction(async (transaction) => {
      let { run, attempt } = await this.load(transaction, reference);
      if (isTerminalRunStatus(run.status)) return;
      ({ run, attempt } = await this.ensureSpawned(transaction, run, attempt, {
        atMs,
      }));
      await this.ensureRunning(transaction, run, attempt, atMs);
    });
  }

  async startFailed(
    reference: LegacyShadowRunReference,
    fact: LegacyExecutionStartFailedFact,
  ): Promise<void> {
    await this.repository.transaction(async (transaction) => {
      let { run, attempt } = await this.load(transaction, reference);
      if (isTerminalRunStatus(run.status)) return;
      ({ run, attempt } = await this.ensureSpawned(transaction, run, attempt, {
        atMs: fact.atMs,
      }));

      if (!isTerminalRunAttemptStatus(attempt.status)) {
        if (attempt.status === 'claimed') {
          ({ run, attempt } = await this.transitionAttempt(
            transaction,
            run,
            attempt,
            {
              to: 'starting',
              expectedRunVersion: run.version,
              atMs: fact.atMs,
            },
          ));
        }
        if (attempt.status === 'starting' || attempt.status === 'running') {
          ({ run, attempt } = await this.transitionAttempt(
            transaction,
            run,
            attempt,
            {
              to: 'failed',
              expectedRunVersion: run.version,
              atMs: fact.atMs,
              errorCode: fact.errorCode,
              errorSummary: 'Legacy process failed to start',
            },
          ));
        }
      }

      if (!isTerminalRunStatus(run.status)) {
        await this.transitionRunStatus(transaction, run, {
          to: 'failed',
          expectedVersion: run.version,
          atMs: fact.atMs,
          errorCode: fact.errorCode,
          errorSummary: 'Legacy process failed to start',
        });
      }
    });
  }

  async exited(
    reference: LegacyShadowRunReference,
    fact: LegacyExecutionExitedFact,
  ): Promise<void> {
    await this.repository.transaction(async (transaction) => {
      let { run, attempt } = await this.load(transaction, reference);
      if (isTerminalRunStatus(run.status)) return;
      ({ run, attempt } = await this.ensureSpawned(transaction, run, attempt, {
        atMs: fact.atMs,
      }));
      ({ run, attempt } = await this.ensureRunning(
        transaction,
        run,
        attempt,
        fact.atMs,
      ));

      const succeeded = fact.exitCode === 0;
      const attemptTarget: RunAttemptStatus = succeeded
        ? 'succeeded'
        : 'failed';
      const runTarget: RunStatus = succeeded ? 'succeeded' : 'failed';
      const errorCode =
        fact.exitCode === null
          ? fact.signal
            ? 'LEGACY_PROCESS_SIGNALLED'
            : 'LEGACY_EXIT_UNKNOWN'
          : succeeded
          ? undefined
          : 'LEGACY_EXIT_NON_ZERO';
      const errorSummary = errorCode
        ? 'Legacy process exited without success'
        : undefined;

      if (!isTerminalRunAttemptStatus(attempt.status)) {
        ({ run, attempt } = await this.transitionAttempt(
          transaction,
          run,
          attempt,
          {
            to: attemptTarget,
            expectedRunVersion: run.version,
            atMs: fact.atMs,
            ...(fact.exitCode === null ? {} : { exitCode: fact.exitCode }),
            ...(errorCode === undefined ? {} : { errorCode }),
            ...(errorSummary === undefined ? {} : { errorSummary }),
          },
          fact.signal === undefined ? {} : { legacy_signal: fact.signal },
        ));
      }

      if (!isTerminalRunStatus(run.status)) {
        await this.transitionRunStatus(
          transaction,
          run,
          {
            to: runTarget,
            expectedVersion: run.version,
            atMs: fact.atMs,
            ...(errorCode === undefined ? {} : { errorCode }),
            ...(errorSummary === undefined ? {} : { errorSummary }),
          },
          {
            legacy_exit_code: fact.exitCode,
            ...(fact.signal === undefined
              ? {}
              : { legacy_signal: fact.signal }),
          },
        );
      }
    });
  }

  async cancelled(
    reference: LegacyShadowRunReference,
    fact: LegacyExecutionCancelledFact,
  ): Promise<void> {
    await this.repository.transaction(async (transaction) => {
      let { run, attempt } = await this.load(transaction, reference);
      if (isTerminalRunStatus(run.status)) return;

      if (!isTerminalRunAttemptStatus(attempt.status)) {
        ({ run, attempt } = await this.transitionAttempt(
          transaction,
          run,
          attempt,
          {
            to: 'cancelled',
            expectedRunVersion: run.version,
            atMs: fact.atMs,
            errorCode: 'LEGACY_EXECUTION_CANCELLED',
            errorSummary: 'Legacy execution was cancelled',
          },
          { legacy_cancel_reason: fact.reason },
        ));
      }
      if (!isTerminalRunStatus(run.status)) {
        await this.transitionRunStatus(
          transaction,
          run,
          {
            to: 'cancelled',
            expectedVersion: run.version,
            atMs: fact.atMs,
            errorCode: 'LEGACY_EXECUTION_CANCELLED',
            errorSummary: 'Legacy execution was cancelled',
          },
          { legacy_cancel_reason: fact.reason },
        );
      }
    });
  }

  private async load(
    transaction: RunRepositoryTransaction,
    reference: LegacyShadowRunReference,
  ): Promise<{ run: RunRecord; attempt: RunAttemptRecord }> {
    const run = await transaction.findRunById(reference.runId);
    if (!run) throw new RunNotFoundError(reference.runId);
    const attempt = await transaction.findAttemptById(reference.attemptId);
    if (!attempt) throw new RunAttemptNotFoundError(reference.attemptId);
    if (attempt.runId !== run.id) {
      throw new RunAttemptConcurrentWriteError(
        attempt.id,
        attempt.status,
        attempt.callbackSequence,
      );
    }
    return { run, attempt };
  }

  private async ensureSpawned(
    transaction: RunRepositoryTransaction,
    currentRun: RunRecord,
    currentAttempt: RunAttemptRecord,
    fact: LegacyExecutionSpawnedFact,
  ): Promise<{ run: RunRecord; attempt: RunAttemptRecord }> {
    let run = currentRun;
    let attempt = currentAttempt;
    if (isTerminalRunStatus(run.status)) return { run, attempt };

    if (run.status === 'created') {
      run = await this.transitionRunStatus(transaction, run, {
        to: 'queued',
        expectedVersion: run.version,
        atMs: fact.atMs,
      });
    }
    if (run.status === 'queued') {
      run = await this.transitionRunStatus(transaction, run, {
        to: 'dispatching',
        expectedVersion: run.version,
        atMs: fact.atMs,
      });
    }
    if (attempt.status === 'claimed') {
      ({ run, attempt } = await this.transitionAttempt(
        transaction,
        run,
        attempt,
        {
          to: 'starting',
          expectedRunVersion: run.version,
          atMs: fact.atMs,
          ...(fact.pid === undefined ? {} : { pid: fact.pid }),
          ...(fact.executorHandle === undefined
            ? {}
            : { executorHandle: fact.executorHandle }),
          ...(fact.logArtifactId === undefined
            ? {}
            : { logArtifactId: fact.logArtifactId }),
        },
      ));
    }
    return { run, attempt };
  }

  private async ensureRunning(
    transaction: RunRepositoryTransaction,
    currentRun: RunRecord,
    currentAttempt: RunAttemptRecord,
    atMs: number,
  ): Promise<{ run: RunRecord; attempt: RunAttemptRecord }> {
    let run = currentRun;
    let attempt = currentAttempt;
    if (isTerminalRunStatus(run.status)) return { run, attempt };

    if (attempt.status === 'starting') {
      ({ run, attempt } = await this.transitionAttempt(
        transaction,
        run,
        attempt,
        {
          to: 'running',
          expectedRunVersion: run.version,
          atMs,
        },
      ));
    }
    if (run.status === 'dispatching') {
      run = await this.transitionRunStatus(transaction, run, {
        to: 'running',
        expectedVersion: run.version,
        atMs,
      });
    }
    return { run, attempt };
  }

  private async transitionRunStatus(
    transaction: RunRepositoryTransaction,
    current: RunRecord,
    command: RunTransitionCommand,
    extraPayload: Readonly<Record<string, unknown>> = {},
  ): Promise<RunRecord> {
    const decision = transitionRun(current, command);
    await this.persistRunDecision(
      transaction,
      current,
      decision,
      command.atMs,
      extraPayload,
    );
    return decision.run;
  }

  private async transitionAttempt(
    transaction: RunRepositoryTransaction,
    currentRun: RunRecord,
    currentAttempt: RunAttemptRecord,
    command: RunAttemptTransitionCommand,
    extraPayload: Readonly<Record<string, unknown>> = {},
  ): Promise<{ run: RunRecord; attempt: RunAttemptRecord }> {
    const decision = transitionRunAttempt(currentRun, currentAttempt, command);
    await this.persistAttemptDecision(
      transaction,
      currentRun,
      currentAttempt,
      decision,
      command.atMs,
      extraPayload,
    );
    return { run: decision.run, attempt: decision.attempt };
  }

  private async persistRunDecision(
    transaction: RunRepositoryTransaction,
    current: RunRecord,
    decision: RunTransitionDecision,
    atMs: number,
    extraPayload: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const updated = await transaction.compareAndSetRun(
      decision.run,
      current.version,
    );
    if (!updated) {
      const latest = await transaction.findRunById(current.id);
      throw new RunVersionConflictError(
        current.id,
        current.version,
        latest?.version ?? current.version,
      );
    }
    await transaction.appendEvent(
      this.event(decision.run, decision.event, atMs, extraPayload),
    );
  }

  private async persistAttemptDecision(
    transaction: RunRepositoryTransaction,
    currentRun: RunRecord,
    currentAttempt: RunAttemptRecord,
    decision: RunAttemptTransitionDecision,
    atMs: number,
    extraPayload: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const runUpdated = await transaction.compareAndSetRun(
      decision.run,
      currentRun.version,
    );
    if (!runUpdated) {
      const latest = await transaction.findRunById(currentRun.id);
      throw new RunVersionConflictError(
        currentRun.id,
        currentRun.version,
        latest?.version ?? currentRun.version,
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
    await transaction.appendEvent(
      this.event(decision.run, decision.event, atMs, extraPayload),
    );
  }

  private event(
    run: RunRecord,
    draft: RunDomainEventDraft,
    createdAtMs: number,
    extraPayload: Readonly<Record<string, unknown>> = {},
  ): RunEventRecord {
    return {
      id: this.createId(),
      runId: run.id,
      sequence: draft.sequence,
      type: draft.type,
      dedupeKey: `shadow:${draft.sequence}:${draft.type}`,
      actorType: 'compatibility',
      payload: {
        ...draft.payload,
        ...extraPayload,
        shadow: true,
      },
      createdAtMs,
    };
  }
}
