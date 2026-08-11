import { randomBytes } from 'crypto';
import type {
  ExecutionContext,
  ExecutionHandle,
  ExecutionResult,
  ExecutionSpec,
  ExecutionStopReason,
  ExecutionStopResult,
} from '../domain/execution';
import type { RunAttemptRecord, RunRecord } from '../domain/run';
import {
  assertAdmittedRunRetryPolicy,
  type RunRetryPolicyDefinition,
} from '../domain/runRetryPolicy';
import {
  MAX_LOG_ARTIFACT_ID_LENGTH,
  isTerminalRunAttemptStatus,
  isTerminalRunStatus,
} from '../domain/runStateMachine';
import type { Executor } from '../ports/executor';
import type { CompletionReceiptJournal } from '../ports/completionReceiptJournal';
import type { PrimaryRunIdempotencyLookup } from '../ports/primaryRunIdempotencyLookup';
import type { RunRepository } from '../ports/runRepository';
import type { RunRetryPolicyAdmission } from '../ports/runRetryPolicyAdmission';
import { DuplicateIdempotencyKeyError } from '../domain/repositoryErrors';
import {
  PrimaryRunCreator,
  type PrimaryRunDefinition,
  type PrimaryRunIdFactory,
  type PrimaryRunReference,
} from './primaryRunCreator';
import { RunCommandService } from './runCommandService';
import {
  hashPrimaryCompletionToken,
  PrimaryRunCompletionService,
} from './primaryRunCompletionService';

export interface PrimaryRunClock {
  now(): number;
}

export interface PrimaryRunOrchestratorOptions {
  clock?: PrimaryRunClock;
  createId?: PrimaryRunIdFactory;
  idempotencyLookup?: PrimaryRunIdempotencyLookup;
  createCallbackToken?: () => string;
  completionReceiptJournal?: Pick<CompletionReceiptJournal, 'register'>;
  retryPolicyAdmission?: RunRetryPolicyAdmission;
}

export interface PrimaryRunStartCommand {
  definition: Omit<PrimaryRunDefinition, 'acceptedAtMs' | 'retryPolicy'> & {
    acceptedAtMs?: number;
  };
  timeoutMs?: number;
  createSpec(reference: PrimaryRunReference): ExecutionSpec;
  context: ExecutionContext;
}

/**
 * Trusted local-dispatch input for an aggregate that already owns a claimed
 * Attempt. Callers must materialize the spec from the persisted Task revision.
 */
export interface PrimaryClaimedRunStartCommand {
  runId: string;
  attemptId: string;
  timeoutMs?: number;
  createSpec(reference: PrimaryRunReference): ExecutionSpec;
  context: ExecutionContext;
  logArtifactId?: string;
}

export interface PrimaryRunCompletion {
  run: RunRecord;
  attempt: RunAttemptRecord;
  result: ExecutionResult;
}

export interface ActivePrimaryRun extends PrimaryRunReference {
  handle: ExecutionHandle;
  completion: Promise<PrimaryRunCompletion>;
  cancel(reason: ExecutionStopReason): Promise<ExecutionStopResult>;
}

export class PrimaryRunLaunchError extends Error {
  constructor(
    message: string,
    readonly reference: PrimaryRunReference,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PrimaryRunLaunchError';
  }
}

export class PrimaryRunNotActiveError extends Error {
  constructor(readonly runId: string) {
    super(`Primary Run is not active: ${runId}`);
    this.name = 'PrimaryRunNotActiveError';
  }
}

export class PrimaryRunDuplicateRequestError extends Error {
  constructor(
    readonly projectId: string,
    readonly idempotencyKey: string,
    readonly existingRunId: string,
  ) {
    super('A Primary Run already exists for this idempotent request');
    this.name = 'PrimaryRunDuplicateRequestError';
  }
}

export class PrimaryRunIdempotencyUnavailableError extends Error {
  constructor() {
    super('Primary Run idempotency lookup is not configured');
    this.name = 'PrimaryRunIdempotencyUnavailableError';
  }
}

export class PrimaryRunRetryPolicyAuthorityError extends Error {
  readonly code = 'PRIMARY_RUN_RETRY_POLICY_AUTHORITY_REQUIRED';

  constructor() {
    super('Run requests cannot self-assert automatic retry safety');
    this.name = 'PrimaryRunRetryPolicyAuthorityError';
  }
}

export type PrimaryClaimedRunRejectionReason =
  | 'run_not_found'
  | 'attempt_not_found'
  | 'aggregate_mismatch'
  | 'not_latest_attempt'
  | 'not_queued'
  | 'not_claimed'
  | 'stale_execution_authority'
  | 'executor_mismatch'
  | 'cancellation_requested'
  | 'already_active';

export class PrimaryClaimedRunRejectedError extends Error {
  readonly code = 'PRIMARY_CLAIMED_RUN_REJECTED';

  constructor(readonly reason: PrimaryClaimedRunRejectionReason) {
    super(`Claimed Primary Run activation was rejected: ${reason}`);
    this.name = 'PrimaryClaimedRunRejectedError';
  }
}

interface ActiveExecution {
  handle: ExecutionHandle;
  completion: Promise<PrimaryRunCompletion>;
}

const ALREADY_EXITED_STOP_RESULT: ExecutionStopResult = {
  status: 'already_exited',
  termSignalSent: false,
  killSignalSent: false,
};

/**
 * Serializes durable Run transitions around a single Executor side effect.
 * It deliberately owns no scheduler or HTTP routing policy.
 */
export class PrimaryRunOrchestrator {
  private readonly clock: PrimaryRunClock;
  private readonly creator: PrimaryRunCreator;
  private readonly commands: RunCommandService;
  private readonly completions: PrimaryRunCompletionService;
  private readonly createCallbackToken: () => string;
  private readonly idempotencyLookup?: PrimaryRunIdempotencyLookup;
  private readonly completionReceiptJournal?: Pick<
    CompletionReceiptJournal,
    'register'
  >;
  private readonly retryPolicyAdmission?: RunRetryPolicyAdmission;
  private readonly active = new Map<string, ActiveExecution>();

  constructor(
    private readonly repository: RunRepository,
    private readonly executor: Executor,
    options: PrimaryRunOrchestratorOptions = {},
  ) {
    this.clock = options.clock ?? { now: Date.now };
    this.creator = new PrimaryRunCreator(repository, options.createId);
    this.commands = new RunCommandService(repository, options.createId);
    this.completions = new PrimaryRunCompletionService(
      repository,
      options.createId,
    );
    this.createCallbackToken =
      options.createCallbackToken ??
      (() => randomBytes(32).toString('base64url'));
    this.idempotencyLookup = options.idempotencyLookup;
    this.completionReceiptJournal = options.completionReceiptJournal;
    this.retryPolicyAdmission = options.retryPolicyAdmission;
  }

  async start(command: PrimaryRunStartCommand): Promise<ActivePrimaryRun> {
    this.assertTimeout(command.timeoutMs);
    if (
      Object.prototype.hasOwnProperty.call(command.definition, 'retryPolicy')
    ) {
      throw new PrimaryRunRetryPolicyAuthorityError();
    }
    const retryPolicy = await this.admitRetryPolicy(command.definition);
    const acceptedAtMs = command.definition.acceptedAtMs ?? this.clock.now();
    const reference = await this.createPrimaryRun(
      {
        ...command.definition,
        acceptedAtMs,
        ...(retryPolicy === undefined ? {} : { retryPolicy }),
      },
      this.executor.type,
    );
    return this.activateReference(reference, command);
  }

  async activateClaimed(
    command: PrimaryClaimedRunStartCommand,
  ): Promise<ActivePrimaryRun> {
    this.assertTimeout(command.timeoutMs);
    this.assertLogArtifactId(command.logArtifactId);
    const reference = await this.loadClaimedReference(
      command.runId,
      command.attemptId,
    );
    return this.activateReference(reference, command);
  }

  private async activateReference(
    initialReference: PrimaryRunReference,
    command: Pick<
      PrimaryClaimedRunStartCommand,
      'timeoutMs' | 'createSpec' | 'context' | 'logArtifactId'
    >,
  ): Promise<ActivePrimaryRun> {
    const callbackToken = this.createCallbackToken();
    const callbackTokenHash = hashPrimaryCompletionToken(callbackToken);
    const callbackSequence = initialReference.attempt.callbackSequence + 1;
    let reference = initialReference;

    reference = await this.prepareForSpawn(
      reference,
      command.timeoutMs,
      callbackTokenHash,
      command.logArtifactId,
    );

    let spec: ExecutionSpec;
    let handle: ExecutionHandle;
    try {
      await this.completionReceiptJournal?.register({
        runId: reference.run.id,
        attemptId: reference.attempt.id,
        registeredAtMs: reference.attempt.createdAtMs,
      });
      spec = command.createSpec(reference);
      this.assertSpecMatches(reference, spec, command.timeoutMs);
      handle = await this.executor.start(spec, {
        ...command.context,
        completionCallback: {
          token: callbackToken,
          callbackSequence,
        },
      });
    } catch (error) {
      reference = await this.recordStartFailure(reference);
      throw new PrimaryRunLaunchError(
        'Primary Run could not start its Executor',
        reference,
        { cause: error },
      );
    }

    try {
      this.assertHandleMatches(reference, handle);
      reference = await this.recordRunning(reference, handle);
    } catch (error) {
      void handle.completion.catch(() => undefined);
      await this.compensateActivationFailure(reference, handle);
      const latest = await this.loadReference(reference);
      throw new PrimaryRunLaunchError(
        'Primary Run could not persist Executor ownership',
        latest,
        { cause: error },
      );
    }

    const completion = handle.completion.then(
      (result) =>
        this.completions.complete({
          runId: reference.run.id,
          attemptId: reference.attempt.id,
          callbackSequence,
          result,
          source: { kind: 'executor', executorType: this.executor.type },
        }),
      () =>
        this.completions.complete({
          runId: reference.run.id,
          attemptId: reference.attempt.id,
          callbackSequence,
          result: {
            outcome: 'lost',
            startedAtMs: handle.startedAtMs,
            finishedAtMs: this.atOrAfter(handle.startedAtMs),
            errorCode: 'EXECUTOR_COMPLETION_REJECTED',
            errorSummary: 'Executor completion channel rejected',
          },
          source: { kind: 'executor', executorType: this.executor.type },
        }),
    );
    this.active.set(reference.run.id, { handle, completion });
    void completion.then(
      () => this.deleteActive(reference.run.id, handle),
      () => this.deleteActive(reference.run.id, handle),
    );

    return {
      ...reference,
      handle,
      completion,
      cancel: (reason) => this.cancel(reference.run.id, reason),
    };
  }

  private async loadClaimedReference(
    runId: string,
    attemptId: string,
  ): Promise<PrimaryRunReference> {
    const [run, attempt, latestAttempt] = await Promise.all([
      this.repository.findRunById(runId),
      this.repository.findAttemptById(attemptId),
      this.repository.findLatestAttemptByRunId(runId),
    ]);
    if (!run) throw new PrimaryClaimedRunRejectedError('run_not_found');
    if (!attempt) {
      throw new PrimaryClaimedRunRejectedError('attempt_not_found');
    }
    if (
      attempt.runId !== run.id ||
      run.executionOwner !== 'runtime' ||
      latestAttempt?.runId !== run.id
    ) {
      throw new PrimaryClaimedRunRejectedError('aggregate_mismatch');
    }
    if (latestAttempt.id !== attempt.id) {
      throw new PrimaryClaimedRunRejectedError('not_latest_attempt');
    }
    if (run.status !== 'queued') {
      throw new PrimaryClaimedRunRejectedError('not_queued');
    }
    if (attempt.status !== 'claimed') {
      throw new PrimaryClaimedRunRejectedError('not_claimed');
    }
    if (
      attempt.callbackSequence !== 0 ||
      attempt.callbackTokenHash !== undefined ||
      attempt.workerId !== undefined ||
      attempt.executorHandle !== undefined ||
      attempt.pid !== undefined ||
      attempt.logArtifactId !== undefined ||
      attempt.leaseToken !== undefined ||
      attempt.leaseExpiresAtMs !== undefined ||
      attempt.startedAtMs !== undefined ||
      attempt.finishedAtMs !== undefined ||
      attempt.exitCode !== undefined ||
      attempt.errorCode !== undefined ||
      attempt.errorSummary !== undefined
    ) {
      throw new PrimaryClaimedRunRejectedError('stale_execution_authority');
    }
    if (attempt.executorType !== this.executor.type) {
      throw new PrimaryClaimedRunRejectedError('executor_mismatch');
    }
    if (run.cancelRequestedAtMs !== undefined) {
      throw new PrimaryClaimedRunRejectedError('cancellation_requested');
    }
    if (this.active.has(run.id)) {
      throw new PrimaryClaimedRunRejectedError('already_active');
    }
    return { run, attempt };
  }

  private async admitRetryPolicy(
    definition: PrimaryRunStartCommand['definition'],
  ): Promise<RunRetryPolicyDefinition | undefined> {
    if (!this.retryPolicyAdmission) return undefined;
    const admitted = await this.retryPolicyAdmission.resolve(
      Object.freeze({
        projectId: definition.projectId,
        taskId: definition.taskId,
        taskRevision: definition.taskRevision,
        triggerType: definition.triggerType,
        executionOrigin: definition.executionOrigin,
      }),
    );
    if (admitted === undefined) return undefined;
    const policy: RunRetryPolicyDefinition = {
      maxAttempts: admitted.maxAttempts,
      retryOnLost: admitted.retryOnLost,
      safety: admitted.safety,
      backoffBaseMs: admitted.backoffBaseMs,
      backoffMaxMs: admitted.backoffMaxMs,
    };
    assertAdmittedRunRetryPolicy(policy);
    return policy;
  }

  async cancel(
    runId: string,
    reason: ExecutionStopReason,
  ): Promise<ExecutionStopResult> {
    const active = this.active.get(runId);
    if (!active) throw new PrimaryRunNotActiveError(runId);
    const request = await this.commands.requestCancellation({
      runId,
      attemptId: active.handle.attemptId,
      atMs: this.atOrAfter(reason.requestedAtMs, active.handle.startedAtMs),
      reason: reason.kind,
      actor: this.cancellationActor(reason),
    });
    if (request.status === 'already_terminal') {
      return ALREADY_EXITED_STOP_RESULT;
    }
    return this.executor.stop(active.handle, reason);
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  private async createPrimaryRun(
    definition: PrimaryRunDefinition,
    executorType: Executor['type'],
  ): Promise<PrimaryRunReference> {
    const key = definition.idempotencyKey;
    if (key === undefined) {
      return this.creator.create(definition, executorType);
    }
    if (!this.idempotencyLookup) {
      throw new PrimaryRunIdempotencyUnavailableError();
    }

    const existingRunId = await this.idempotencyLookup.findRunId(
      definition.projectId,
      key,
    );
    if (existingRunId) {
      throw new PrimaryRunDuplicateRequestError(
        definition.projectId,
        key,
        existingRunId,
      );
    }

    try {
      return await this.creator.create(definition, executorType);
    } catch (error) {
      if (!(error instanceof DuplicateIdempotencyKeyError)) throw error;
      const racedRunId = await this.idempotencyLookup.findRunId(
        definition.projectId,
        key,
      );
      if (!racedRunId) throw error;
      throw new PrimaryRunDuplicateRequestError(
        definition.projectId,
        key,
        racedRunId,
      );
    }
  }

  private async prepareForSpawn(
    reference: PrimaryRunReference,
    timeoutMs: number | undefined,
    callbackTokenHash: string,
    logArtifactId?: string,
  ): Promise<PrimaryRunReference> {
    const startingAtMs = this.atOrAfter(
      reference.run.createdAtMs,
      reference.attempt.createdAtMs,
    );
    const deadlineAtMs =
      timeoutMs === undefined ? undefined : startingAtMs + timeoutMs;
    if (deadlineAtMs !== undefined && !Number.isSafeInteger(deadlineAtMs)) {
      throw new RangeError('Primary Run deadline exceeds the supported range');
    }
    const dispatching = await this.commands.transitionRun({
      runId: reference.run.id,
      to: 'dispatching',
      expectedVersion: reference.run.version,
      atMs: startingAtMs,
      actor: { type: 'scheduler' },
    });
    const starting = await this.commands.transitionRunAttempt({
      runId: reference.run.id,
      attemptId: reference.attempt.id,
      to: 'starting',
      expectedRunVersion: dispatching.run.version,
      atMs: startingAtMs,
      ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
      callbackTokenHash,
      ...(logArtifactId === undefined ? {} : { logArtifactId }),
      actor: { type: 'worker', id: this.executor.type },
    });
    return { run: starting.run, attempt: starting.attempt };
  }

  private assertLogArtifactId(value: string | undefined): void {
    if (value === undefined) return;
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > MAX_LOG_ARTIFACT_ID_LENGTH ||
      !/^[A-Za-z0-9._:-]+$/.test(value)
    ) {
      throw new TypeError('Primary Run logArtifactId is invalid');
    }
  }

  private async recordRunning(
    reference: PrimaryRunReference,
    handle: ExecutionHandle,
  ): Promise<PrimaryRunReference> {
    const runningAttempt = await this.commands.transitionRunAttempt({
      runId: reference.run.id,
      attemptId: reference.attempt.id,
      to: 'running',
      expectedRunVersion: reference.run.version,
      atMs: this.atOrAfter(
        reference.run.createdAtMs,
        reference.attempt.createdAtMs,
        handle.startedAtMs,
      ),
      executorHandle: handle.durableHandle ?? handle.id,
      ...(handle.pid === undefined ? {} : { pid: handle.pid }),
      actor: { type: 'executor', id: this.executor.type },
    });
    const runningRun = await this.commands.transitionRun({
      runId: reference.run.id,
      to: 'running',
      expectedVersion: runningAttempt.run.version,
      atMs: this.atOrAfter(
        runningAttempt.run.createdAtMs,
        runningAttempt.attempt.startedAtMs,
      ),
      actor: { type: 'executor', id: this.executor.type },
    });
    return { run: runningRun.run, attempt: runningAttempt.attempt };
  }

  private async recordStartFailure(
    reference: PrimaryRunReference,
  ): Promise<PrimaryRunReference> {
    const atMs = this.atOrAfter(
      reference.run.createdAtMs,
      reference.attempt.createdAtMs,
    );
    const failedAttempt = await this.commands.transitionRunAttempt({
      runId: reference.run.id,
      attemptId: reference.attempt.id,
      to: 'failed',
      expectedRunVersion: reference.run.version,
      atMs,
      errorCode: 'EXECUTOR_START_FAILED',
      errorSummary: 'Executor failed before ownership was established',
      actor: { type: 'executor', id: this.executor.type },
    });
    const failedRun = await this.commands.transitionRun({
      runId: reference.run.id,
      to: 'failed',
      expectedVersion: failedAttempt.run.version,
      atMs,
      errorCode: 'EXECUTOR_START_FAILED',
      errorSummary: 'Executor failed before ownership was established',
      actor: { type: 'executor', id: this.executor.type },
    });
    return { run: failedRun.run, attempt: failedAttempt.attempt };
  }

  private async compensateActivationFailure(
    reference: PrimaryRunReference,
    handle: ExecutionHandle,
  ): Promise<void> {
    try {
      await this.executor.stop(handle, {
        kind: 'reconcile',
        requestedAtMs: this.atOrAfter(reference.run.createdAtMs),
      });
    } catch {
      // The durable state below remains lost when process ownership is unknown.
    }

    try {
      let latest = await this.loadReference(reference);
      const atMs = this.atOrAfter(
        latest.run.createdAtMs,
        latest.run.startedAtMs,
        latest.attempt.createdAtMs,
        latest.attempt.startedAtMs,
      );
      if (!isTerminalRunAttemptStatus(latest.attempt.status)) {
        const attempt = await this.commands.transitionRunAttempt({
          runId: latest.run.id,
          attemptId: latest.attempt.id,
          to: 'lost',
          expectedRunVersion: latest.run.version,
          atMs,
          errorCode: 'EXECUTION_ACTIVATION_PERSISTENCE_FAILED',
          errorSummary: 'Executor ownership could not be persisted',
          actor: { type: 'reconciler' },
        });
        latest = { run: attempt.run, attempt: attempt.attempt };
      }
      if (!isTerminalRunStatus(latest.run.status)) {
        await this.commands.transitionRun({
          runId: latest.run.id,
          to: 'lost',
          expectedVersion: latest.run.version,
          atMs,
          errorCode: 'EXECUTION_ACTIVATION_PERSISTENCE_FAILED',
          errorSummary: 'Executor ownership could not be persisted',
          actor: { type: 'reconciler' },
        });
      }
    } catch {
      // Original persistence failure is reported to the caller.
    }
  }

  private async loadReference(
    fallback: PrimaryRunReference,
  ): Promise<PrimaryRunReference> {
    const [run, attempt] = await Promise.all([
      this.repository.findRunById(fallback.run.id),
      this.repository.findAttemptById(fallback.attempt.id),
    ]);
    return {
      run: run ?? fallback.run,
      attempt: attempt ?? fallback.attempt,
    };
  }

  private assertSpecMatches(
    reference: PrimaryRunReference,
    spec: ExecutionSpec,
    timeoutMs?: number,
  ): void {
    if (
      spec.runId !== reference.run.id ||
      spec.attemptId !== reference.attempt.id ||
      spec.projectId !== reference.run.projectId ||
      spec.taskId !== reference.run.taskId ||
      spec.taskRevision !== reference.run.taskRevision ||
      spec.timeoutMs !== timeoutMs
    ) {
      throw new Error('ExecutionSpec does not match its persisted Primary Run');
    }
  }

  private assertTimeout(timeoutMs: number | undefined): void {
    if (
      timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    ) {
      throw new RangeError('Primary Run timeoutMs must be a positive integer');
    }
  }

  private assertHandleMatches(
    reference: PrimaryRunReference,
    handle: ExecutionHandle,
  ): void {
    if (
      handle.runId !== reference.run.id ||
      handle.attemptId !== reference.attempt.id ||
      handle.executorType !== this.executor.type
    ) {
      throw new Error(
        'Executor handle does not match its persisted Primary Run',
      );
    }
  }

  private atOrAfter(...timestamps: Array<number | undefined>): number {
    return Math.max(
      this.clock.now(),
      ...timestamps.filter((value): value is number => value !== undefined),
    );
  }

  private cancellationActor(reason: ExecutionStopReason): {
    type: 'user' | 'reconciler' | 'system';
  } {
    if (reason.kind === 'user') return { type: 'user' };
    if (reason.kind === 'reconcile') return { type: 'reconciler' };
    return { type: 'system' };
  }

  private deleteActive(runId: string, handle: ExecutionHandle): void {
    if (this.active.get(runId)?.handle === handle) this.active.delete(runId);
  }
}
