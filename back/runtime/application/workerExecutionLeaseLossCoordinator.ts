import type { ExecutionStopReason } from '../domain/execution';
import {
  cloneWorkerExecutionOfferJournalRecord,
  type WorkerExecutionOfferJournalRecord,
} from '../domain/workerExecutionOffer';
import { assertRunDispatchLeaseRecord } from '../domain/runDispatchLease';
import { createRunDispatchOfferId } from '../domain/runDispatchOffer';
import type { PersistedExecutionController } from '../ports/persistedExecutionController';
import type { WorkerExecutionOfferJournal } from '../ports/workerExecutionOfferJournal';
import type {
  WorkerRunLeaseLoss,
  WorkerRunLeaseLossReason,
} from './workerRunLeaseLifecycle';

export type WorkerExecutionLeaseLossActionStatus =
  | 'not_found'
  | 'authority_mismatch'
  | 'no_local_execution'
  | 'already_completed'
  | 'already_stopped'
  | 'already_unverified'
  | 'stop_acknowledged'
  | 'stop_unverified';

export interface WorkerExecutionLeaseLossActionResult {
  offerId: string;
  attemptId: string;
  reason: WorkerRunLeaseLossReason;
  status: WorkerExecutionLeaseLossActionStatus;
  stopStatus?: Awaited<
    ReturnType<PersistedExecutionController['stop']>
  >['status'];
}

const LOSS_REASONS = new Set<WorkerRunLeaseLossReason>([
  'lease_expired',
  'fenced',
  'worker_session_replaced',
  'worker_unavailable',
  'invalid_renewal',
]);

const EXECUTION_OWNERSHIP_STATES = new Set<
  WorkerExecutionOfferJournalRecord['state']
>(['launching', 'started', 'running_acknowledged', 'recovery_required']);

/**
 * Fails closed after a Worker loses a Run lease. It may stop only the durable
 * local identity bound to the exact lost authority and never mutates the
 * control plane. Server-owned lease expiry reconciliation decides Run/Attempt
 * lost and any later retry.
 */
export class WorkerExecutionLeaseLossCoordinator {
  private readonly clock: { now(): number };
  private readonly inFlight = new Map<
    string,
    Promise<WorkerExecutionLeaseLossActionResult>
  >();

  constructor(
    private readonly journal: Pick<
      WorkerExecutionOfferJournal,
      'read' | 'replace'
    >,
    private readonly controller: PersistedExecutionController,
    options: { clock?: { now(): number } } = {},
  ) {
    this.clock = options.clock ?? Date;
  }

  reconcile(
    candidate: WorkerRunLeaseLoss,
  ): Promise<WorkerExecutionLeaseLossActionResult> {
    assertRunDispatchLeaseRecord(candidate.lease);
    if (!LOSS_REASONS.has(candidate.reason)) {
      throw new TypeError('Worker Run lease loss reason is invalid');
    }
    const loss: WorkerRunLeaseLoss = {
      lease: { ...candidate.lease },
      reason: candidate.reason,
      ...(candidate.error === undefined ? {} : { error: candidate.error }),
    };
    const offerId = createRunDispatchOfferId(loss.lease);
    const active = this.inFlight.get(offerId);
    if (active) return active;
    const operation = this.process(offerId, loss).finally(() => {
      if (this.inFlight.get(offerId) === operation) {
        this.inFlight.delete(offerId);
      }
    });
    this.inFlight.set(offerId, operation);
    return operation;
  }

  private async process(
    offerId: string,
    loss: WorkerRunLeaseLoss,
  ): Promise<WorkerExecutionLeaseLossActionResult> {
    const base = {
      offerId,
      attemptId: loss.lease.attemptId,
      reason: loss.reason,
    } as const;
    const record = await this.journal.read(offerId);
    if (!record) return { ...base, status: 'not_found' };
    if (!this.sameAuthority(record, loss)) {
      return { ...base, status: 'authority_mismatch' };
    }
    if (record.state === 'completion_acknowledged') {
      return { ...base, status: 'already_completed' };
    }
    if (
      record.state === 'recovery_required' &&
      record.recoveryReason === 'lease_lost_local_execution_stopped'
    ) {
      return { ...base, status: 'already_stopped' };
    }
    if (
      record.state === 'recovery_required' &&
      record.recoveryReason === 'lease_lost_local_execution_unverified'
    ) {
      return { ...base, status: 'already_unverified' };
    }
    if (!EXECUTION_OWNERSHIP_STATES.has(record.state)) {
      return { ...base, status: 'no_local_execution' };
    }
    if (!record.executorHandle) {
      await this.mark(record, 'lease_lost_local_execution_unverified');
      return { ...base, status: 'stop_unverified' };
    }

    const reason: ExecutionStopReason = {
      kind: 'reconcile',
      requestedAtMs: this.now(),
    };
    const stopped = await this.controller.stop({
      durableHandle: record.executorHandle,
      reason,
    });
    const acknowledged =
      stopped.status === 'termination_requested' ||
      stopped.status === 'already_exited';
    const recoveryReason = acknowledged
      ? 'lease_lost_local_execution_stopped'
      : 'lease_lost_local_execution_unverified';
    await this.mark(record, recoveryReason);
    return {
      ...base,
      status: acknowledged ? 'stop_acknowledged' : 'stop_unverified',
      stopStatus: stopped.status,
    };
  }

  private sameAuthority(
    record: WorkerExecutionOfferJournalRecord,
    loss: WorkerRunLeaseLoss,
  ): boolean {
    const lease = record.offer.lease;
    return (
      lease.attemptId === loss.lease.attemptId &&
      lease.runId === loss.lease.runId &&
      lease.workerId === loss.lease.workerId &&
      lease.workerSessionId === loss.lease.workerSessionId &&
      lease.workerGeneration === loss.lease.workerGeneration &&
      lease.leaseGeneration === loss.lease.leaseGeneration &&
      lease.leaseToken === loss.lease.leaseToken
    );
  }

  private async mark(
    previous: WorkerExecutionOfferJournalRecord,
    recoveryReason:
      | 'lease_lost_local_execution_stopped'
      | 'lease_lost_local_execution_unverified',
  ): Promise<void> {
    const updated = cloneWorkerExecutionOfferJournalRecord({
      ...previous,
      schemaVersion: 1,
      revision: previous.revision + 1,
      state: 'recovery_required',
      recoveryReason,
      updatedAtMs: Math.max(this.now(), previous.updatedAtMs),
    });
    try {
      await this.journal.replace(updated, previous.revision);
    } catch (error) {
      const current = await this.journal.read(previous.offer.offerId);
      if (
        current?.state === 'completion_acknowledged' ||
        (current?.state === 'recovery_required' &&
          (current.recoveryReason ===
            'lease_lost_local_execution_stopped' ||
            current.recoveryReason ===
              'lease_lost_local_execution_unverified'))
      ) {
        return;
      }
      throw error;
    }
  }

  private now(): number {
    const nowMs = this.clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError(
        'Worker execution lease loss coordinator clock returned an invalid time',
      );
    }
    return nowMs;
  }
}
