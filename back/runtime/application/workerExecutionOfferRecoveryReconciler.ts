import type { CompletionReceipt } from '../domain/completionReceipt';
import type { WorkerRecord } from '../domain/worker';
import {
  cloneWorkerExecutionOfferJournalRecord,
  type WorkerExecutionOfferJournalRecord,
} from '../domain/workerExecutionOffer';
import type { CompletionReceiptStore } from '../ports/completionReceiptStore';
import type { PersistedExecutionInspector } from '../ports/persistedExecutionInspector';
import type { WorkerExecutionCompletionReceiptAuthenticator } from '../ports/workerExecutionCompletionReceiptAuthenticator';

export type WorkerExecutionRecoveryAuthority =
  | 'current'
  | 'session_fenced'
  | 'worker_offline'
  | 'worker_session_expired'
  | 'run_lease_expired';

export type WorkerExecutionRecoveryFinding =
  | 'no_execution_expected'
  | 'completion_observed'
  | 'completion_receipt_conflict'
  | 'completion_receipt_unavailable'
  | 'execution_running'
  | 'execution_exited_without_receipt'
  | 'launch_outcome_unknown'
  | 'execution_identity_mismatch'
  | 'execution_handle_invalid'
  | 'execution_probe_unsupported'
  | 'execution_probe_unavailable';

export type WorkerExecutionCompletionSubmission =
  | 'ready'
  | 'blocked_session_fenced'
  | 'blocked_worker_offline'
  | 'blocked_worker_session_expired'
  | 'blocked_run_lease_expired'
  | 'blocked_control_plane_terminal';

export interface WorkerExecutionRecoveredCompletion {
  callbackSequence: number;
  outcome: 'succeeded' | 'failed';
  startedAtMs: number;
  finishedAtMs: number;
  exitCode: number;
}

export interface WorkerExecutionOfferRecoveryResult {
  offerId: string;
  attemptId: string;
  state: WorkerExecutionOfferJournalRecord['state'];
  observedAtMs: number;
  authority: WorkerExecutionRecoveryAuthority;
  finding: WorkerExecutionRecoveryFinding;
  receiptChecks: number;
  processChecks: number;
  completionSubmission?: WorkerExecutionCompletionSubmission;
  completion?: WorkerExecutionRecoveredCompletion;
  identityPid?: number;
}

export interface WorkerExecutionOfferRecoveryReconcilerOptions {
  clock?: { now(): number };
  receiptPublishGraceMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}

type ReceiptObservation =
  | { status: 'missing' }
  | { status: 'observed'; receipt: CompletionReceipt }
  | { status: 'conflict' }
  | { status: 'unavailable' };

const EXECUTION_OWNERSHIP_STATES = new Set<
  WorkerExecutionOfferJournalRecord['state']
>(['launching', 'started', 'running_acknowledged', 'recovery_required']);

/**
 * Evidence-only Worker recovery pass. It reads a trusted receipt before
 * probing a durable process identity and never starts, stops, ACKs or removes
 * anything. The caller owns scheduling and all control-plane mutations.
 */
export class WorkerExecutionOfferRecoveryReconciler {
  private readonly clock: { now(): number };
  private readonly receiptPublishGraceMs: number;
  private readonly wait: (delayMs: number) => Promise<void>;

  constructor(
    private readonly receipts: Pick<CompletionReceiptStore, 'read'>,
    private readonly receiptAuthenticator: WorkerExecutionCompletionReceiptAuthenticator,
    private readonly inspector: PersistedExecutionInspector,
    options: WorkerExecutionOfferRecoveryReconcilerOptions = {},
  ) {
    this.clock = options.clock ?? Date;
    this.receiptPublishGraceMs = options.receiptPublishGraceMs ?? 0;
    if (
      !Number.isSafeInteger(this.receiptPublishGraceMs) ||
      this.receiptPublishGraceMs < 0 ||
      this.receiptPublishGraceMs > 5_000
    ) {
      throw new RangeError('receiptPublishGraceMs must be between 0 and 5000');
    }
    this.wait =
      options.wait ??
      ((delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        }));
  }

  async reconcile(
    candidate: WorkerExecutionOfferJournalRecord,
    currentSession: WorkerRecord,
  ): Promise<WorkerExecutionOfferRecoveryResult> {
    const record = cloneWorkerExecutionOfferJournalRecord(candidate);
    const observedAtMs = this.now();
    const authority = this.authority(record, currentSession, observedAtMs);
    let receiptChecks = 0;
    let processChecks = 0;

    const observeReceipt = async (): Promise<ReceiptObservation> => {
      receiptChecks += 1;
      try {
        const receipt = await this.receipts.read(
          record.offer.candidate.attemptId,
        );
        if (!receipt) return { status: 'missing' };
        if (
          receipt.runId !== record.offer.candidate.runId ||
          receipt.attemptId !== record.offer.candidate.attemptId ||
          (record.executorStartedAtMs !== undefined &&
            receipt.startedAtMs !== record.executorStartedAtMs) ||
          !EXECUTION_OWNERSHIP_STATES.has(record.state)
        ) {
          return { status: 'conflict' };
        }
        if (!(await this.receiptAuthenticator.authenticate(receipt, record))) {
          return { status: 'conflict' };
        }
        return { status: 'observed', receipt };
      } catch {
        return { status: 'unavailable' };
      }
    };

    const result = (
      finding: WorkerExecutionRecoveryFinding,
      additions: Partial<
        Pick<
          WorkerExecutionOfferRecoveryResult,
          'completionSubmission' | 'completion' | 'identityPid'
        >
      > = {},
    ): WorkerExecutionOfferRecoveryResult => ({
      offerId: record.offer.offerId,
      attemptId: record.offer.candidate.attemptId,
      state: record.state,
      observedAtMs,
      authority,
      finding,
      receiptChecks,
      processChecks,
      ...additions,
    });

    const receiptResult = (
      observation: ReceiptObservation,
    ): WorkerExecutionOfferRecoveryResult | undefined => {
      if (observation.status === 'missing') return undefined;
      if (observation.status === 'conflict') {
        return result('completion_receipt_conflict');
      }
      if (observation.status === 'unavailable') {
        return result('completion_receipt_unavailable');
      }
      return result('completion_observed', {
        completionSubmission: this.completionSubmission(record, authority),
        completion: this.sanitizeCompletion(observation.receipt),
      });
    };

    const initialReceipt = receiptResult(await observeReceipt());
    if (initialReceipt) return initialReceipt;

    if (!EXECUTION_OWNERSHIP_STATES.has(record.state)) {
      return result('no_execution_expected');
    }
    if (!record.executorHandle) return result('launch_outcome_unknown');

    let inspection;
    processChecks += 1;
    try {
      inspection = await this.inspector.inspect(record.executorHandle);
    } catch {
      return result('execution_probe_unavailable');
    }
    if (inspection.status === 'running') {
      return result('execution_running', {
        ...(inspection.identityPid === undefined
          ? {}
          : { identityPid: inspection.identityPid }),
      });
    }
    if (inspection.status === 'invalid') {
      return result('execution_handle_invalid');
    }
    if (inspection.status === 'identity_mismatch') {
      return result('execution_identity_mismatch', {
        ...(inspection.identityPid === undefined
          ? {}
          : { identityPid: inspection.identityPid }),
      });
    }
    if (inspection.status === 'unsupported') {
      return result('execution_probe_unsupported', {
        ...(inspection.identityPid === undefined
          ? {}
          : { identityPid: inspection.identityPid }),
      });
    }

    const afterExitReceipt = receiptResult(await observeReceipt());
    if (afterExitReceipt) return afterExitReceipt;
    if (this.receiptPublishGraceMs > 0) {
      await this.wait(this.receiptPublishGraceMs);
      const afterGraceReceipt = receiptResult(await observeReceipt());
      if (afterGraceReceipt) return afterGraceReceipt;
    }
    return result('execution_exited_without_receipt', {
      ...(inspection.identityPid === undefined
        ? {}
        : { identityPid: inspection.identityPid }),
    });
  }

  private authority(
    record: WorkerExecutionOfferJournalRecord,
    currentSession: WorkerRecord,
    observedAtMs: number,
  ): WorkerExecutionRecoveryAuthority {
    if (
      record.offer.worker.id !== currentSession.id ||
      record.offer.worker.sessionId !== currentSession.sessionId ||
      record.offer.worker.generation !== currentSession.generation
    ) {
      return 'session_fenced';
    }
    if (currentSession.status === 'offline') return 'worker_offline';
    if (currentSession.leaseExpiresAtMs <= observedAtMs) {
      return 'worker_session_expired';
    }
    if (record.offer.lease.expiresAtMs <= observedAtMs) {
      return 'run_lease_expired';
    }
    return 'current';
  }

  private completionSubmission(
    record: WorkerExecutionOfferJournalRecord,
    authority: WorkerExecutionRecoveryAuthority,
  ): WorkerExecutionCompletionSubmission {
    if (
      record.state === 'recovery_required' &&
      record.recoveryReason === 'control_plane_terminal'
    ) {
      return 'blocked_control_plane_terminal';
    }
    if (authority === 'current') return 'ready';
    return `blocked_${authority}`;
  }

  private sanitizeCompletion(
    receipt: CompletionReceipt,
  ): WorkerExecutionRecoveredCompletion {
    return {
      callbackSequence: receipt.callbackSequence,
      outcome: receipt.exitCode === 0 ? 'succeeded' : 'failed',
      startedAtMs: receipt.startedAtMs,
      finishedAtMs: receipt.finishedAtMs,
      exitCode: receipt.exitCode,
    };
  }

  private now(): number {
    const observedAtMs = this.clock.now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new TypeError(
        'Worker offer recovery clock returned an invalid time',
      );
    }
    return observedAtMs;
  }
}
