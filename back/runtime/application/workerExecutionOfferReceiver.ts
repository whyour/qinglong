import type { ExecutionHandle, ExecutionStopReason } from '../domain/execution';
import {
  WorkerExecutionOfferConflictError,
  assertClaimedExecutionOffer,
  assertSameWorkerExecutionOffer,
  cloneClaimedExecutionOffer,
  cloneWorkerExecutionOfferJournalRecord,
  createWorkerExecutionOfferJournalRecord,
  mergeWorkerExecutionOffer,
  workerExecutionHandleMetadata,
  type WorkerExecutionOfferJournalRecord,
} from '../domain/workerExecutionOffer';
import {
  RunDispatchLeaseFenceRejectedError,
  type RunDispatchLeaseRecord,
} from '../domain/runDispatchLease';
import type { ClaimedExecutionOffer } from '../domain/runDispatchOffer';
import type { WorkerRecord } from '../domain/worker';
import { createWorkerExecutionCompletionReceiptAuthentication } from '../domain/workerExecutionCompletionReceiptAuthentication';
import type { Executor } from '../ports/executor';
import type { WorkerExecutionContextFactory } from '../ports/workerExecutionContextFactory';
import type { WorkerExecutionOfferJournal } from '../ports/workerExecutionOfferJournal';
import type { WorkerRemoteRunActivationClient } from '../ports/workerRemoteRunActivationClient';
import type { WorkerRunLeaseTracker } from '../ports/workerRunLeaseTracker';
import type {
  RemoteRunActivationResult,
  RemoteRunLeaseFence,
} from './remoteRunActivationService';

export const MAX_WORKER_OFFER_ACTIVATION_RETRIES = 4;

export type WorkerExecutionOfferReceiveResult =
  | {
      status: 'running' | 'already_running';
      offerId: string;
      executorHandle: string;
    }
  | {
      status: 'start_failed' | 'already_failed';
      offerId: string;
    }
  | {
      status: 'already_completed';
      offerId: string;
    }
  | {
      status: 'recovery_required';
      offerId: string;
      reason:
        | 'launch_outcome_unknown'
        | 'control_plane_already_running'
        | 'control_plane_terminal'
        | 'lease_lost_local_execution_stopped'
        | 'lease_lost_local_execution_unverified';
    };

export interface WorkerExecutionOfferReceiverOptions {
  currentSession(): WorkerRecord | undefined;
  clock?: { now(): number };
  activationRetries?: number;
  acceptedExecutorTypes?: readonly string[];
}

export class WorkerExecutionOfferTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerExecutionOfferTargetError';
  }
}

export class WorkerExecutionOfferExpiredError extends Error {
  constructor(readonly offerId: string) {
    super(`Worker execution offer ${offerId} has expired`);
    this.name = 'WorkerExecutionOfferExpiredError';
  }
}

interface InFlightOffer {
  offer: ClaimedExecutionOffer;
  operation: Promise<WorkerExecutionOfferReceiveResult>;
}

function sameLeaseAuthority(
  left: RunDispatchLeaseRecord,
  right: RunDispatchLeaseRecord,
): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.runId === right.runId &&
    left.workerId === right.workerId &&
    left.workerSessionId === right.workerSessionId &&
    left.workerGeneration === right.workerGeneration &&
    left.leaseGeneration === right.leaseGeneration &&
    left.leaseToken === right.leaseToken
  );
}

/**
 * Transport-neutral Worker inbox. The transport must authenticate the control
 * plane before calling receive(); this service independently fences the target
 * Worker session and writes durable state before any process spawn.
 */
export class WorkerExecutionOfferReceiver {
  private readonly currentSessionProvider: WorkerExecutionOfferReceiverOptions['currentSession'];
  private readonly clock: { now(): number };
  private readonly activationRetries: number;
  private readonly acceptedExecutorTypes: ReadonlySet<string>;
  private readonly inFlight = new Map<string, InFlightOffer>();

  constructor(
    private readonly journal: WorkerExecutionOfferJournal,
    private readonly activation: WorkerRemoteRunActivationClient,
    private readonly executor: Executor,
    private readonly leaseTracker: WorkerRunLeaseTracker,
    private readonly contexts: WorkerExecutionContextFactory,
    options: WorkerExecutionOfferReceiverOptions,
  ) {
    this.currentSessionProvider = options.currentSession;
    this.clock = options.clock ?? Date;
    this.activationRetries = options.activationRetries ?? 2;
    if (
      !Number.isSafeInteger(this.activationRetries) ||
      this.activationRetries < 1 ||
      this.activationRetries > MAX_WORKER_OFFER_ACTIVATION_RETRIES
    ) {
      throw new RangeError(
        `activationRetries must be between 1 and ${MAX_WORKER_OFFER_ACTIVATION_RETRIES}`,
      );
    }
    const accepted = options.acceptedExecutorTypes ?? ['remote_worker'];
    if (
      accepted.length < 1 ||
      accepted.length > 16 ||
      new Set(accepted).size !== accepted.length ||
      accepted.some(
        (value) =>
          typeof value !== 'string' ||
          value.length < 1 ||
          value.length > 64 ||
          /[\u0000-\u001f\u007f]/.test(value),
      )
    ) {
      throw new TypeError('acceptedExecutorTypes is invalid');
    }
    this.acceptedExecutorTypes = new Set(accepted);
  }

  receive(
    delivered: ClaimedExecutionOffer,
  ): Promise<WorkerExecutionOfferReceiveResult> {
    assertClaimedExecutionOffer(delivered);
    const offer = cloneClaimedExecutionOffer(delivered);
    const active = this.inFlight.get(offer.offerId);
    if (active) {
      assertSameWorkerExecutionOffer(active.offer, offer);
      return active.operation;
    }
    const operation = this.process(offer).finally(() => {
      if (this.inFlight.get(offer.offerId)?.operation === operation) {
        this.inFlight.delete(offer.offerId);
      }
    });
    this.inFlight.set(offer.offerId, { offer, operation });
    return operation;
  }

  private async process(
    delivered: ClaimedExecutionOffer,
  ): Promise<WorkerExecutionOfferReceiveResult> {
    const persisted = await this.journal.read(delivered.offerId);
    if (persisted) {
      assertSameWorkerExecutionOffer(persisted.offer, delivered);
      if (persisted.state === 'completion_acknowledged') {
        return {
          status: 'already_completed',
          offerId: persisted.offer.offerId,
        };
      }
    }
    this.assertTarget(delivered);
    const initial = createWorkerExecutionOfferJournalRecord(
      delivered,
      this.now(),
    );
    await this.journal.create(initial);
    let record = await this.journal.read(delivered.offerId);
    if (!record) {
      throw new Error('Worker offer journal lost an entry after create');
    }
    assertSameWorkerExecutionOffer(record.offer, delivered);
    const merged = mergeWorkerExecutionOffer(record.offer, delivered);
    if (merged.lease.version !== record.offer.lease.version) {
      record = await this.replace(record, { offer: merged });
    }

    if (record.state === 'completion_acknowledged') {
      return { status: 'already_completed', offerId: record.offer.offerId };
    }
    if (record.state === 'running_acknowledged') {
      return {
        status: 'already_running',
        offerId: record.offer.offerId,
        executorHandle: record.executorHandle!,
      };
    }
    if (record.state === 'start_failure_acknowledged') {
      return { status: 'already_failed', offerId: record.offer.offerId };
    }
    if (record.state === 'recovery_required') {
      return {
        status: 'recovery_required',
        offerId: record.offer.offerId,
        reason: record.recoveryReason!,
      };
    }
    if (record.state === 'launching') {
      record = await this.replace(record, {
        state: 'recovery_required',
        recoveryReason: 'launch_outcome_unknown',
      });
      return this.recoveryResult(record);
    }

    if (record.state === 'accepted') {
      const starting = await this.activation.acknowledgeStarting(
        this.fence(record.offer),
      );
      if (starting.status === 'already_running') {
        record = await this.replace(record, {
          state: 'recovery_required',
          recoveryReason: 'control_plane_already_running',
        });
        return this.recoveryResult(record);
      }
      if (starting.status === 'already_terminal') {
        record = await this.replace(record, {
          state: 'recovery_required',
          recoveryReason: 'control_plane_terminal',
        });
        return this.recoveryResult(record);
      }
      record = await this.replace(record, {
        state: 'starting_acknowledged',
        offer: {
          ...record.offer,
          lease: { ...starting.lease },
        },
      });
    }

    if (record.state === 'start_failed') {
      return this.reportStartFailure(record, true);
    }

    if (record.state === 'starting_acknowledged') {
      const tracked = this.trackLatest(
        record.offer.lease,
        record.offer.offerId,
      );
      if (tracked.version !== record.offer.lease.version) {
        record = await this.replace(record, {
          offer: { ...record.offer, lease: tracked },
        });
      }
      let prepared;
      let receiptAuthentication;
      try {
        prepared = await this.contexts.prepare(
          cloneClaimedExecutionOffer(record.offer),
        );
        receiptAuthentication =
          createWorkerExecutionCompletionReceiptAuthentication(
            prepared.context.completionCallback,
          );
      } catch {
        record = await this.replace(record, { state: 'start_failed' });
        return this.reportStartFailure(record, false);
      }
      record = await this.replace(record, {
        state: 'launching',
        ...(receiptAuthentication === undefined
          ? {}
          : {
              completionReceiptCallbackSequence:
                receiptAuthentication.callbackSequence,
              completionReceiptTokenDigest: receiptAuthentication.tokenDigest,
            }),
      });
      let handle: ExecutionHandle;
      try {
        handle = await this.executor.start(
          record.offer.executionSpec,
          prepared.context,
        );
      } catch {
        record = await this.replace(record, { state: 'start_failed' });
        return this.reportStartFailure(record, false);
      }
      if (
        handle.runId !== record.offer.candidate.runId ||
        handle.attemptId !== record.offer.candidate.attemptId ||
        handle.executorType !== this.executor.type
      ) {
        await this.compensateInvalidHandle(handle);
        record = await this.replace(record, {
          state: 'recovery_required',
          recoveryReason: 'launch_outcome_unknown',
        });
        return this.recoveryResult(record);
      }
      const metadata = workerExecutionHandleMetadata(handle);
      record = await this.replace(record, {
        state: 'started',
        ...metadata,
        ...(prepared.logArtifactId === undefined
          ? {}
          : { logArtifactId: prepared.logArtifactId }),
      });
    }

    if (record.state !== 'started') {
      throw new WorkerExecutionOfferConflictError(record.offer.offerId);
    }
    const startedRecord = record;
    const running = await this.withCurrentLease(startedRecord, (lease) =>
      this.activation.acknowledgeRunning({
        ...this.fence({ ...startedRecord.offer, lease }),
        startedAtMs: startedRecord.executorStartedAtMs!,
        executorHandle: startedRecord.executorHandle!,
        ...(startedRecord.logArtifactId === undefined
          ? {}
          : { logArtifactId: startedRecord.logArtifactId }),
      }),
    );
    if (running.status === 'already_terminal') {
      record = await this.replace(startedRecord, {
        state: 'recovery_required',
        recoveryReason: 'control_plane_terminal',
      });
      return this.recoveryResult(record);
    }
    record = await this.replace(startedRecord, {
      state: 'running_acknowledged',
      offer: { ...record.offer, lease: { ...running.lease } },
    });
    return {
      status:
        running.status === 'already_running' ? 'already_running' : 'running',
      offerId: record.offer.offerId,
      executorHandle: record.executorHandle!,
    };
  }

  private async reportStartFailure(
    record: WorkerExecutionOfferJournalRecord,
    replay: boolean,
  ): Promise<WorkerExecutionOfferReceiveResult> {
    const failure = await this.withCurrentLease(record, (lease) =>
      this.activation.failStart(this.fence({ ...record.offer, lease })),
    );
    if (failure.status === 'already_running') {
      const recovery = await this.replace(record, {
        state: 'recovery_required',
        recoveryReason: 'control_plane_already_running',
      });
      return this.recoveryResult(recovery);
    }
    this.leaseTracker.untrack(record.offer.candidate.attemptId);
    await this.replace(record, { state: 'start_failure_acknowledged' });
    return {
      status: replay ? 'already_failed' : 'start_failed',
      offerId: record.offer.offerId,
    };
  }

  private async withCurrentLease(
    record: WorkerExecutionOfferJournalRecord,
    operation: (
      lease: RunDispatchLeaseRecord,
    ) => Promise<RemoteRunActivationResult>,
  ): Promise<RemoteRunActivationResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.activationRetries; attempt += 1) {
      const lease = this.trackLatest(record.offer.lease, record.offer.offerId);
      try {
        return await operation(lease);
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof RunDispatchLeaseFenceRejectedError) ||
          error.reason !== 'version_mismatch'
        ) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private trackLatest(
    lease: RunDispatchLeaseRecord,
    offerId: string,
  ): RunDispatchLeaseRecord {
    const current = this.leaseTracker
      .leases()
      .find((candidate) => candidate.attemptId === lease.attemptId);
    if (current && !sameLeaseAuthority(current, lease)) {
      throw new WorkerExecutionOfferConflictError(offerId);
    }
    const selected =
      current && current.version > lease.version ? current : lease;
    this.leaseTracker.track(selected);
    return { ...selected };
  }

  private fence(offer: ClaimedExecutionOffer): RemoteRunLeaseFence {
    const lease = offer.lease;
    return {
      runId: offer.candidate.runId,
      attemptId: offer.candidate.attemptId,
      workerId: lease.workerId,
      workerSessionId: lease.workerSessionId,
      workerGeneration: lease.workerGeneration,
      leaseGeneration: lease.leaseGeneration,
      leaseToken: lease.leaseToken,
      expectedLeaseVersion: lease.version,
      executorType: offer.candidate.executorType,
    };
  }

  private assertTarget(offer: ClaimedExecutionOffer): void {
    const nowMs = this.now();
    const session = this.currentSessionProvider();
    if (
      !session ||
      session.id !== offer.worker.id ||
      session.sessionId !== offer.worker.sessionId ||
      session.generation !== offer.worker.generation
    ) {
      throw new WorkerExecutionOfferTargetError(
        'Execution offer does not target the current Worker session',
      );
    }
    if (
      session.status === 'offline' ||
      (session.status === 'draining' && offer.deliveryKind === 'new_claim') ||
      session.leaseExpiresAtMs <= nowMs
    ) {
      throw new WorkerExecutionOfferTargetError(
        'Current Worker session cannot accept this execution offer',
      );
    }
    if (offer.lease.expiresAtMs <= nowMs) {
      throw new WorkerExecutionOfferExpiredError(offer.offerId);
    }
    if (
      !this.acceptedExecutorTypes.has(offer.candidate.executorType) ||
      !session.capabilities.executors.includes(offer.candidate.executorType)
    ) {
      throw new WorkerExecutionOfferTargetError(
        'Worker does not advertise the requested execution path',
      );
    }
  }

  private async replace(
    previous: WorkerExecutionOfferJournalRecord,
    patch: Partial<WorkerExecutionOfferJournalRecord>,
  ): Promise<WorkerExecutionOfferJournalRecord> {
    const updated = cloneWorkerExecutionOfferJournalRecord({
      ...previous,
      ...patch,
      schemaVersion: 1,
      revision: previous.revision + 1,
      updatedAtMs: Math.max(this.now(), previous.updatedAtMs),
    });
    await this.journal.replace(updated, previous.revision);
    return updated;
  }

  private recoveryResult(
    record: WorkerExecutionOfferJournalRecord,
  ): WorkerExecutionOfferReceiveResult {
    return {
      status: 'recovery_required',
      offerId: record.offer.offerId,
      reason: record.recoveryReason!,
    };
  }

  private async compensateInvalidHandle(
    handle: ExecutionHandle,
  ): Promise<void> {
    const reason: ExecutionStopReason = {
      kind: 'reconcile',
      requestedAtMs: this.now(),
    };
    await this.executor.stop(handle, reason).catch(() => undefined);
  }

  private now(): number {
    const nowMs = this.clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError(
        'Worker offer receiver clock returned an invalid time',
      );
    }
    return nowMs;
  }
}
