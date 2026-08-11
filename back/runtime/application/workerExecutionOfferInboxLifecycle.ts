import type { WorkerRecord } from '../domain/worker';
import type { WorkerExecutionOfferJournalOwnership } from '../ports/workerExecutionOfferJournalOwnership';
import type {
  WorkerExecutionOfferStartupAuditResult,
  WorkerExecutionOfferStartupAuditor,
} from './workerExecutionOfferStartupAuditor';
import type {
  WorkerExecutionOfferStartupRecoveryResult,
  WorkerExecutionOfferStartupRecoverySupervisor,
} from './workerExecutionOfferStartupRecoverySupervisor';

export type WorkerExecutionOfferInboxStartResult =
  | {
      status: 'ready' | 'reconciliation_required';
      audit: WorkerExecutionOfferStartupAuditResult;
      recovery?: WorkerExecutionOfferStartupRecoveryResult;
    }
  | {
      status: 'already_started';
      audit: WorkerExecutionOfferStartupAuditResult;
      recovery?: WorkerExecutionOfferStartupRecoveryResult;
    };

export type WorkerExecutionOfferInboxStopResult =
  | 'stopped'
  | 'not_started'
  | 'ownership_compromised';

export class WorkerExecutionOfferInboxStartupIncompleteError extends Error {
  constructor(readonly audit: WorkerExecutionOfferStartupAuditResult) {
    super('Worker execution offer inbox startup audit exhausted its budget');
    this.name = 'WorkerExecutionOfferInboxStartupIncompleteError';
  }
}

export class WorkerExecutionOfferInboxRecoveryIncompleteError extends Error {
  constructor(readonly recovery: WorkerExecutionOfferStartupRecoveryResult) {
    super('Worker execution offer inbox startup recovery exhausted its budget');
    this.name = 'WorkerExecutionOfferInboxRecoveryIncompleteError';
  }
}

/**
 * Owns the ordering contract: acquire the root, finish a bounded audit, then
 * keep ownership until shutdown. It does not start a delivery transport.
 */
export class WorkerExecutionOfferInboxLifecycle {
  private active = false;
  private lastAudit?: WorkerExecutionOfferStartupAuditResult;
  private lastRecovery?: WorkerExecutionOfferStartupRecoveryResult;

  constructor(
    private readonly ownership: WorkerExecutionOfferJournalOwnership,
    private readonly auditor: Pick<WorkerExecutionOfferStartupAuditor, 'audit'>,
    private readonly recovery?: Pick<
      WorkerExecutionOfferStartupRecoverySupervisor,
      'recover'
    >,
  ) {}

  async start(
    currentSession: WorkerRecord,
  ): Promise<WorkerExecutionOfferInboxStartResult> {
    if (this.active && this.lastAudit) {
      return {
        status: 'already_started',
        audit: this.lastAudit,
        ...(this.lastRecovery === undefined
          ? {}
          : { recovery: this.lastRecovery }),
      };
    }
    await this.ownership.acquireOwnership();
    try {
      let audit = await this.auditor.audit(currentSession);
      if (audit.status === 'scan_budget_exhausted') {
        throw new WorkerExecutionOfferInboxStartupIncompleteError(audit);
      }
      let recovery: WorkerExecutionOfferStartupRecoveryResult | undefined;
      if (this.recovery) {
        recovery = await this.recovery.recover(audit);
        if (recovery.status === 'action_budget_exhausted') {
          throw new WorkerExecutionOfferInboxRecoveryIncompleteError(recovery);
        }
        audit = await this.auditor.audit(currentSession);
        if (audit.status === 'scan_budget_exhausted') {
          throw new WorkerExecutionOfferInboxStartupIncompleteError(audit);
        }
      }
      this.active = true;
      this.lastAudit = audit;
      this.lastRecovery = recovery;
      return {
        status: audit.status,
        audit,
        ...(recovery === undefined ? {} : { recovery }),
      };
    } catch (error) {
      await this.ownership.releaseOwnership().catch(() => undefined);
      throw error;
    }
  }

  currentAudit(): WorkerExecutionOfferStartupAuditResult | undefined {
    return this.lastAudit;
  }

  async stop(): Promise<WorkerExecutionOfferInboxStopResult> {
    if (!this.active) return 'not_started';
    this.active = false;
    this.lastAudit = undefined;
    this.lastRecovery = undefined;
    const released = await this.ownership.releaseOwnership();
    return released === 'released' || released === 'not_owned'
      ? 'stopped'
      : 'ownership_compromised';
  }
}
