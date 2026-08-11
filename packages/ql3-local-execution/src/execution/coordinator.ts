import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseLocalProcessDurableHandle } from '@qinglong/local-process';
import type {
  LocalProcessCommand,
  LocalProcessLaunchHandle,
  LocalProcessLaunchRequest,
  LocalProcessOutputPlan,
  LocalProcessStopResult,
} from '@qinglong/local-process';
import type {
  RunAttemptRecord,
  RunEventRecord,
  RunRecord,
  RunRepository,
  RunRepositoryTransaction,
} from '@qinglong/runtime-core/run-repository';
import type { LocalWorkflowTaskExecutionRepository } from './workflowTaskExecution';

export const LOCAL_PROCESS_EXECUTOR_TYPE = 'local_process';
export const MAX_LOCAL_EXECUTION_TIMEOUT_MS = 365 * 24 * 60 * 60_000;

export interface LocalExecutionStartCommand {
  readonly runId: string;
  readonly attemptId: string;
  readonly stepRunId?: string;
  readonly command: LocalProcessCommand;
  readonly environment?: Readonly<Record<string, string>>;
  readonly workingDirectory?: string;
  readonly output?: LocalProcessOutputPlan;
  readonly timeoutMs?: number;
}

export interface LocalExecutionStartResult {
  readonly run: RunRecord;
  readonly attempt: RunAttemptRecord;
  readonly handle: LocalProcessLaunchHandle;
}

export interface LocalExecutionLauncher {
  start(request: LocalProcessLaunchRequest): Promise<LocalProcessLaunchHandle>;
}

export interface LocalExecutionController {
  stop(durableHandle: string): Promise<LocalProcessStopResult>;
}

export interface LocalExecutionCoordinatorOptions {
  readonly clock?: { now(): number };
  readonly createEventId?: () => string;
  readonly createCallbackToken?: () => string;
  readonly workflowTasks?: LocalWorkflowTaskExecutionRepository;
}

interface AggregateSnapshot {
  readonly run: RunRecord;
  readonly attempt: RunAttemptRecord;
}

interface PreparedAggregate extends AggregateSnapshot {
  readonly callbackSequence: number;
  readonly callbackTokenHash: string;
}

interface EventDraft {
  readonly sequence: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export class LocalExecutionRejectedError extends Error {
  readonly code = 'LOCAL_EXECUTION_REJECTED';

  constructor(readonly reason: string) {
    super(`Local execution rejected: ${reason}`);
    this.name = 'LocalExecutionRejectedError';
  }
}

export class LocalExecutionConcurrentWriteError extends Error {
  readonly code = 'LOCAL_EXECUTION_CONCURRENT_WRITE';

  constructor() {
    super('Local execution aggregate changed concurrently');
    this.name = 'LocalExecutionConcurrentWriteError';
  }
}

export class LocalExecutionLaunchError extends Error {
  readonly code = 'LOCAL_EXECUTION_LAUNCH_FAILED';

  constructor(
    message: string,
    readonly snapshot: AggregateSnapshot,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LocalExecutionLaunchError';
  }
}

export class LocalExecutionOwnershipPersistenceError extends Error {
  readonly code = 'LOCAL_EXECUTION_OWNERSHIP_PERSISTENCE_FAILED';

  constructor(
    readonly compensation: LocalProcessStopResult,
    readonly snapshot: AggregateSnapshot,
    readonly cause?: unknown,
  ) {
    super('Local execution could not persist durable process ownership');
    this.name = 'LocalExecutionOwnershipPersistenceError';
  }
}

function assertSafeTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

function assertStartCommand(command: LocalExecutionStartCommand): void {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('Local execution start command is invalid');
  }
  for (const [field, value] of [
    ['runId', command.runId],
    ['attemptId', command.attemptId],
  ] as const) {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 128 ||
      /[\0\r\n]/.test(value)
    ) {
      throw new TypeError(`Local execution ${field} is invalid`);
    }
  }
  if (
    command.stepRunId !== undefined &&
    (typeof command.stepRunId !== 'string' ||
      command.stepRunId.length < 1 ||
      command.stepRunId.length > 128 ||
      /[\0\r\n]/.test(command.stepRunId))
  ) {
    throw new TypeError('Local execution stepRunId is invalid');
  }
  if (
    command.timeoutMs !== undefined &&
    (!Number.isSafeInteger(command.timeoutMs) ||
      command.timeoutMs < 1 ||
      command.timeoutMs > MAX_LOCAL_EXECUTION_TIMEOUT_MS)
  ) {
    throw new RangeError('Local execution timeout is invalid');
  }
  if (command.output !== undefined) {
    const output = command.output;
    if (
      !output ||
      typeof output !== 'object' ||
      Array.isArray(output) ||
      !path.isAbsolute(output.filePath) ||
      path.parse(output.filePath).root === output.filePath ||
      output.filePath.includes('\0') ||
      Buffer.byteLength(output.filePath, 'utf8') > 4096 ||
      !/^local-[0-9a-f]{30}$/.test(output.logArtifactId) ||
      path.basename(output.filePath) !== `${output.logArtifactId}.log` ||
      !Number.isSafeInteger(output.maximumBytes) ||
      output.maximumBytes < 64 * 1024 ||
      output.maximumBytes > 1024 * 1024 * 1024
    ) {
      throw new TypeError('Local execution output plan is invalid');
    }
  }
}

function reserveEvent(run: RunRecord): Readonly<{
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
    throw new TypeError('Local execution version or sequence overflowed');
  }
  return Object.freeze({
    run: { ...run, version, eventSequence: sequence },
    sequence,
  });
}

function event(
  id: string,
  runId: string,
  attemptId: string,
  draft: EventDraft,
  dedupeKey: string,
  actorType: RunEventRecord['actorType'],
  actorId: string,
  atMs: number,
): RunEventRecord {
  if (
    typeof id !== 'string' ||
    id.length < 1 ||
    id.length > 128 ||
    /[\0\r\n]/.test(id)
  ) {
    throw new TypeError('Local execution event id is invalid');
  }
  return {
    id,
    runId,
    attemptId,
    sequence: draft.sequence,
    type: draft.type,
    dedupeKey,
    actorType,
    actorId,
    payload: draft.payload,
    createdAtMs: atMs,
  };
}

function atOrAfter(
  now: number,
  run: RunRecord,
  attempt: RunAttemptRecord,
  additional?: number,
): number {
  assertSafeTimestamp(now, 'Local execution clock');
  if (additional !== undefined) {
    assertSafeTimestamp(additional, 'Local execution additional timestamp');
  }
  return Math.max(
    now,
    run.createdAtMs,
    run.startedAtMs ?? 0,
    attempt.createdAtMs,
    attempt.startedAtMs ?? 0,
    additional ?? 0,
  );
}

function assertClaimedAggregate(
  run: RunRecord | null,
  attempt: RunAttemptRecord | null,
  latest: RunAttemptRecord | null,
): asserts run is RunRecord & object {
  if (!run) throw new LocalExecutionRejectedError('run_not_found');
  if (!attempt) throw new LocalExecutionRejectedError('attempt_not_found');
  if (
    attempt.runId !== run.id ||
    latest?.runId !== run.id ||
    latest.id !== attempt.id ||
    run.executionOwner !== 'runtime'
  ) {
    throw new LocalExecutionRejectedError('aggregate_mismatch');
  }
  if (run.status !== 'queued') {
    throw new LocalExecutionRejectedError('run_not_queued');
  }
  if (attempt.status !== 'claimed') {
    throw new LocalExecutionRejectedError('attempt_not_claimed');
  }
  if (attempt.executorType !== LOCAL_PROCESS_EXECUTOR_TYPE) {
    throw new LocalExecutionRejectedError('executor_mismatch');
  }
  if (run.cancelRequestedAtMs !== undefined) {
    throw new LocalExecutionRejectedError('cancellation_requested');
  }
  if (
    attempt.callbackSequence !== 0 ||
    attempt.callbackTokenHash !== undefined ||
    attempt.workerId !== undefined ||
    attempt.workerSessionId !== undefined ||
    attempt.workerGeneration !== undefined ||
    attempt.executorHandle !== undefined ||
    attempt.pid !== undefined ||
    attempt.logArtifactId !== undefined ||
    attempt.leaseToken !== undefined ||
    attempt.leaseTokenDigest !== undefined ||
    attempt.leaseGeneration !== undefined ||
    attempt.leaseVersion !== undefined ||
    attempt.leaseExpiresAtMs !== undefined ||
    attempt.offerId !== undefined ||
    attempt.deadlineAtMs !== undefined ||
    attempt.startedAtMs !== undefined ||
    attempt.finishedAtMs !== undefined ||
    attempt.exitCode !== undefined ||
    attempt.errorCode !== undefined ||
    attempt.errorSummary !== undefined
  ) {
    throw new LocalExecutionRejectedError('stale_execution_authority');
  }
}

function assertPreparedAggregate(
  current: AggregateSnapshot,
  expected: PreparedAggregate,
): void {
  if (
    current.run.id !== expected.run.id ||
    current.run.version !== expected.run.version ||
    current.run.status !== 'dispatching' ||
    current.run.executionOwner !== 'runtime' ||
    current.run.cancelRequestedAtMs !== undefined ||
    current.attempt.id !== expected.attempt.id ||
    current.attempt.runId !== current.run.id ||
    current.attempt.status !== 'starting' ||
    current.attempt.executorType !== LOCAL_PROCESS_EXECUTOR_TYPE ||
    current.attempt.callbackSequence !== expected.attempt.callbackSequence ||
    current.attempt.callbackTokenHash !== expected.callbackTokenHash ||
    current.attempt.deadlineAtMs !== expected.attempt.deadlineAtMs ||
    current.attempt.logArtifactId !== expected.attempt.logArtifactId ||
    current.attempt.executorHandle !== undefined ||
    current.attempt.pid !== undefined ||
    current.attempt.startedAtMs !== undefined ||
    current.attempt.finishedAtMs !== undefined
  ) {
    throw new LocalExecutionConcurrentWriteError();
  }
}

async function loadExact(
  transaction: RunRepositoryTransaction,
  runId: string,
  attemptId: string,
): Promise<AggregateSnapshot> {
  const [run, attempt, latest] = await Promise.all([
    transaction.findRunById(runId),
    transaction.findAttemptById(attemptId),
    transaction.findLatestAttemptByRunId(runId),
  ]);
  if (!run || !attempt || latest?.id !== attempt.id) {
    throw new LocalExecutionConcurrentWriteError();
  }
  return { run, attempt };
}

export class LocalExecutionCoordinator {
  private readonly clock: { now(): number };
  private readonly createEventId: () => string;
  private readonly createCallbackToken: () => string;
  private readonly workflowTasks:
    | LocalWorkflowTaskExecutionRepository
    | undefined;

  constructor(
    private readonly repository: RunRepository,
    private readonly launcher: LocalExecutionLauncher,
    private readonly controller: LocalExecutionController,
    options: LocalExecutionCoordinatorOptions = {},
  ) {
    this.clock = options.clock ?? { now: Date.now };
    this.createEventId = options.createEventId ?? randomUUID;
    this.createCallbackToken =
      options.createCallbackToken ??
      (() => randomBytes(32).toString('base64url'));
    this.workflowTasks = options.workflowTasks;
    if (
      this.workflowTasks !== undefined &&
      (typeof this.workflowTasks.prepare !== 'function' ||
        typeof this.workflowTasks.recordRunning !== 'function' ||
        typeof this.workflowTasks.recordStartFailure !== 'function')
    ) {
      throw new TypeError(
        'Local Workflow Task execution repository is invalid',
      );
    }
  }

  async start(
    command: LocalExecutionStartCommand,
  ): Promise<LocalExecutionStartResult> {
    assertStartCommand(command);
    const callbackToken = this.createCallbackToken();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(callbackToken)) {
      throw new TypeError('Local execution callback token factory is invalid');
    }
    const callbackTokenHash = createHash('sha256')
      .update(callbackToken)
      .digest('hex');
    const prepared = await this.prepare(command, callbackTokenHash);

    let handle: LocalProcessLaunchHandle;
    try {
      handle = await this.launcher.start({
        runId: prepared.run.id,
        attemptId: prepared.attempt.id,
        callbackSequence: prepared.callbackSequence,
        callbackToken,
        command: command.command,
        ...(command.environment === undefined
          ? {}
          : { environment: command.environment }),
        ...(command.workingDirectory === undefined
          ? {}
          : { workingDirectory: command.workingDirectory }),
        ...(command.output === undefined ? {} : { output: command.output }),
      });
    } catch (error) {
      try {
        const failed = await this.recordTerminal(
          prepared,
          'failed',
          'EXECUTOR_START_FAILED',
          'Local process failed before durable ownership was established',
        );
        throw new LocalExecutionLaunchError(
          'Local process could not start',
          failed,
          error,
        );
      } catch (persistenceError) {
        if (persistenceError instanceof LocalExecutionLaunchError) {
          throw persistenceError;
        }
        throw new LocalExecutionLaunchError(
          'Local process could not start and failure state could not be persisted',
          prepared,
          new AggregateError([error, persistenceError]),
        );
      }
    }

    try {
      this.assertHandle(handle, prepared);
      const running = await this.recordRunning(prepared, handle);
      return Object.freeze({ ...running, handle });
    } catch (error) {
      void handle.completion.catch(() => undefined);
      let compensation: LocalProcessStopResult;
      try {
        compensation = await this.controller.stop(handle.durableHandle);
      } catch {
        compensation = Object.freeze({
          status: 'unknown' as const,
          reason: 'signal_failed' as const,
        });
      }
      let snapshot: AggregateSnapshot = prepared;
      if (
        compensation.status === 'stopped' ||
        compensation.status === 'already_exited'
      ) {
        try {
          snapshot = await this.recordTerminal(
            prepared,
            'lost',
            'EXECUTION_ACTIVATION_PERSISTENCE_FAILED',
            'Durable process ownership could not be persisted',
          );
        } catch {
          snapshot = await this.loadLatest(prepared);
        }
      } else {
        snapshot = await this.loadLatest(prepared);
      }
      throw new LocalExecutionOwnershipPersistenceError(
        compensation,
        snapshot,
        error,
      );
    }
  }

  private async prepare(
    command: LocalExecutionStartCommand,
    callbackTokenHash: string,
  ): Promise<PreparedAggregate> {
    if (command.stepRunId !== undefined) {
      if (!this.workflowTasks) {
        throw new LocalExecutionRejectedError(
          'workflow_task_authority_unavailable',
        );
      }
      const observedAtMs = this.clock.now();
      assertSafeTimestamp(observedAtMs, 'Local execution clock');
      const deadlineAtMs =
        command.timeoutMs === undefined
          ? undefined
          : observedAtMs + command.timeoutMs;
      if (
        deadlineAtMs !== undefined &&
        (!Number.isSafeInteger(deadlineAtMs) ||
          deadlineAtMs <= observedAtMs)
      ) {
        throw new RangeError('Local execution deadline overflowed');
      }
      const result = await this.workflowTasks.prepare({
        runId: command.runId,
        attemptId: command.attemptId,
        stepRunId: command.stepRunId,
        callbackTokenHash,
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
        ...(command.output === undefined
          ? {}
          : { logArtifactId: command.output.logArtifactId }),
        atMs: observedAtMs,
        eventId: this.createEventId(),
      });
      if (result.status === 'rejected') {
        throw new LocalExecutionRejectedError(result.reason);
      }
      const current = await this.loadWorkflowTaskSnapshot(
        command.runId,
        command.attemptId,
        result.snapshot,
      );
      return Object.freeze({
        ...current,
        callbackSequence: current.attempt.callbackSequence + 1,
        callbackTokenHash,
      });
    }
    return this.repository.transaction(async (transaction) => {
      const [run, attempt, latest] = await Promise.all([
        transaction.findRunById(command.runId),
        transaction.findAttemptById(command.attemptId),
        transaction.findLatestAttemptByRunId(command.runId),
      ]);
      assertClaimedAggregate(run, attempt, latest);
      if (!attempt) throw new LocalExecutionRejectedError('attempt_not_found');
      const atMs = atOrAfter(this.clock.now(), run, attempt);
      const deadlineAtMs =
        command.timeoutMs === undefined ? undefined : atMs + command.timeoutMs;
      if (
        deadlineAtMs !== undefined &&
        (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= atMs)
      ) {
        throw new RangeError('Local execution deadline overflowed');
      }

      const dispatching = reserveEvent(run);
      const nextDispatching: RunRecord = {
        ...dispatching.run,
        status: 'dispatching',
      };
      if (!(await transaction.compareAndSetRun(nextDispatching, run.version))) {
        throw new LocalExecutionConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          run.id,
          attempt.id,
          {
            sequence: dispatching.sequence,
            type: 'run.dispatching',
            payload: Object.freeze({
              from_status: run.status,
              to_status: 'dispatching',
              version: nextDispatching.version,
            }),
          },
          `local-execution:run:${run.id}:${run.version}:dispatching`,
          'scheduler',
          'local-execution',
          atMs,
        ),
      );

      const starting = reserveEvent(nextDispatching);
      const nextStartingRun = starting.run;
      const nextAttempt: RunAttemptRecord = {
        ...attempt,
        status: 'starting',
        callbackTokenHash,
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
        ...(command.output === undefined
          ? {}
          : { logArtifactId: command.output.logArtifactId }),
      };
      if (
        !(await transaction.compareAndSetRun(
          nextStartingRun,
          nextDispatching.version,
        )) ||
        !(await transaction.compareAndSetAttempt(nextAttempt, {
          status: attempt.status,
          callbackSequence: attempt.callbackSequence,
        }))
      ) {
        throw new LocalExecutionConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          run.id,
          attempt.id,
          {
            sequence: starting.sequence,
            type: 'attempt.starting',
            payload: Object.freeze({
              attempt_id: attempt.id,
              from_status: attempt.status,
              to_status: 'starting',
              version: nextStartingRun.version,
              ...(deadlineAtMs === undefined
                ? {}
                : { deadline_at_ms: deadlineAtMs }),
            }),
          },
          `local-execution:attempt:${attempt.id}:${attempt.callbackSequence}:starting`,
          'worker',
          LOCAL_PROCESS_EXECUTOR_TYPE,
          atMs,
        ),
      );
      const callbackSequence = attempt.callbackSequence + 1;
      if (!Number.isSafeInteger(callbackSequence)) {
        throw new TypeError('Local execution callback sequence overflowed');
      }
      return Object.freeze({
        run: nextStartingRun,
        attempt: nextAttempt,
        callbackSequence,
        callbackTokenHash,
      });
    });
  }

  private async recordRunning(
    expected: PreparedAggregate,
    handle: LocalProcessLaunchHandle,
  ): Promise<AggregateSnapshot> {
    if (expected.attempt.stepRunId !== undefined) {
      if (!this.workflowTasks) {
        throw new LocalExecutionConcurrentWriteError();
      }
      const atMs = atOrAfter(
        handle.startedAtMs,
        expected.run,
        expected.attempt,
      );
      const result = await this.workflowTasks.recordRunning({
        run: expected.run,
        attempt: expected.attempt,
        callbackTokenHash: expected.callbackTokenHash,
        executorHandle: handle.durableHandle,
        pid: handle.pid,
        startedAtMs: atMs,
        attemptEventId: this.createEventId(),
        stepMutationId: this.createEventId(),
      });
      if (result.status === 'rejected') {
        throw new LocalExecutionConcurrentWriteError();
      }
      return this.loadWorkflowTaskSnapshot(
        expected.run.id,
        expected.attempt.id,
        result.snapshot,
      );
    }
    return this.repository.transaction(async (transaction) => {
      const current = await loadExact(
        transaction,
        expected.run.id,
        expected.attempt.id,
      );
      assertPreparedAggregate(current, expected);
      const atMs = atOrAfter(
        handle.startedAtMs,
        current.run,
        current.attempt,
      );
      const attemptRunning = reserveEvent(current.run);
      const nextAttempt: RunAttemptRecord = {
        ...current.attempt,
        status: 'running',
        executorHandle: handle.durableHandle,
        pid: handle.pid,
        startedAtMs: atMs,
      };
      if (
        !(await transaction.compareAndSetRun(
          attemptRunning.run,
          current.run.version,
        )) ||
        !(await transaction.compareAndSetAttempt(nextAttempt, {
          status: current.attempt.status,
          callbackSequence: current.attempt.callbackSequence,
        }))
      ) {
        throw new LocalExecutionConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          current.run.id,
          current.attempt.id,
          {
            sequence: attemptRunning.sequence,
            type: 'attempt.running',
            payload: Object.freeze({
              attempt_id: current.attempt.id,
              from_status: current.attempt.status,
              to_status: 'running',
              pid: handle.pid,
              version: attemptRunning.run.version,
            }),
          },
          `local-execution:attempt:${current.attempt.id}:${current.attempt.callbackSequence}:running`,
          'executor',
          LOCAL_PROCESS_EXECUTOR_TYPE,
          atMs,
        ),
      );

      const runRunning = reserveEvent(attemptRunning.run);
      const nextRun: RunRecord = {
        ...runRunning.run,
        status: 'running',
        startedAtMs: atMs,
      };
      if (
        !(await transaction.compareAndSetRun(
          nextRun,
          attemptRunning.run.version,
        ))
      ) {
        throw new LocalExecutionConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          current.run.id,
          current.attempt.id,
          {
            sequence: runRunning.sequence,
            type: 'run.running',
            payload: Object.freeze({
              from_status: current.run.status,
              to_status: 'running',
              version: nextRun.version,
            }),
          },
          `local-execution:run:${current.run.id}:${current.run.version}:running`,
          'executor',
          LOCAL_PROCESS_EXECUTOR_TYPE,
          atMs,
        ),
      );
      return Object.freeze({ run: nextRun, attempt: nextAttempt });
    });
  }

  private async recordTerminal(
    expected: PreparedAggregate,
    status: 'failed' | 'lost',
    errorCode: string,
    errorSummary: string,
  ): Promise<AggregateSnapshot> {
    if (expected.attempt.stepRunId !== undefined) {
      if (!this.workflowTasks) {
        throw new LocalExecutionConcurrentWriteError();
      }
      const atMs = atOrAfter(
        this.clock.now(),
        expected.run,
        expected.attempt,
      );
      const result = await this.workflowTasks.recordStartFailure({
        run: expected.run,
        attempt: expected.attempt,
        callbackTokenHash: expected.callbackTokenHash,
        status: 'failed',
        errorCode,
        errorSummary,
        finishedAtMs: atMs,
        attemptEventId: this.createEventId(),
        stepMutationId: this.createEventId(),
      });
      if (result.status === 'rejected') {
        throw new LocalExecutionConcurrentWriteError();
      }
      return this.loadWorkflowTaskSnapshot(
        expected.run.id,
        expected.attempt.id,
        result.snapshot,
      );
    }
    return this.repository.transaction(async (transaction) => {
      const current = await loadExact(
        transaction,
        expected.run.id,
        expected.attempt.id,
      );
      assertPreparedAggregate(current, expected);
      const atMs = atOrAfter(this.clock.now(), current.run, current.attempt);
      const attemptTerminal = reserveEvent(current.run);
      const nextAttempt: RunAttemptRecord = {
        ...current.attempt,
        status,
        finishedAtMs: atMs,
        errorCode,
        errorSummary,
      };
      if (
        !(await transaction.compareAndSetRun(
          attemptTerminal.run,
          current.run.version,
        )) ||
        !(await transaction.compareAndSetAttempt(nextAttempt, {
          status: current.attempt.status,
          callbackSequence: current.attempt.callbackSequence,
        }))
      ) {
        throw new LocalExecutionConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          current.run.id,
          current.attempt.id,
          {
            sequence: attemptTerminal.sequence,
            type: `attempt.${status}`,
            payload: Object.freeze({
              attempt_id: current.attempt.id,
              from_status: current.attempt.status,
              to_status: status,
              error_code: errorCode,
              version: attemptTerminal.run.version,
            }),
          },
          `local-execution:attempt:${current.attempt.id}:${current.attempt.callbackSequence}:${status}`,
          status === 'lost' ? 'reconciler' : 'executor',
          status === 'lost' ? 'local-execution' : LOCAL_PROCESS_EXECUTOR_TYPE,
          atMs,
        ),
      );

      const runTerminal = reserveEvent(attemptTerminal.run);
      const nextRun: RunRecord = {
        ...runTerminal.run,
        status,
        ...(status === 'failed' ? { finishedAtMs: atMs } : {}),
        errorCode,
        errorSummary,
      };
      if (
        !(await transaction.compareAndSetRun(
          nextRun,
          attemptTerminal.run.version,
        ))
      ) {
        throw new LocalExecutionConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          current.run.id,
          current.attempt.id,
          {
            sequence: runTerminal.sequence,
            type: `run.${status}`,
            payload: Object.freeze({
              from_status: current.run.status,
              to_status: status,
              error_code: errorCode,
              version: nextRun.version,
            }),
          },
          `local-execution:run:${current.run.id}:${current.run.version}:${status}`,
          status === 'lost' ? 'reconciler' : 'executor',
          status === 'lost' ? 'local-execution' : LOCAL_PROCESS_EXECUTOR_TYPE,
          atMs,
        ),
      );
      return Object.freeze({ run: nextRun, attempt: nextAttempt });
    });
  }

  private assertHandle(
    handle: LocalProcessLaunchHandle,
    expected: PreparedAggregate,
  ): void {
    const parsed =
      handle &&
      typeof handle === 'object' &&
      typeof handle.durableHandle === 'string'
        ? parseLocalProcessDurableHandle(handle.durableHandle)
        : null;
    if (
      !handle ||
      typeof handle !== 'object' ||
      !Number.isSafeInteger(handle.pid) ||
      handle.pid < 1 ||
      !Number.isSafeInteger(handle.startedAtMs) ||
      handle.startedAtMs < 0 ||
      typeof handle.handleId !== 'string' ||
      handle.handleId.length < 1 ||
      typeof handle.durableHandle !== 'string' ||
      handle.durableHandle.length < 1 ||
      typeof handle.completion?.then !== 'function' ||
      !parsed ||
      parsed.handleId !== handle.handleId ||
      parsed.identity.pid !== handle.pid ||
      expected.run.id !== expected.attempt.runId
    ) {
      throw new TypeError('Local process launcher returned an invalid handle');
    }
  }

  private async loadLatest(
    fallback: AggregateSnapshot,
  ): Promise<AggregateSnapshot> {
    const [run, attempt] = await Promise.all([
      this.repository.findRunById(fallback.run.id),
      this.repository.findAttemptById(fallback.attempt.id),
    ]);
    return Object.freeze({
      run: run ?? fallback.run,
      attempt: attempt ?? fallback.attempt,
    });
  }

  private async loadWorkflowTaskSnapshot(
    runId: string,
    attemptId: string,
    expected: Readonly<{
      runVersion: number;
      runEventSequence: number;
      attemptStatus: RunAttemptRecord['status'];
      callbackSequence: number;
    }>,
  ): Promise<AggregateSnapshot> {
    const [run, attempt] = await Promise.all([
      this.repository.findRunById(runId),
      this.repository.findAttemptById(attemptId),
    ]);
    if (
      !run ||
      !attempt ||
      attempt.runId !== run.id ||
      attempt.stepRunId === undefined ||
      run.version !== expected.runVersion ||
      run.eventSequence !== expected.runEventSequence ||
      attempt.status !== expected.attemptStatus ||
      attempt.callbackSequence !== expected.callbackSequence
    ) {
      throw new LocalExecutionConcurrentWriteError();
    }
    return Object.freeze({ run, attempt });
  }
}
