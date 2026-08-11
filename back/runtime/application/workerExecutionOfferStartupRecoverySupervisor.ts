import type {
  WorkerExecutionOfferRecoveryActionResult,
  WorkerExecutionOfferRecoveryCoordinator,
  WorkerCompletionReceiptCleanup,
} from './workerExecutionOfferRecoveryCoordinator';
import type {
  WorkerExecutionOfferStartupAuditResult,
  WorkerExecutionOfferStartupCategory,
} from './workerExecutionOfferStartupAuditor';

export const MAX_WORKER_OFFER_STARTUP_RECOVERY_ACTIONS = 1024;

export interface WorkerExecutionOfferStartupRecoveryEntry {
  offerId: string;
  attemptId: string;
  category: WorkerExecutionOfferStartupCategory;
  outcome: 'applied' | 'failed';
  actionStatus?: WorkerExecutionOfferRecoveryActionResult['status'];
  receiptCleanup?: WorkerCompletionReceiptCleanup;
}

export interface WorkerExecutionOfferStartupRecoveryResult {
  status: 'recovered' | 'reconciliation_required' | 'action_budget_exhausted';
  actionsPlanned: number;
  actionsAttempted: number;
  entries: readonly WorkerExecutionOfferStartupRecoveryEntry[];
}

export class WorkerExecutionOfferStartupRecoveryAuditIncompleteError extends Error {
  constructor() {
    super('Worker offer startup recovery requires a complete startup audit');
    this.name = 'WorkerExecutionOfferStartupRecoveryAuditIncompleteError';
  }
}

export class InvalidWorkerExecutionOfferStartupRecoveryInputError extends TypeError {
  constructor(message: string) {
    super(`Worker offer startup recovery input is invalid: ${message}`);
    this.name = 'InvalidWorkerExecutionOfferStartupRecoveryInputError';
  }
}

const ACTIONABLE_CATEGORIES = new Set<WorkerExecutionOfferStartupCategory>([
  'settled_completion',
  'launch_reconciliation_required',
  'execution_reconciliation_required',
]);

const RECOVERED_ACTIONS = new Set<
  WorkerExecutionOfferRecoveryActionResult['status']
>([
  'not_found',
  'running_acknowledged',
  'already_running',
  'completion_acknowledged',
  'already_completed',
]);

/** Runs one bounded, sequential recovery pass and never creates a timer. */
export class WorkerExecutionOfferStartupRecoverySupervisor {
  private readonly maximumActions: number;

  constructor(
    private readonly coordinator: Pick<
      WorkerExecutionOfferRecoveryCoordinator,
      'recover'
    >,
    options: { maximumActions?: number } = {},
  ) {
    this.maximumActions = options.maximumActions ?? 64;
    if (
      !Number.isSafeInteger(this.maximumActions) ||
      this.maximumActions < 1 ||
      this.maximumActions > MAX_WORKER_OFFER_STARTUP_RECOVERY_ACTIONS
    ) {
      throw new RangeError(
        `maximumActions must be between 1 and ${MAX_WORKER_OFFER_STARTUP_RECOVERY_ACTIONS}`,
      );
    }
  }

  async recover(
    audit: WorkerExecutionOfferStartupAuditResult,
  ): Promise<WorkerExecutionOfferStartupRecoveryResult> {
    if (audit.status === 'scan_budget_exhausted') {
      throw new WorkerExecutionOfferStartupRecoveryAuditIncompleteError();
    }
    if (
      !Number.isSafeInteger(audit.recordsScanned) ||
      audit.recordsScanned < 0 ||
      audit.recordsScanned !== audit.entries.length
    ) {
      throw new InvalidWorkerExecutionOfferStartupRecoveryInputError(
        'record count does not match entries',
      );
    }
    const seen = new Set<string>();
    for (const entry of audit.entries) {
      if (seen.has(entry.offerId)) {
        throw new InvalidWorkerExecutionOfferStartupRecoveryInputError(
          'offerId is duplicated',
        );
      }
      seen.add(entry.offerId);
    }
    const planned = audit.entries.filter((entry) =>
      ACTIONABLE_CATEGORIES.has(entry.category),
    );
    if (planned.length > this.maximumActions) {
      return {
        status: 'action_budget_exhausted',
        actionsPlanned: planned.length,
        actionsAttempted: 0,
        entries: [],
      };
    }

    const entries: WorkerExecutionOfferStartupRecoveryEntry[] = [];
    let unresolved = false;
    for (const entry of planned) {
      try {
        const action = await this.coordinator.recover(entry.offerId);
        if (!RECOVERED_ACTIONS.has(action.status)) unresolved = true;
        entries.push({
          offerId: entry.offerId,
          attemptId: entry.attemptId,
          category: entry.category,
          outcome: 'applied',
          actionStatus: action.status,
          ...(action.receiptCleanup === undefined
            ? {}
            : { receiptCleanup: action.receiptCleanup }),
        });
      } catch {
        unresolved = true;
        entries.push({
          offerId: entry.offerId,
          attemptId: entry.attemptId,
          category: entry.category,
          outcome: 'failed',
        });
      }
    }
    return {
      status: unresolved ? 'reconciliation_required' : 'recovered',
      actionsPlanned: planned.length,
      actionsAttempted: entries.length,
      entries,
    };
  }
}
