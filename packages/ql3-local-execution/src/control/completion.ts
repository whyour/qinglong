import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import type { LocalCompletionReceiptJournal } from '@qinglong/runtime-core/local-completion-receipt-journal';
import type {
  RunAttemptRecord,
  RunEventRecord,
  RunRecord,
  RunRepository,
  RunRepositoryTransaction,
} from '@qinglong/runtime-core/run-repository';
import {
  InvalidCompletionReceiptError,
  type CompletionReceipt,
  type CompletionReceiptStore,
} from '@qinglong/local-process';
import type { LocalWorkflowTaskExecutionRepository } from '../execution/workflowTaskExecution';

export const MAX_LOCAL_COMPLETION_QUARANTINE_RETENTION_MS = 24 * 60 * 60_000;

const ACTIVE_ATTEMPT_STATUSES = new Set(['claimed', 'starting', 'running']);
const TERMINAL_ATTEMPT_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);
const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);

type MaintainedCompletionReceiptStore = CompletionReceiptStore & {
  quarantine?(attemptId: string): Promise<string | undefined>;
  quarantineReference?(attemptId: string): string;
};

export type LocalCompletionDisposition =
  | 'completed'
  | 'already_terminal'
  | 'missing'
  | 'invalid'
  | 'stale';

export interface LocalCompletionReceiptProcessorOptions {
  readonly clock?: { now(): number };
  readonly createEventId?: () => string;
  readonly journal?: Pick<
    LocalCompletionReceiptJournal,
    'markQuarantined' | 'resolve'
  >;
  readonly quarantineRetentionMs?: number;
  readonly onDiagnostic?: (
    record: Readonly<{
      kind:
        | 'receipt_cleanup_failed'
        | 'receipt_quarantined'
        | 'journal_cleanup_failed';
      runId: string;
      attemptId: string;
    }>,
  ) => void | Promise<void>;
  readonly workflowTasks?: LocalWorkflowTaskExecutionRepository;
}

interface AggregateSnapshot {
  readonly run: RunRecord;
  readonly attempt: RunAttemptRecord;
}

interface TerminalMapping {
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  readonly errorCode?: string;
  readonly errorSummary?: string;
}

class LocalCompletionConcurrentWriteError extends Error {}

function timestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function atOrAfter(
  now: number,
  run: RunRecord,
  attempt: RunAttemptRecord,
): number {
  return Math.max(
    timestamp(now, 'Local completion observation'),
    run.createdAtMs,
    run.startedAtMs ?? 0,
    attempt.createdAtMs,
    attempt.startedAtMs ?? 0,
  );
}

function reserveEvent(run: RunRecord): Readonly<{
  run: RunRecord;
  sequence: number;
}> {
  const version = run.version + 1;
  const sequence = run.eventSequence + 1;
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(sequence)) {
    throw new RangeError('Local completion aggregate counter overflowed');
  }
  return Object.freeze({
    run: { ...run, version, eventSequence: sequence },
    sequence,
  });
}

function mapping(run: RunRecord, receipt: CompletionReceipt): TerminalMapping {
  if (run.cancelRequestedAtMs !== undefined) {
    return run.cancelReason === 'timeout'
      ? Object.freeze({
          status: 'timed_out' as const,
          errorCode: 'EXECUTION_TIMED_OUT',
          errorSummary: 'Execution exceeded its configured timeout',
        })
      : Object.freeze({
          status: 'cancelled' as const,
          errorCode: 'EXECUTION_CANCELLED',
          errorSummary: 'Execution was cancelled',
        });
  }
  return receipt.exitCode === 0
    ? Object.freeze({ status: 'succeeded' as const })
    : Object.freeze({
        status: 'failed' as const,
        errorCode: 'EXECUTION_FAILED',
        errorSummary: 'Execution completed without success',
      });
}

function authenticate(
  run: RunRecord,
  attempt: RunAttemptRecord,
  receipt: CompletionReceipt,
  terminal: boolean,
): void {
  const allowedSequence = terminal
    ? receipt.callbackSequence === attempt.callbackSequence ||
      receipt.callbackSequence === attempt.callbackSequence + 1
    : receipt.callbackSequence === attempt.callbackSequence + 1;
  if (
    run.executionOwner !== 'runtime' ||
    receipt.runId !== run.id ||
    receipt.attemptId !== attempt.id ||
    !allowedSequence ||
    receipt.startedAtMs < attempt.createdAtMs ||
    (attempt.startedAtMs !== undefined &&
      receipt.startedAtMs < attempt.startedAtMs) ||
    !attempt.callbackTokenHash ||
    !/^[a-f0-9]{64}$/.test(attempt.callbackTokenHash)
  ) {
    throw new InvalidCompletionReceiptError(
      'Completion receipt does not match durable Run authority',
    );
  }
  const expected = Buffer.from(attempt.callbackTokenHash, 'hex');
  const actual = createHash('sha256').update(receipt.token, 'utf8').digest();
  if (!timingSafeEqual(expected, actual)) {
    throw new InvalidCompletionReceiptError(
      'Completion receipt token does not match durable authority',
    );
  }
}

function event(
  id: string,
  runId: string,
  attemptId: string,
  sequence: number,
  type: string,
  dedupeKey: string,
  payload: Readonly<Record<string, unknown>>,
  atMs: number,
): RunEventRecord {
  return {
    id,
    runId,
    attemptId,
    sequence,
    type,
    dedupeKey,
    actorType: 'executor',
    actorId: 'completion-receipt',
    payload,
    createdAtMs: atMs,
  };
}

export class LocalCompletionReceiptProcessor {
  private readonly clock: { now(): number };
  private readonly createEventId: () => string;
  private readonly journal?: LocalCompletionReceiptProcessorOptions['journal'];
  private readonly quarantineRetentionMs: number;
  private readonly onDiagnostic?: LocalCompletionReceiptProcessorOptions['onDiagnostic'];
  private readonly workflowTasks:
    | LocalWorkflowTaskExecutionRepository
    | undefined;

  constructor(
    private readonly repository: RunRepository,
    private readonly receipts: MaintainedCompletionReceiptStore,
    options: LocalCompletionReceiptProcessorOptions = {},
  ) {
    this.clock = options.clock ?? { now: Date.now };
    this.createEventId = options.createEventId ?? randomUUID;
    this.journal = options.journal;
    this.quarantineRetentionMs = options.quarantineRetentionMs ?? 60 * 60_000;
    if (
      !Number.isSafeInteger(this.quarantineRetentionMs) ||
      this.quarantineRetentionMs < 0 ||
      this.quarantineRetentionMs > MAX_LOCAL_COMPLETION_QUARANTINE_RETENTION_MS
    ) {
      throw new RangeError('Local completion quarantine retention is invalid');
    }
    this.onDiagnostic = options.onDiagnostic;
    this.workflowTasks = options.workflowTasks;
    if (
      this.workflowTasks !== undefined &&
      typeof this.workflowTasks.complete !== 'function'
    ) {
      throw new TypeError(
        'Local Workflow Task completion repository is invalid',
      );
    }
  }

  async process(attemptId: string): Promise<LocalCompletionDisposition> {
    const snapshot = await this.load(attemptId);
    if (!snapshot || snapshot.attempt.executorType !== 'local_process') {
      return 'stale';
    }
    let receipt: CompletionReceipt | undefined;
    try {
      receipt = await this.receipts.read(attemptId);
      if (!receipt) return 'missing';
      authenticate(
        snapshot.run,
        snapshot.attempt,
        receipt,
        TERMINAL_RUN_STATUSES.has(snapshot.run.status) ||
          TERMINAL_ATTEMPT_STATUSES.has(snapshot.attempt.status),
      );
    } catch (error) {
      if (!(error instanceof InvalidCompletionReceiptError)) throw error;
      await this.quarantine(snapshot);
      return 'invalid';
    }

    if (
      TERMINAL_RUN_STATUSES.has(snapshot.run.status) ||
      TERMINAL_ATTEMPT_STATUSES.has(snapshot.attempt.status)
    ) {
      await this.cleanup(receipt);
      return 'already_terminal';
    }
    if (!ACTIVE_ATTEMPT_STATUSES.has(snapshot.attempt.status)) return 'stale';

    if (snapshot.attempt.stepRunId !== undefined) {
      if (!this.workflowTasks) return 'stale';
      const terminal = mapping(snapshot.run, receipt);
      const disposition = await this.workflowTasks.complete({
        run: snapshot.run,
        attempt: snapshot.attempt,
        callbackSequence: receipt.callbackSequence,
        startedAtMs: receipt.startedAtMs,
        finishedAtMs: Math.max(
          atOrAfter(this.clock.now(), snapshot.run, snapshot.attempt),
          receipt.finishedAtMs,
        ),
        exitCode: receipt.exitCode,
        terminalStatus: terminal.status,
        ...(terminal.errorCode === undefined
          ? {}
          : {
              errorCode: terminal.errorCode,
              errorSummary: terminal.errorSummary,
            }),
        attemptEventId: this.createEventId(),
        syntheticStartMutationId: this.createEventId(),
        terminalStepMutationId: this.createEventId(),
      });
      if (
        disposition === 'completed' ||
        disposition === 'already_terminal'
      ) {
        await this.cleanup(receipt);
      }
      return disposition;
    }

    const completed = await this.repository.transaction(async (transaction) => {
      const run = await transaction.findRunById(snapshot.run.id);
      const attempt = await transaction.findAttemptById(snapshot.attempt.id);
      if (
        !run ||
        !attempt ||
        run.version !== snapshot.run.version ||
        run.status !== snapshot.run.status ||
        attempt.status !== snapshot.attempt.status ||
        attempt.callbackSequence !== snapshot.attempt.callbackSequence ||
        attempt.runId !== run.id
      ) {
        return false;
      }
      authenticate(run, attempt, receipt, false);
      const terminal = mapping(run, receipt);
      const atMs = Math.max(
        atOrAfter(this.clock.now(), run, attempt),
        receipt.finishedAtMs,
      );
      const attemptReserved = reserveEvent(run);
      const nextAttempt: RunAttemptRecord = {
        ...attempt,
        status: terminal.status,
        callbackSequence: receipt.callbackSequence,
        finishedAtMs: atMs,
        exitCode: receipt.exitCode,
        ...(terminal.errorCode === undefined
          ? {}
          : {
              errorCode: terminal.errorCode,
              errorSummary: terminal.errorSummary,
            }),
      };
      if (
        !(await transaction.compareAndSetRun(attemptReserved.run, run.version))
      ) {
        throw new LocalCompletionConcurrentWriteError();
      }
      if (
        !(await transaction.compareAndSetAttempt(nextAttempt, {
          status: attempt.status,
          callbackSequence: attempt.callbackSequence,
        }))
      ) {
        throw new LocalCompletionConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          run.id,
          attempt.id,
          attemptReserved.sequence,
          `attempt.${terminal.status}`,
          `local-completion:${attempt.id}:${receipt.callbackSequence}:attempt`,
          Object.freeze({
            attempt_id: attempt.id,
            from_status: attempt.status,
            to_status: terminal.status,
            callback_sequence: receipt.callbackSequence,
            exit_code: receipt.exitCode,
            version: attemptReserved.run.version,
          }),
          atMs,
        ),
      );
      const runReserved = reserveEvent(attemptReserved.run);
      const nextRun: RunRecord = {
        ...runReserved.run,
        status: terminal.status,
        finishedAtMs: atMs,
        ...(terminal.errorCode === undefined
          ? {}
          : {
              errorCode: terminal.errorCode,
              errorSummary: terminal.errorSummary,
            }),
      };
      if (
        !(await transaction.compareAndSetRun(
          nextRun,
          attemptReserved.run.version,
        ))
      ) {
        throw new LocalCompletionConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          run.id,
          attempt.id,
          runReserved.sequence,
          `run.${terminal.status}`,
          `local-completion:${attempt.id}:${receipt.callbackSequence}:run`,
          Object.freeze({
            from_status: run.status,
            to_status: terminal.status,
            version: nextRun.version,
          }),
          atMs,
        ),
      );
      return true;
    });
    if (!completed) return 'stale';
    await this.cleanup(receipt);
    return 'completed';
  }

  private load(attemptId: string): Promise<AggregateSnapshot | null> {
    return this.repository.transaction(async (transaction) => {
      const attempt = await transaction.findAttemptById(attemptId);
      if (!attempt) return null;
      const run = await transaction.findRunById(attempt.runId);
      return run ? Object.freeze({ run, attempt }) : null;
    });
  }

  private async quarantine(snapshot: AggregateSnapshot): Promise<void> {
    const reference = this.receipts.quarantineReference?.(snapshot.attempt.id);
    if (reference && this.journal) {
      const updatedAtMs = atOrAfter(
        this.clock.now(),
        snapshot.run,
        snapshot.attempt,
      );
      const purgeAfterMs = timestamp(
        updatedAtMs + this.quarantineRetentionMs,
        'Local completion quarantine expiry',
      );
      await this.journal.markQuarantined({
        attemptId: snapshot.attempt.id,
        quarantineRef: reference,
        updatedAtMs,
        purgeAfterMs,
      });
    }
    const quarantined = await this.receipts.quarantine?.(snapshot.attempt.id);
    if (quarantined) {
      await this.diagnostic({
        kind: 'receipt_quarantined',
        runId: snapshot.run.id,
        attemptId: snapshot.attempt.id,
      });
    }
  }

  private async cleanup(receipt: CompletionReceipt): Promise<void> {
    try {
      await this.receipts.remove(receipt.attemptId);
    } catch {
      await this.diagnostic({
        kind: 'receipt_cleanup_failed',
        runId: receipt.runId,
        attemptId: receipt.attemptId,
      });
      return;
    }
    if (!this.journal) return;
    try {
      await this.journal.resolve(receipt.attemptId);
    } catch {
      await this.diagnostic({
        kind: 'journal_cleanup_failed',
        runId: receipt.runId,
        attemptId: receipt.attemptId,
      });
    }
  }

  private async diagnostic(
    record: Parameters<NonNullable<typeof this.onDiagnostic>>[0],
  ): Promise<void> {
    try {
      await this.onDiagnostic?.(Object.freeze(record));
    } catch {
      // Diagnostic failure cannot replace the durable completion result.
    }
  }
}
