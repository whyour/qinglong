import { v7 as uuidV7 } from 'uuid';
import type {
  RunAttemptRecord,
  RunEventRecord,
  RunRecord,
} from '../domain/run';
import {
  isTerminalRunAttemptStatus,
  reserveRunEvent,
} from '../domain/runStateMachine';
import { RunVersionConflictError } from '../domain/stateMachineErrors';
import type { PersistedExecutionInspector } from '../ports/persistedExecutionInspector';
import type { CompletionReceiptJournal } from '../ports/completionReceiptJournal';
import type {
  PrimaryRunRecoveryCandidate,
  PrimaryRunRecoveryCursor,
  PrimaryRunRecoverySource,
} from '../ports/primaryRunRecoverySource';
import type { RunRepository } from '../ports/runRepository';
import type { PrimaryCompletionReceiptConsumer } from './primaryCompletionReceiptConsumer';
import { RunCommandService } from './runCommandService';

export interface PrimaryRunStartupReconcilerClock {
  now(): number;
}

export interface PrimaryRunStartupReconcilerOptions {
  clock?: PrimaryRunStartupReconcilerClock;
  createEventId?: () => string;
  completionReceipts?: Pick<PrimaryCompletionReceiptConsumer, 'consume'>;
  completionReceiptJournal?: Pick<CompletionReceiptJournal, 'register'>;
  receiptPublishGraceMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}

export interface PrimaryRunStartupReconcileSummary {
  scanned: number;
  verifiedRunning: number;
  recoveredRunning: number;
  completedFromReceipt: number;
  quarantinedReceipts: number;
  publishGraceWaits: number;
  markedLost: number;
  skipped: number;
  ambiguous: number;
  failed: number;
  truncated: boolean;
  unsafeAttemptOverflow: boolean;
  nextCursor?: PrimaryRunRecoveryCursor;
}

type RecoveryLossReason =
  | 'attempt_missing'
  | 'attempt_incomplete'
  | 'handle_missing'
  | 'handle_invalid'
  | 'identity_mismatch'
  | 'identity_pid_mismatch'
  | 'identity_unsupported'
  | 'process_exited_unobserved';

const LOSS_METADATA: Readonly<
  Record<RecoveryLossReason, { errorCode: string; errorSummary: string }>
> = {
  attempt_missing: {
    errorCode: 'RECOVERY_ATTEMPT_MISSING',
    errorSummary: 'Active Run has no recoverable Attempt',
  },
  attempt_incomplete: {
    errorCode: 'RECOVERY_ATTEMPT_INCOMPLETE',
    errorSummary: 'Attempt did not persist executable ownership',
  },
  handle_missing: {
    errorCode: 'RECOVERY_HANDLE_MISSING',
    errorSummary: 'Attempt has no durable Executor handle',
  },
  handle_invalid: {
    errorCode: 'RECOVERY_HANDLE_INVALID',
    errorSummary: 'Attempt durable Executor handle is invalid',
  },
  identity_mismatch: {
    errorCode: 'RECOVERY_IDENTITY_MISMATCH',
    errorSummary: 'Operating system process identity does not match',
  },
  identity_pid_mismatch: {
    errorCode: 'RECOVERY_IDENTITY_PID_MISMATCH',
    errorSummary: 'Persisted PID does not match the durable handle',
  },
  identity_unsupported: {
    errorCode: 'RECOVERY_IDENTITY_UNSUPPORTED',
    errorSummary: 'Process identity cannot be verified on this platform',
  },
  process_exited_unobserved: {
    errorCode: 'RECOVERY_PROCESS_EXITED_UNOBSERVED',
    errorSummary: 'Process exited without a durable completion result',
  },
};

/** One bounded startup pass. The caller owns scheduling and pagination. */
export class PrimaryRunStartupReconciler {
  private readonly clock: PrimaryRunStartupReconcilerClock;
  private readonly createEventId: () => string;
  private readonly commands: RunCommandService;
  private readonly completionReceipts?: Pick<
    PrimaryCompletionReceiptConsumer,
    'consume'
  >;
  private readonly receiptPublishGraceMs: number;
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly completionReceiptJournal?: Pick<
    CompletionReceiptJournal,
    'register'
  >;
  private readonly inspectors = new Map<
    PersistedExecutionInspector['executorType'],
    PersistedExecutionInspector
  >();

  constructor(
    private readonly repository: RunRepository,
    private readonly source: PrimaryRunRecoverySource,
    inspectors: readonly PersistedExecutionInspector[],
    options: PrimaryRunStartupReconcilerOptions = {},
  ) {
    this.clock = options.clock ?? { now: Date.now };
    this.createEventId = options.createEventId ?? uuidV7;
    this.commands = new RunCommandService(repository, this.createEventId);
    this.completionReceipts = options.completionReceipts;
    this.completionReceiptJournal = options.completionReceiptJournal;
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
    for (const inspector of inspectors) {
      if (this.inspectors.has(inspector.executorType)) {
        throw new Error(
          `Duplicate persisted Executor inspector: ${inspector.executorType}`,
        );
      }
      this.inspectors.set(inspector.executorType, inspector);
    }
  }

  async reconcileBatch(
    options: {
      cursor?: PrimaryRunRecoveryCursor;
      limit?: number;
    } = {},
  ): Promise<PrimaryRunStartupReconcileSummary> {
    const page = await this.source.listCandidates(options);
    const summary: PrimaryRunStartupReconcileSummary = {
      scanned: page.candidates.length,
      verifiedRunning: 0,
      recoveredRunning: 0,
      completedFromReceipt: 0,
      quarantinedReceipts: 0,
      publishGraceWaits: 0,
      markedLost: 0,
      skipped: 0,
      ambiguous: 0,
      failed: 0,
      truncated: page.truncated,
      unsafeAttemptOverflow: page.unsafeAttemptOverflow,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
    if (page.unsafeAttemptOverflow) return summary;

    for (const candidate of page.candidates) {
      try {
        await this.reconcileCandidate(candidate, summary);
      } catch {
        summary.failed += 1;
      }
    }
    return summary;
  }

  private async reconcileCandidate(
    candidate: PrimaryRunRecoveryCandidate,
    summary: PrimaryRunStartupReconcileSummary,
  ): Promise<void> {
    const run = await this.repository.findRunById(candidate.runId);
    if (
      !run ||
      run.executionOwner !== 'runtime' ||
      !['dispatching', 'running'].includes(run.status)
    ) {
      summary.skipped += 1;
      return;
    }
    if (candidate.attempts.length > 1) {
      summary.ambiguous += 1;
      return;
    }
    if (candidate.attempts.length === 0) {
      await this.markLost(run, undefined, 'attempt_missing');
      summary.markedLost += 1;
      return;
    }

    const attemptReference = candidate.attempts[0];
    const attempt = await this.repository.findAttemptById(
      attemptReference.attemptId,
    );
    if (
      !attempt ||
      attempt.runId !== run.id ||
      !['claimed', 'starting', 'running'].includes(attempt.status)
    ) {
      summary.skipped += 1;
      return;
    }
    if (
      attempt.executorType === 'local_process' &&
      this.completionReceiptJournal
    ) {
      await this.completionReceiptJournal.register({
        runId: run.id,
        attemptId: attempt.id,
        registeredAtMs: attempt.createdAtMs,
      });
    }
    if (await this.consumeCompletionReceipt(attempt, summary)) return;
    const inspector = this.inspectors.get(attemptReference.executorType);
    if (!inspector || attempt.executorType !== inspector.executorType) {
      summary.skipped += 1;
      return;
    }
    if (attempt.status !== 'running') {
      await this.markLost(run, attempt, 'attempt_incomplete');
      summary.markedLost += 1;
      return;
    }
    if (!attempt.executorHandle) {
      await this.markLost(run, attempt, 'handle_missing');
      summary.markedLost += 1;
      return;
    }

    const inspection = await inspector.inspect(attempt.executorHandle);
    if (
      inspection.status !== 'running' ||
      (inspection.identityPid !== undefined &&
        inspection.identityPid !== attempt.pid)
    ) {
      if (await this.consumeCompletionReceipt(attempt, summary)) return;
      if (
        inspection.status === 'exited' &&
        (inspection.identityPid === undefined ||
          inspection.identityPid === attempt.pid) &&
        this.receiptPublishGraceMs > 0
      ) {
        summary.publishGraceWaits += 1;
        await this.wait(this.receiptPublishGraceMs);
        if (await this.consumeCompletionReceipt(attempt, summary)) return;
      }
    }
    if (
      inspection.identityPid !== undefined &&
      inspection.identityPid !== attempt.pid
    ) {
      await this.markLost(run, attempt, 'identity_pid_mismatch');
      summary.markedLost += 1;
      return;
    }
    if (inspection.status === 'running') {
      if (run.status === 'dispatching') {
        await this.commands.transitionRun({
          runId: run.id,
          to: 'running',
          expectedVersion: run.version,
          atMs: this.atOrAfter(
            run.createdAtMs,
            attempt.createdAtMs,
            attempt.startedAtMs,
          ),
          actor: { type: 'reconciler' },
        });
        summary.recoveredRunning += 1;
      } else {
        await this.appendVerifiedRunningEvent(run, attempt);
        summary.verifiedRunning += 1;
      }
      return;
    }

    const reason: RecoveryLossReason =
      inspection.status === 'invalid'
        ? 'handle_invalid'
        : inspection.status === 'identity_mismatch'
        ? 'identity_mismatch'
        : inspection.status === 'unsupported'
        ? 'identity_unsupported'
        : 'process_exited_unobserved';
    await this.markLost(run, attempt, reason);
    summary.markedLost += 1;
  }

  private async consumeCompletionReceipt(
    attempt: RunAttemptRecord,
    summary: PrimaryRunStartupReconcileSummary,
  ): Promise<boolean> {
    if (!this.completionReceipts || attempt.executorType !== 'local_process') {
      return false;
    }
    const result = await this.completionReceipts.consume(attempt.id);
    if (result.status === 'missing') return false;
    if (result.status === 'quarantined') {
      summary.quarantinedReceipts += 1;
      return false;
    }
    summary.completedFromReceipt += 1;
    return true;
  }

  private async markLost(
    initialRun: RunRecord,
    initialAttempt: RunAttemptRecord | undefined,
    reason: RecoveryLossReason,
  ): Promise<void> {
    const metadata = LOSS_METADATA[reason];
    let run = initialRun;
    const atMs = this.atOrAfter(
      run.createdAtMs,
      run.startedAtMs,
      initialAttempt?.createdAtMs,
      initialAttempt?.startedAtMs,
    );
    if (initialAttempt && !isTerminalRunAttemptStatus(initialAttempt.status)) {
      const attempt = await this.commands.transitionRunAttempt({
        runId: run.id,
        attemptId: initialAttempt.id,
        to: 'lost',
        expectedRunVersion: run.version,
        atMs,
        errorCode: metadata.errorCode,
        errorSummary: metadata.errorSummary,
        actor: { type: 'reconciler' },
      });
      run = attempt.run;
    }
    await this.commands.transitionRun({
      runId: run.id,
      to: 'lost',
      expectedVersion: run.version,
      atMs,
      errorCode: metadata.errorCode,
      errorSummary: metadata.errorSummary,
      actor: { type: 'reconciler' },
    });
  }

  private async appendVerifiedRunningEvent(
    expectedRun: RunRecord,
    attempt: RunAttemptRecord,
  ): Promise<void> {
    const atMs = this.atOrAfter(
      expectedRun.createdAtMs,
      expectedRun.startedAtMs,
      attempt.createdAtMs,
      attempt.startedAtMs,
    );
    await this.repository.transaction(async (transaction) => {
      const current = await transaction.findRunById(expectedRun.id);
      if (!current) throw new Error('Primary Run disappeared during recovery');
      if (current.version !== expectedRun.version) {
        throw new RunVersionConflictError(
          current.id,
          expectedRun.version,
          current.version,
        );
      }
      const reserved = reserveRunEvent(current, current.version);
      const updated = await transaction.compareAndSetRun(
        reserved.run,
        current.version,
      );
      if (!updated) {
        throw new RunVersionConflictError(
          current.id,
          current.version,
          current.version,
        );
      }
      const event: RunEventRecord = {
        id: this.createEventId(),
        runId: current.id,
        attemptId: attempt.id,
        sequence: reserved.sequence,
        type: 'run.reconciled',
        dedupeKey: `primary-running-reconciled:${attempt.id}:${current.version}`,
        actorType: 'reconciler',
        payload: {
          status: 'running',
          executor_type: attempt.executorType,
          evidence: 'durable_handle',
          version: reserved.run.version,
        },
        createdAtMs: atMs,
      };
      await transaction.appendEvent(event);
    });
  }

  private atOrAfter(...timestamps: Array<number | undefined>): number {
    return Math.max(
      this.clock.now(),
      ...timestamps.filter((value): value is number => value !== undefined),
    );
  }
}
