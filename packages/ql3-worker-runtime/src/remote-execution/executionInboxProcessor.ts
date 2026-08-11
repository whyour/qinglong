// Remote Execution owns offer activation, launch barriers, and recovery processing.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AcknowledgeRemoteRunRunningCommand,
  AcknowledgeRemoteRunStartingCommand,
  FailRemoteRunStartCommand,
  RemoteRunActivationResult,
} from '@qinglong/runtime-core/remote-activation';
import type { ClusterRemoteExecutionOffer } from '@qinglong/runtime-core/remote-dispatch';
import { createClusterRemoteExecutionOffer } from '@qinglong/runtime-core/remote-dispatch';
import {
  normalizeWorkerRemoteExecutionInboxRecord,
  type WorkerRemoteExecutionInbox,
  type WorkerRemoteExecutionInboxRecord,
  type WorkerRemoteExecutionRecoveryReason,
} from './executionInbox';

export interface WorkerRemoteExecutionSession {
  readonly workerId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly status: 'available' | 'draining' | 'offline';
  readonly leaseExpiresAtMs: number;
}

export interface WorkerRemoteExecutionActivationClient {
  acknowledgeStarting(
    command: AcknowledgeRemoteRunStartingCommand,
  ): Promise<Readonly<RemoteRunActivationResult>>;
  acknowledgeRunning(
    command: AcknowledgeRemoteRunRunningCommand,
  ): Promise<Readonly<RemoteRunActivationResult>>;
  failStart(
    command: FailRemoteRunStartCommand,
  ): Promise<Readonly<RemoteRunActivationResult>>;
}

export interface WorkerRemoteExecutionCompletionCallback {
  readonly sequence: number;
  /** Ephemeral capability. Implementations must not persist or log it. */
  readonly token: Uint8Array;
}

export type WorkerRemoteExecutionOutputStream = 'stdout' | 'stderr';

export interface WorkerRemoteExecutionOutputChunk {
  readonly stream: WorkerRemoteExecutionOutputStream;
  readonly chunk: Uint8Array;
  readonly observedAtMs: number;
}

export interface WorkerRemoteExecutionOutputSink {
  readonly logArtifactId: string;
  write(output: WorkerRemoteExecutionOutputChunk): Promise<void>;
  /** Flushes accepted bytes and releases the writer. Must be idempotent. */
  close(): Promise<void>;
}

export interface MaterializedWorkerRemoteExecutionContext {
  readonly environment: readonly Readonly<{
    name: string;
    value: string;
  }>[];
  readonly logArtifactId: string;
  /** Transfers the prepared writer exactly once after the durable spawn barrier. */
  readonly takeOutput: () => WorkerRemoteExecutionOutputSink;
  readonly dispose?: () => Promise<void>;
}

export interface WorkerRemoteExecutionContextMaterializer {
  prepare(input: Readonly<{
    offer: ClusterRemoteExecutionOffer;
    completionCallback: WorkerRemoteExecutionCompletionCallback;
  }>): Promise<MaterializedWorkerRemoteExecutionContext>;
}

export interface WorkerRemoteExecutionLaunch {
  readonly offerId: string;
  readonly runId: string;
  readonly attemptId: string;
  /** Durable pre-spawn timestamp from the launching inbox barrier. */
  readonly executorStartedAtMs: number;
  readonly command: ClusterRemoteExecutionOffer['executionRevision']['command'];
  readonly environment: MaterializedWorkerRemoteExecutionContext['environment'];
  readonly workingDirectory?: string;
  readonly timeoutMs?: number;
  /** Durable database-clock timeout authority returned by starting ACK. */
  readonly executionDeadlineAtMs?: number;
  readonly logArtifactId: string;
  /**
   * Ownership transfers to the Executor when start() is called. The Executor
   * must close it on every known terminal path, including explicit rejection.
   */
  readonly output: WorkerRemoteExecutionOutputSink;
  readonly completionCallback: WorkerRemoteExecutionCompletionCallback;
}

export interface WorkerRemoteExecutionExecutor {
  /** A rejected result proves no execution started; a thrown error is unknown. */
  start(launch: WorkerRemoteExecutionLaunch): Promise<
    | Readonly<{
        status: 'started';
        executorHandle: string;
        executorStartedAtMs: number;
      }>
    | Readonly<{ status: 'rejected' }>
  >;
}

export type WorkerRemoteExecutionProcessResult = Readonly<{
  status:
    | 'running'
    | 'already_running'
    | 'start_failed'
    | 'already_failed'
    | 'already_completed'
    | 'recovery_required';
  offerId: string;
  executorHandle?: string;
  recoveryReason?: WorkerRemoteExecutionRecoveryReason;
}>;

export interface WorkerRemoteExecutionInboxProcessorOptions {
  readonly inbox: WorkerRemoteExecutionInbox;
  readonly activation: WorkerRemoteExecutionActivationClient;
  readonly materializer: WorkerRemoteExecutionContextMaterializer;
  readonly executor: WorkerRemoteExecutionExecutor;
  readonly currentSession: () => WorkerRemoteExecutionSession | undefined;
  readonly now?: () => number;
  readonly randomCapability?: () => Uint8Array;
  readonly eventId?: () => string;
}

export class WorkerRemoteExecutionProcessorError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'offer_missing'
      | 'target_fenced'
      | 'offer_expired'
      | 'activation_response_invalid'
      | 'materialized_context_invalid',
  ) {
    super(`Worker remote execution processor failed: ${reason}`);
    this.name = 'WorkerRemoteExecutionProcessorError';
  }
}

const SHA256 = /^[a-f0-9]{64}$/;

function safeTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerRemoteExecutionProcessorError('invalid_configuration');
  }
  return value;
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new WorkerRemoteExecutionProcessorError('materialized_context_invalid');
  }
  return value;
}

function validateEnvironment(
  offer: ClusterRemoteExecutionOffer,
  context: MaterializedWorkerRemoteExecutionContext,
): MaterializedWorkerRemoteExecutionContext['environment'] {
  if (!context || typeof context !== 'object' || !Array.isArray(context.environment)) {
    throw new WorkerRemoteExecutionProcessorError('materialized_context_invalid');
  }
  const expected = offer.executionRevision.environment;
  if (context.environment.length !== expected.length) {
    throw new WorkerRemoteExecutionProcessorError('materialized_context_invalid');
  }
  const values = new Map<string, string>();
  for (const entry of context.environment) {
    if (!entry || typeof entry !== 'object') {
      throw new WorkerRemoteExecutionProcessorError('materialized_context_invalid');
    }
    const name = boundedText(entry.name, 255);
    if (
      name.includes('=') ||
      typeof entry.value !== 'string' ||
      entry.value.includes('\0') ||
      values.has(name)
    ) {
      throw new WorkerRemoteExecutionProcessorError('materialized_context_invalid');
    }
    values.set(name, entry.value);
  }
  const normalized = expected.map((binding) => {
    const value = values.get(binding.name);
    if (
      value === undefined ||
      (binding.kind === 'public' && value !== binding.value)
    ) {
      throw new WorkerRemoteExecutionProcessorError('materialized_context_invalid');
    }
    return Object.freeze({ name: binding.name, value });
  });
  return Object.freeze(normalized);
}

async function validateOutput(
  context: MaterializedWorkerRemoteExecutionContext,
  logArtifactId: string,
): Promise<WorkerRemoteExecutionOutputSink> {
  if (typeof context.takeOutput !== 'function') {
    throw new WorkerRemoteExecutionProcessorError('materialized_context_invalid');
  }
  const output = context.takeOutput();
  if (
    !output ||
    typeof output !== 'object' ||
    output.logArtifactId !== logArtifactId ||
    typeof output.write !== 'function' ||
    typeof output.close !== 'function'
  ) {
    if (
      output &&
      typeof output === 'object' &&
      typeof (output as Partial<WorkerRemoteExecutionOutputSink>).close ===
        'function'
    ) {
      await Promise.resolve().then(() =>
        (output as WorkerRemoteExecutionOutputSink).close()
      ).catch(() => undefined);
    }
    throw new WorkerRemoteExecutionProcessorError('materialized_context_invalid');
  }
  return output;
}

export class WorkerRemoteExecutionInboxProcessor {
  private readonly inbox: WorkerRemoteExecutionInbox;
  private readonly activation: WorkerRemoteExecutionActivationClient;
  private readonly materializer: WorkerRemoteExecutionContextMaterializer;
  private readonly executor: WorkerRemoteExecutionExecutor;
  private readonly currentSessionProvider: () =>
    WorkerRemoteExecutionSession | undefined;
  private readonly nowProvider: () => number;
  private readonly randomCapabilityProvider: () => Uint8Array;
  private readonly eventIdProvider: () => string;
  private readonly inFlight = new Map<string, Promise<WorkerRemoteExecutionProcessResult>>();

  constructor(options: WorkerRemoteExecutionInboxProcessorOptions) {
    if (
      !options ||
      typeof options.inbox?.readOffer !== 'function' ||
      typeof options.inbox?.replaceOffer !== 'function' ||
      typeof options.activation?.acknowledgeStarting !== 'function' ||
      typeof options.activation?.acknowledgeRunning !== 'function' ||
      typeof options.activation?.failStart !== 'function' ||
      typeof options.materializer?.prepare !== 'function' ||
      typeof options.executor?.start !== 'function' ||
      typeof options.currentSession !== 'function'
    ) {
      throw new WorkerRemoteExecutionProcessorError('invalid_configuration');
    }
    this.inbox = options.inbox;
    this.activation = options.activation;
    this.materializer = options.materializer;
    this.executor = options.executor;
    this.currentSessionProvider = options.currentSession;
    this.nowProvider = options.now ?? Date.now;
    this.randomCapabilityProvider = options.randomCapability ??
      (() => randomBytes(32));
    this.eventIdProvider = options.eventId ?? randomUUID;
  }

  process(offerId: string): Promise<WorkerRemoteExecutionProcessResult> {
    const active = this.inFlight.get(offerId);
    if (active) return active;
    const operation = this.processOnce(offerId).finally(() => {
      if (this.inFlight.get(offerId) === operation) this.inFlight.delete(offerId);
    });
    this.inFlight.set(offerId, operation);
    return operation;
  }

  private async processOnce(
    offerId: string,
  ): Promise<WorkerRemoteExecutionProcessResult> {
    let record = await this.inbox.readOffer(offerId);
    if (!record) {
      throw new WorkerRemoteExecutionProcessorError('offer_missing');
    }
    record = normalizeWorkerRemoteExecutionInboxRecord(record);
    if (record.state === 'completion_acknowledged') {
      return Object.freeze({ status: 'already_completed', offerId });
    }
    if (record.state === 'running_acknowledged') {
      return Object.freeze({
        status: 'already_running',
        offerId,
        executorHandle: record.executorHandle,
      });
    }
    if (record.state === 'start_failure_acknowledged') {
      return Object.freeze({ status: 'already_failed', offerId });
    }
    if (record.state === 'recovery_required') return this.recoveryResult(record);
    this.assertCurrentTarget(record.offer);

    if (record.state === 'launching') {
      record = await this.recover(record, 'launch_outcome_unknown');
      return this.recoveryResult(record);
    }
    if (record.state === 'accepted') {
      const starting = await this.activation.acknowledgeStarting({
        ...this.fence(record.offer),
        eventId: this.eventId(),
      });
      this.assertActivation(record.offer, starting);
      if (starting.status === 'already_running') {
        record = await this.recover(record, 'control_plane_already_running');
        return this.recoveryResult(record);
      }
      if (starting.status === 'already_terminal') {
        record = await this.recover(record, 'control_plane_terminal');
        return this.recoveryResult(record);
      }
      record = await this.replace(record, { state: 'starting_acknowledged' });
    }
    if (record.state === 'start_failed') {
      return this.reportStartFailure(record);
    }
    if (record.state === 'starting_acknowledged') {
      record = await this.launch(record);
      if (record.state === 'start_failed') return this.reportStartFailure(record);
      if (record.state === 'recovery_required') return this.recoveryResult(record);
    }
    if (record.state !== 'started') {
      throw new WorkerRemoteExecutionProcessorError('activation_response_invalid');
    }
    const running = await this.activation.acknowledgeRunning({
      ...this.fence(record.offer),
      attemptEventId: this.eventId(),
      runEventId: this.eventId(),
      executorHandle: record.executorHandle!,
      ...(record.logArtifactId === undefined
        ? {}
        : { logArtifactId: record.logArtifactId }),
      callbackSequence: record.completionReceiptCallbackSequence!,
      callbackTokenDigest: record.completionReceiptTokenDigest!,
    });
    this.assertActivation(record.offer, running);
    if (running.status === 'already_terminal') {
      record = await this.recover(record, 'control_plane_terminal');
      return this.recoveryResult(record);
    }
    if (
      running.status !== 'applied' &&
      running.status !== 'already_running'
    ) {
      throw new WorkerRemoteExecutionProcessorError('activation_response_invalid');
    }
    record = await this.replace(record, { state: 'running_acknowledged' });
    return Object.freeze({
      status: running.status === 'already_running' ? 'already_running' : 'running',
      offerId,
      executorHandle: record.executorHandle,
    });
  }

  private async launch(
    record: WorkerRemoteExecutionInboxRecord,
  ): Promise<WorkerRemoteExecutionInboxRecord> {
    const callback = await this.nextCallbackAuthority(record.offer);
    const callbackSequence = callback.sequence;
    const token = Buffer.from(this.randomCapabilityProvider());
    if (token.byteLength !== 32) {
      token.fill(0);
      throw new WorkerRemoteExecutionProcessorError('invalid_configuration');
    }
    const tokenDigest = createHash('sha256').update(token).digest('hex');
    let context: MaterializedWorkerRemoteExecutionContext | undefined;
    try {
      try {
        context = await this.materializer.prepare({
          offer: createClusterRemoteExecutionOffer(record.offer),
          completionCallback: Object.freeze({
            sequence: callbackSequence,
            token,
          }),
        });
      } catch {
        return await this.replace(record, { state: 'start_failed' });
      }
      let environment: MaterializedWorkerRemoteExecutionContext['environment'];
      let logArtifactId: string;
      try {
        environment = validateEnvironment(record.offer, context);
        logArtifactId = boundedText(context.logArtifactId, 36);
        if (typeof context.takeOutput !== 'function') {
          throw new WorkerRemoteExecutionProcessorError(
            'materialized_context_invalid',
          );
        }
      } catch {
        return await this.replace(record, { state: 'start_failed' });
      }
      record = await this.replace(record, {
        state: 'launching',
        executorStartedAtMs: this.now(),
        logArtifactId,
        completionReceiptCallbackSequence: callbackSequence,
        completionReceiptTokenDigest: tokenDigest,
      });
      let output: WorkerRemoteExecutionOutputSink;
      try {
        output = await validateOutput(context, logArtifactId);
      } catch {
        return await this.replace(record, { state: 'start_failed' });
      }
      let outcome: Awaited<ReturnType<WorkerRemoteExecutionExecutor['start']>>;
      try {
        outcome = await this.executor.start(Object.freeze({
          offerId: record.offer.offerId,
          runId: record.offer.candidate.runId,
          attemptId: record.offer.candidate.attemptId,
          executorStartedAtMs: record.executorStartedAtMs!,
          command: record.offer.executionRevision.command,
          environment,
          ...(record.offer.executionRevision.workingDirectory === undefined
            ? {}
            : { workingDirectory: record.offer.executionRevision.workingDirectory }),
          ...(record.offer.executionRevision.timeoutMs === undefined
            ? {}
            : {
                timeoutMs: record.offer.executionRevision.timeoutMs,
                executionDeadlineAtMs: callback.deadlineAtMs,
              }),
          logArtifactId,
          output,
          completionCallback: Object.freeze({
            sequence: callbackSequence,
            token,
          }),
        }));
      } catch {
        return await this.recover(record, 'launch_outcome_unknown');
      }
      if (outcome?.status === 'rejected') {
        await output.close().catch(() => undefined);
        return await this.replace(record, { state: 'start_failed' });
      }
      if (outcome?.status !== 'started') {
        return await this.recover(record, 'launch_outcome_unknown');
      }
      let executorHandle: string;
      let executorStartedAtMs: number;
      try {
        executorHandle = boundedText(outcome.executorHandle, 512);
        executorStartedAtMs = outcome.executorStartedAtMs;
        if (
          !Number.isSafeInteger(executorStartedAtMs) ||
          executorStartedAtMs < 0 ||
          executorStartedAtMs > this.now() ||
          executorStartedAtMs !== record.executorStartedAtMs
        ) {
          throw new WorkerRemoteExecutionProcessorError(
            'materialized_context_invalid',
          );
        }
      } catch {
        return await this.recover(record, 'launch_outcome_unknown');
      }
      try {
        return await this.replace(record, {
          state: 'started',
          executorHandle,
          logArtifactId,
        });
      } catch {
        return await this.recover(record, 'launch_outcome_unknown');
      }
    } finally {
      token.fill(0);
      await context?.dispose?.().catch(() => undefined);
    }
  }

  private async nextCallbackAuthority(
    offer: ClusterRemoteExecutionOffer,
  ): Promise<Readonly<{ sequence: number; deadlineAtMs?: number }>> {
    const replay = await this.activation.acknowledgeStarting({
      ...this.fence(offer),
      eventId: this.eventId(),
    });
    this.assertActivation(offer, replay);
    if (
      replay.status !== 'already_starting' &&
      replay.status !== 'applied'
    ) {
      throw new WorkerRemoteExecutionProcessorError('activation_response_invalid');
    }
    const sequence = replay.snapshot.callbackSequence + 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 2_147_483_647) {
      throw new WorkerRemoteExecutionProcessorError('activation_response_invalid');
    }
    return Object.freeze({
      sequence,
      ...(replay.snapshot.deadlineAtMs === undefined
        ? {}
        : { deadlineAtMs: replay.snapshot.deadlineAtMs }),
    });
  }

  private async reportStartFailure(
    record: WorkerRemoteExecutionInboxRecord,
  ): Promise<WorkerRemoteExecutionProcessResult> {
    const result = await this.activation.failStart({
      ...this.fence(record.offer),
      attemptEventId: this.eventId(),
      runEventId: this.eventId(),
    });
    this.assertActivation(record.offer, result, true);
    if (result.status === 'already_running') {
      const recovery = await this.recover(
        record,
        'control_plane_already_running',
      );
      return this.recoveryResult(recovery);
    }
    if (result.status !== 'applied' && result.status !== 'already_terminal') {
      throw new WorkerRemoteExecutionProcessorError('activation_response_invalid');
    }
    await this.replace(record, { state: 'start_failure_acknowledged' });
    return Object.freeze({ status: 'start_failed', offerId: record.offer.offerId });
  }

  private assertCurrentTarget(offer: ClusterRemoteExecutionOffer): void {
    const current = this.currentSessionProvider();
    const now = this.now();
    if (
      !current ||
      current.workerId !== offer.worker.workerId ||
      current.sessionId !== offer.worker.sessionId ||
      current.generation !== offer.worker.generation ||
      current.status === 'offline' ||
      (current.status === 'draining' && offer.deliveryKind === 'new_claim') ||
      current.leaseExpiresAtMs <= now
    ) {
      throw new WorkerRemoteExecutionProcessorError('target_fenced');
    }
    if (offer.lease.expiresAtMs <= now) {
      throw new WorkerRemoteExecutionProcessorError('offer_expired');
    }
  }

  private assertActivation(
    offer: ClusterRemoteExecutionOffer,
    result: Readonly<RemoteRunActivationResult>,
    allowCompletedLease = false,
  ): void {
    const snapshot = result?.snapshot;
    if (
      !['applied', 'already_starting', 'already_running', 'already_terminal']
        .includes(result?.status) ||
      !snapshot ||
      snapshot.runId !== offer.candidate.runId ||
      snapshot.attemptId !== offer.candidate.attemptId ||
      snapshot.leaseGeneration !== offer.lease.leaseGeneration ||
      !Number.isSafeInteger(snapshot.leaseVersion) ||
      snapshot.leaseVersion < offer.lease.version ||
      snapshot.leaseVersion > offer.lease.version + (allowCompletedLease ? 1 : 0) ||
      !Number.isSafeInteger(snapshot.callbackSequence) ||
      snapshot.callbackSequence < 0 ||
      snapshot.callbackSequence > 2_147_483_647
      || (offer.executionRevision.timeoutMs === undefined) !==
        (snapshot.deadlineAtMs === undefined)
      || (snapshot.deadlineAtMs !== undefined &&
        (!Number.isSafeInteger(snapshot.deadlineAtMs) ||
          snapshot.deadlineAtMs < 0))
    ) {
      throw new WorkerRemoteExecutionProcessorError('activation_response_invalid');
    }
  }

  private fence(offer: ClusterRemoteExecutionOffer) {
    return Object.freeze({
      runId: offer.candidate.runId,
      attemptId: offer.candidate.attemptId,
      workerId: offer.worker.workerId,
      workerSessionId: offer.worker.sessionId,
      workerGeneration: offer.worker.generation,
      offerId: offer.offerId,
      leaseGeneration: offer.lease.leaseGeneration,
      leaseToken: offer.leaseToken,
      expectedLeaseVersion: offer.lease.version,
    });
  }

  private async replace(
    previous: WorkerRemoteExecutionInboxRecord,
    patch: Partial<WorkerRemoteExecutionInboxRecord>,
  ): Promise<WorkerRemoteExecutionInboxRecord> {
    const next = normalizeWorkerRemoteExecutionInboxRecord({
      ...previous,
      ...patch,
      schemaVersion: 1,
      revision: previous.revision + 1,
      updatedAtMs: Math.max(this.now(), previous.updatedAtMs),
    });
    await this.inbox.replaceOffer(next, previous.revision);
    return next;
  }

  private recover(
    record: WorkerRemoteExecutionInboxRecord,
    recoveryReason: WorkerRemoteExecutionRecoveryReason,
  ): Promise<WorkerRemoteExecutionInboxRecord> {
    return this.replace(record, { state: 'recovery_required', recoveryReason });
  }

  private recoveryResult(
    record: WorkerRemoteExecutionInboxRecord,
  ): WorkerRemoteExecutionProcessResult {
    return Object.freeze({
      status: 'recovery_required',
      offerId: record.offer.offerId,
      recoveryReason: record.recoveryReason,
    });
  }

  private eventId(): string {
    const value = this.eventIdProvider();
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 36 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new WorkerRemoteExecutionProcessorError('invalid_configuration');
    }
    return value;
  }

  private now(): number {
    return safeTime(this.nowProvider());
  }
}
