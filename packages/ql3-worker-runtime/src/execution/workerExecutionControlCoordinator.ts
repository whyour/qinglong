// Worker Execution owns lease renewal, stop fencing, and completion convergence.
import type {
  LocalProcessController,
  LocalProcessStopResult,
} from '@qinglong/local-process';
import type { RemoteWorkerLeaseControlResult } from '@qinglong/runtime-core/remote-worker-lease-control';
import {
  normalizeWorkerRemoteExecutionInboxRecord,
  type WorkerRemoteExecutionInbox,
  type WorkerRemoteExecutionInboxRecord,
} from '../remote-execution/executionInbox';
import type { WorkerRemoteExecutionSession } from '../remote-execution/executionInboxProcessor';
import type {
  WorkerRemoteCompletionResult,
  WorkerRemoteCompletionStatus,
} from './workerCompletionCoordinator';
import type { WorkerRemoteLeaseControlClient } from '../remote-execution/transport/remoteWorkerLeaseControlHttpsClient';

export interface WorkerRemoteExecutionControlCoordinatorOptions {
  readonly currentSession: () => WorkerRemoteExecutionSession | undefined;
  readonly now?: () => number;
}

export type WorkerRemoteExecutionControlResult = Readonly<{
  readonly offerId: string;
  readonly completionStatus?: WorkerRemoteCompletionStatus;
} & (
  | { readonly status: 'not_found' }
  | { readonly status: 'completion_acknowledged' }
  | {
      readonly status: 'renewed';
      readonly leaseVersion: number;
      readonly expiresAtMs: number;
    }
  | {
      readonly status: 'stop_requested' | 'stop_unverified';
      readonly reason: NonNullable<RemoteWorkerLeaseControlResult['stop']>['reason'];
      readonly leaseVersion: number;
      readonly expiresAtMs: number;
      readonly stop: LocalProcessStopResult;
    }
  | {
      readonly status: 'terminal';
      readonly terminalStatus: NonNullable<
        RemoteWorkerLeaseControlResult['terminalStatus']
      >;
      readonly stop: LocalProcessStopResult;
    }
  | {
      readonly status: 'completion_terminal';
      readonly stop: LocalProcessStopResult;
    }
  | {
      readonly status: 'lease_expired';
      readonly stop: LocalProcessStopResult;
      readonly recoveryReason:
        | 'lease_lost_local_execution_stopped'
        | 'lease_lost_local_execution_unverified';
    }
  | { readonly status: 'session_unavailable' }
)>;

export class WorkerRemoteExecutionControlCoordinatorError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'invalid_clock'
      | 'lease_response_invalid',
    options?: ErrorOptions,
  ) {
    super(`Worker remote execution control failed: ${reason}`, options);
    this.name = 'WorkerRemoteExecutionControlCoordinatorError';
  }
}

const CONTROL_PLANE_TERMINAL_TRANSITIONS = new Set([
  'accepted',
  'starting_acknowledged',
  'launching',
  'started',
  'running_acknowledged',
  'start_failed',
  'recovery_required',
]);

/**
 * One bounded, timer-free supervision step for an accepted remote execution.
 * Completion evidence is replayed first; live authority is then renewed or an
 * exact durable process identity is stopped before recovery evidence is stored.
 */
export class WorkerRemoteExecutionControlCoordinator {
  private readonly currentSessionProvider: () =>
    WorkerRemoteExecutionSession | undefined;
  private readonly nowProvider: () => number;
  private readonly inFlight = new Map<
    string,
    Promise<WorkerRemoteExecutionControlResult>
  >();

  constructor(
    private readonly inbox: Pick<
      WorkerRemoteExecutionInbox,
      'readOffer' | 'replaceOffer'
    >,
    private readonly completion: Pick<
      { recover(offerId: string): Promise<WorkerRemoteCompletionResult> },
      'recover'
    >,
    private readonly leaseControl: WorkerRemoteLeaseControlClient,
    private readonly processes: Pick<LocalProcessController, 'stop'>,
    options: WorkerRemoteExecutionControlCoordinatorOptions,
  ) {
    if (
      typeof inbox?.readOffer !== 'function' ||
      typeof inbox?.replaceOffer !== 'function' ||
      typeof completion?.recover !== 'function' ||
      typeof leaseControl?.control !== 'function' ||
      typeof processes?.stop !== 'function' ||
      typeof options?.currentSession !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')
    ) {
      throw new WorkerRemoteExecutionControlCoordinatorError(
        'invalid_configuration',
      );
    }
    this.currentSessionProvider = options.currentSession;
    this.nowProvider = options.now ?? Date.now;
  }

  reconcile(offerId: string): Promise<WorkerRemoteExecutionControlResult> {
    const active = this.inFlight.get(offerId);
    if (active) return active;
    const operation = this.reconcileOnce(offerId).finally(() => {
      if (this.inFlight.get(offerId) === operation) this.inFlight.delete(offerId);
    });
    this.inFlight.set(offerId, operation);
    return operation;
  }

  private async reconcileOnce(
    offerId: string,
  ): Promise<WorkerRemoteExecutionControlResult> {
    const value = await this.inbox.readOffer(offerId);
    if (!value) return Object.freeze({ offerId, status: 'not_found' as const });
    let record = normalizeWorkerRemoteExecutionInboxRecord(value);
    if (record.state === 'completion_acknowledged') {
      return Object.freeze({
        offerId,
        status: 'completion_acknowledged' as const,
      });
    }

    let replay: WorkerRemoteCompletionResult | undefined;
    try {
      replay = await this.completion.recover(offerId);
    } catch {
      // Completion and lease transports are intentionally isolated: a failed
      // Artifact upload must not prevent the Worker from retaining authority.
    }
    if (
      replay?.status === 'completion_acknowledged' ||
      replay?.status === 'already_completed'
    ) {
      return Object.freeze({
        offerId,
        status: 'completion_acknowledged' as const,
        completionStatus: replay.status,
      });
    }
    record = await this.readRequired(offerId);
    const completionStatus = replay?.status;
    if (replay?.status === 'control_plane_terminal') {
      const stop = await this.stop(record);
      await this.markControlPlaneTerminal(record);
      return Object.freeze({
        offerId,
        status: 'completion_terminal' as const,
        stop,
        completionStatus,
      });
    }

    const now = this.now();
    if (record.offer.lease.expiresAtMs <= now) {
      const stop = await this.stop(record);
      const recoveryReason = this.stopWasConclusive(stop)
        ? 'lease_lost_local_execution_stopped' as const
        : 'lease_lost_local_execution_unverified' as const;
      await this.markLeaseLost(record, recoveryReason);
      return Object.freeze({
        offerId,
        status: 'lease_expired' as const,
        stop,
        recoveryReason,
        ...(completionStatus === undefined ? {} : { completionStatus }),
      });
    }

    if (!this.sessionMatches(record, now)) {
      return Object.freeze({
        offerId,
        status: 'session_unavailable' as const,
        ...(completionStatus === undefined ? {} : { completionStatus }),
      });
    }

    const control = await this.leaseControl.control(Object.freeze({
      workerId: record.offer.lease.workerId,
      workerSessionId: record.offer.lease.workerSessionId,
      workerGeneration: record.offer.lease.workerGeneration,
      projectId: record.offer.candidate.projectId,
      runId: record.offer.candidate.runId,
      attemptId: record.offer.candidate.attemptId,
      offerId: record.offer.offerId,
      leaseGeneration: record.offer.lease.leaseGeneration,
      leaseToken: record.offer.leaseToken,
      expectedLeaseVersion: record.offer.lease.version,
    }));
    this.assertAuthority(record, control);
    if (control.status === 'terminal') {
      const stop = await this.stop(record);
      await this.markControlPlaneTerminal(record);
      return Object.freeze({
        offerId,
        status: 'terminal' as const,
        terminalStatus: control.terminalStatus!,
        stop,
        ...(completionStatus === undefined ? {} : { completionStatus }),
      });
    }

    record = await this.persistRenewedLease(record, control);
    if (control.status === 'renewed') {
      return Object.freeze({
        offerId,
        status: 'renewed' as const,
        leaseVersion: record.offer.lease.version,
        expiresAtMs: record.offer.lease.expiresAtMs,
        ...(completionStatus === undefined ? {} : { completionStatus }),
      });
    }
    const stop = await this.stop(record);
    return Object.freeze({
      offerId,
      status: this.stopWasConclusive(stop)
        ? 'stop_requested' as const
        : 'stop_unverified' as const,
      reason: control.stop!.reason,
      leaseVersion: record.offer.lease.version,
      expiresAtMs: record.offer.lease.expiresAtMs,
      stop,
      ...(completionStatus === undefined ? {} : { completionStatus }),
    });
  }

  private assertAuthority(
    record: WorkerRemoteExecutionInboxRecord,
    result: Readonly<RemoteWorkerLeaseControlResult>,
  ): void {
    if (
      result.projectId !== record.offer.candidate.projectId ||
      result.runId !== record.offer.candidate.runId ||
      result.attemptId !== record.offer.candidate.attemptId ||
      result.offerId !== record.offer.offerId ||
      result.leaseGeneration !== record.offer.lease.leaseGeneration ||
      (result.status !== 'terminal' &&
        result.leaseVersion !== record.offer.lease.version + 1)
    ) {
      throw new WorkerRemoteExecutionControlCoordinatorError(
        'lease_response_invalid',
      );
    }
  }

  private async persistRenewedLease(
    record: WorkerRemoteExecutionInboxRecord,
    result: Readonly<RemoteWorkerLeaseControlResult>,
  ): Promise<WorkerRemoteExecutionInboxRecord> {
    if (
      result.leaseVersion === undefined ||
      result.renewedAtMs === undefined ||
      result.expiresAtMs === undefined ||
      result.renewedAtMs < record.offer.lease.renewedAtMs ||
      result.renewedAtMs < record.offer.lease.updatedAtMs ||
      result.expiresAtMs <= result.renewedAtMs
    ) {
      throw new WorkerRemoteExecutionControlCoordinatorError(
        'lease_response_invalid',
      );
    }
    const next = normalizeWorkerRemoteExecutionInboxRecord({
      ...record,
      revision: record.revision + 1,
      updatedAtMs: Math.max(record.updatedAtMs, result.renewedAtMs),
      offer: {
        ...record.offer,
        lease: {
          ...record.offer.lease,
          version: result.leaseVersion,
          renewedAtMs: result.renewedAtMs,
          expiresAtMs: result.expiresAtMs,
          updatedAtMs: result.renewedAtMs,
        },
      },
    });
    try {
      await this.inbox.replaceOffer(next, record.revision);
      return next;
    } catch (error) {
      const current = await this.inbox.readOffer(record.offer.offerId);
      if (current) {
        const normalized = normalizeWorkerRemoteExecutionInboxRecord(current);
        if (normalized.offer.lease.version >= result.leaseVersion) {
          return normalized;
        }
      }
      throw error;
    }
  }

  private async markLeaseLost(
    record: WorkerRemoteExecutionInboxRecord,
    recoveryReason:
      | 'lease_lost_local_execution_stopped'
      | 'lease_lost_local_execution_unverified',
  ): Promise<void> {
    if (record.state === 'recovery_required') return;
    if (record.state === 'start_failure_acknowledged') return;
    await this.replaceRecovery(record, recoveryReason);
  }

  private async markControlPlaneTerminal(
    record: WorkerRemoteExecutionInboxRecord,
  ): Promise<void> {
    if (
      record.state === 'recovery_required' ||
      !CONTROL_PLANE_TERMINAL_TRANSITIONS.has(record.state)
    ) return;
    await this.replaceRecovery(record, 'control_plane_terminal');
  }

  private async replaceRecovery(
    record: WorkerRemoteExecutionInboxRecord,
    recoveryReason: WorkerRemoteExecutionInboxRecord['recoveryReason'],
  ): Promise<void> {
    const next = normalizeWorkerRemoteExecutionInboxRecord({
      ...record,
      revision: record.revision + 1,
      state: 'recovery_required',
      recoveryReason,
      updatedAtMs: Math.max(record.updatedAtMs, this.now()),
    });
    try {
      await this.inbox.replaceOffer(next, record.revision);
    } catch (error) {
      const current = await this.inbox.readOffer(record.offer.offerId);
      if (
        current &&
        normalizeWorkerRemoteExecutionInboxRecord(current).state ===
          'recovery_required'
      ) return;
      throw error;
    }
  }

  private async stop(
    record: WorkerRemoteExecutionInboxRecord,
  ): Promise<LocalProcessStopResult> {
    if (!record.executorHandle) {
      return record.state === 'launching'
        ? Object.freeze({ status: 'unknown' as const, reason: 'invalid_handle' as const })
        : Object.freeze({ status: 'already_exited' as const });
    }
    return this.processes.stop(record.executorHandle);
  }

  private stopWasConclusive(result: LocalProcessStopResult): boolean {
    return result.status === 'stopped' || result.status === 'already_exited';
  }

  private sessionMatches(
    record: WorkerRemoteExecutionInboxRecord,
    now: number,
  ): boolean {
    const session = this.currentSessionProvider();
    return Boolean(
      session &&
      session.workerId === record.offer.worker.workerId &&
      session.sessionId === record.offer.worker.sessionId &&
      session.generation === record.offer.worker.generation &&
      session.status !== 'offline' &&
      session.leaseExpiresAtMs > now
    );
  }

  private async readRequired(
    offerId: string,
  ): Promise<WorkerRemoteExecutionInboxRecord> {
    const value = await this.inbox.readOffer(offerId);
    if (!value) {
      throw new WorkerRemoteExecutionControlCoordinatorError(
        'invalid_configuration',
      );
    }
    return normalizeWorkerRemoteExecutionInboxRecord(value);
  }

  private now(): number {
    const value = this.nowProvider();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WorkerRemoteExecutionControlCoordinatorError('invalid_clock');
    }
    return value;
  }
}
