import {
  cloneWorkerExecutionOfferJournalRecord,
  type WorkerExecutionOfferJournalRecord,
} from '../domain/workerExecutionOffer';
import type { WorkerRecord } from '../domain/worker';
import type { CompletionReceiptStore } from '../ports/completionReceiptStore';
import type { WorkerExecutionOfferJournal } from '../ports/workerExecutionOfferJournal';
import type { WorkerRemoteRunActivationClient } from '../ports/workerRemoteRunActivationClient';
import type { WorkerRemoteRunCompletionClient } from '../ports/workerRemoteRunCompletionClient';
import type { WorkerExecutionOfferRecoveryResult } from './workerExecutionOfferRecoveryReconciler';
import { WorkerExecutionOfferRecoveryReconciler } from './workerExecutionOfferRecoveryReconciler';

export type WorkerExecutionOfferRecoveryActionStatus =
  | 'not_found'
  | 'session_unavailable'
  | 'deferred'
  | 'running_acknowledged'
  | 'already_running'
  | 'control_plane_terminal'
  | 'completion_acknowledged'
  | 'already_completed';

export type WorkerCompletionReceiptCleanup =
  | 'removed'
  | 'already_absent'
  | 'pending';

export interface WorkerExecutionOfferRecoveryActionResult {
  offerId: string;
  status: WorkerExecutionOfferRecoveryActionStatus;
  evidence?: WorkerExecutionOfferRecoveryResult;
  receiptCleanup?: WorkerCompletionReceiptCleanup;
}

export interface WorkerExecutionOfferRecoveryCoordinatorOptions {
  currentSession(): WorkerRecord | undefined;
  clock?: { now(): number };
}

/**
 * Applies only evidence-backed recovery mutations. Control-plane completion is
 * durable before the local journal becomes terminal; the receipt is removed
 * only after that terminal journal write succeeds.
 */
export class WorkerExecutionOfferRecoveryCoordinator {
  private readonly currentSessionProvider: WorkerExecutionOfferRecoveryCoordinatorOptions['currentSession'];
  private readonly clock: { now(): number };
  private readonly inFlight = new Map<
    string,
    Promise<WorkerExecutionOfferRecoveryActionResult>
  >();

  constructor(
    private readonly journal: Pick<
      WorkerExecutionOfferJournal,
      'read' | 'replace'
    >,
    private readonly reconciler: WorkerExecutionOfferRecoveryReconciler,
    private readonly completion: WorkerRemoteRunCompletionClient,
    private readonly activation: Pick<
      WorkerRemoteRunActivationClient,
      'acknowledgeRunning'
    >,
    private readonly receipts: Pick<CompletionReceiptStore, 'remove'>,
    options: WorkerExecutionOfferRecoveryCoordinatorOptions,
  ) {
    this.currentSessionProvider = options.currentSession;
    this.clock = options.clock ?? Date;
  }

  recover(offerId: string): Promise<WorkerExecutionOfferRecoveryActionResult> {
    const active = this.inFlight.get(offerId);
    if (active) return active;
    const operation = this.process(offerId).finally(() => {
      if (this.inFlight.get(offerId) === operation) {
        this.inFlight.delete(offerId);
      }
    });
    this.inFlight.set(offerId, operation);
    return operation;
  }

  private async process(
    offerId: string,
  ): Promise<WorkerExecutionOfferRecoveryActionResult> {
    let record = await this.journal.read(offerId);
    if (!record) return { offerId, status: 'not_found' };
    if (record.state === 'completion_acknowledged') {
      return {
        offerId,
        status: 'already_completed',
        receiptCleanup: await this.cleanupReceipt(
          record.offer.candidate.attemptId,
        ),
      };
    }

    const currentSession = this.currentSessionProvider();
    if (!currentSession) return { offerId, status: 'session_unavailable' };
    const evidence = await this.reconciler.reconcile(record, currentSession);

    if (
      evidence.finding === 'completion_observed' &&
      evidence.completionSubmission === 'ready' &&
      evidence.completion
    ) {
      await this.completion.complete({
        runId: record.offer.candidate.runId,
        attemptId: record.offer.candidate.attemptId,
        callbackSequence: evidence.completion.callbackSequence,
        result: {
          outcome: evidence.completion.outcome,
          startedAtMs: evidence.completion.startedAtMs,
          finishedAtMs: evidence.completion.finishedAtMs,
          exitCode: evidence.completion.exitCode,
        },
        executorType: record.offer.candidate.executorType,
        workerId: record.offer.lease.workerId,
        workerSessionId: record.offer.lease.workerSessionId,
        workerGeneration: record.offer.lease.workerGeneration,
        leaseGeneration: record.offer.lease.leaseGeneration,
        leaseToken: record.offer.lease.leaseToken,
        expectedLeaseVersion: record.offer.lease.version,
      });
      record = await this.markCompletionAcknowledged(record);
      return {
        offerId,
        status: 'completion_acknowledged',
        evidence,
        receiptCleanup: await this.cleanupReceipt(
          record.offer.candidate.attemptId,
        ),
      };
    }

    if (
      evidence.finding === 'execution_running' &&
      evidence.authority === 'current' &&
      record.state === 'started'
    ) {
      const lease = record.offer.lease;
      const activated = await this.activation.acknowledgeRunning({
        runId: record.offer.candidate.runId,
        attemptId: record.offer.candidate.attemptId,
        workerId: lease.workerId,
        workerSessionId: lease.workerSessionId,
        workerGeneration: lease.workerGeneration,
        leaseGeneration: lease.leaseGeneration,
        leaseToken: lease.leaseToken,
        expectedLeaseVersion: lease.version,
        executorType: record.offer.candidate.executorType,
        startedAtMs: record.executorStartedAtMs!,
        executorHandle: record.executorHandle!,
        ...(record.logArtifactId === undefined
          ? {}
          : { logArtifactId: record.logArtifactId }),
      });
      if (activated.status === 'already_terminal') {
        await this.replace(record, {
          state: 'recovery_required',
          recoveryReason: 'control_plane_terminal',
        });
        return { offerId, status: 'control_plane_terminal', evidence };
      }
      await this.replace(record, {
        state: 'running_acknowledged',
        offer: { ...record.offer, lease: { ...activated.lease } },
      });
      return {
        offerId,
        status:
          activated.status === 'already_running'
            ? 'already_running'
            : 'running_acknowledged',
        evidence,
      };
    }

    if (
      evidence.finding === 'execution_running' &&
      evidence.authority === 'current' &&
      record.state === 'running_acknowledged'
    ) {
      return { offerId, status: 'already_running', evidence };
    }
    return { offerId, status: 'deferred', evidence };
  }

  private async markCompletionAcknowledged(
    record: WorkerExecutionOfferJournalRecord,
  ): Promise<WorkerExecutionOfferJournalRecord> {
    try {
      return await this.replace(record, {
        state: 'completion_acknowledged',
        recoveryReason: undefined,
      });
    } catch (error) {
      const current = await this.journal.read(record.offer.offerId);
      if (current?.state === 'completion_acknowledged') return current;
      throw error;
    }
  }

  private async replace(
    previous: WorkerExecutionOfferJournalRecord,
    patch: Partial<WorkerExecutionOfferJournalRecord>,
  ): Promise<WorkerExecutionOfferJournalRecord> {
    const updatedAtMs = Math.max(this.now(), previous.updatedAtMs);
    const updated = cloneWorkerExecutionOfferJournalRecord({
      ...previous,
      ...patch,
      schemaVersion: 1,
      revision: previous.revision + 1,
      updatedAtMs,
      ...(patch.state === 'completion_acknowledged'
        ? { completionAcknowledgedAtMs: updatedAtMs }
        : {}),
    });
    await this.journal.replace(updated, previous.revision);
    return updated;
  }

  private async cleanupReceipt(
    attemptId: string,
  ): Promise<WorkerCompletionReceiptCleanup> {
    try {
      return (await this.receipts.remove(attemptId))
        ? 'removed'
        : 'already_absent';
    } catch {
      return 'pending';
    }
  }

  private now(): number {
    const nowMs = this.clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError(
        'Worker offer recovery coordinator clock returned an invalid time',
      );
    }
    return nowMs;
  }
}
