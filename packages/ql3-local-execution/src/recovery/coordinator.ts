import { randomUUID } from 'crypto';
import type {
  LocalRunStartupRecoveryCandidate,
  LocalRunStartupRecoveryPage,
  LocalRunStartupRecoverySource,
} from '@qinglong/runtime-core/local-startup-recovery';
import type {
  RunAttemptRecord,
  RunEventRecord,
  RunRecord,
  RunRepository,
  RunRepositoryTransaction,
} from '@qinglong/runtime-core/run-repository';
import type { LocalCompletionReceiptJournal } from '@qinglong/runtime-core/local-completion-receipt-journal';
import { LocalCompletionReceiptProcessor } from '../control/completion';
import {
  type CompletionReceiptStore,
  type LocalPersistedExecutionInspection,
  type LocalPersistedExecutionInspector,
} from '@qinglong/local-process';

export const MAX_LOCAL_RUN_RECOVERY_ITEMS = 256;
export const MAX_LOCAL_RUN_RECEIPT_GRACE_MS = 5_000;
export const MAX_LOCAL_RUN_QUARANTINE_RETENTION_MS = 24 * 60 * 60_000;

const ACTIVE_ATTEMPT_STATUSES = new Set(['claimed', 'starting', 'running']);
const PAGE_KEYS = Object.freeze(['candidates', 'truncated']);
const CANDIDATE_KEYS = Object.freeze([
  'activeAttemptCount',
  'runId',
  'runStatus',
]);

export interface LocalRunStartupRecoverySummary {
  readonly safe: boolean;
  readonly scanned: number;
  readonly recovered: number;
  readonly remaining: number;
  readonly failed: number;
  readonly truncated: boolean;
}

export interface LocalRunStartupRecoveryCoordinatorOptions {
  readonly receiptPublishGraceMs?: number;
  readonly clock?: { now(): number };
  readonly wait?: (delayMs: number) => Promise<void>;
  readonly createEventId?: () => string;
  readonly journal?: Pick<
    LocalCompletionReceiptJournal,
    'markQuarantined' | 'resolve'
  >;
  readonly quarantineRetentionMs?: number;
  readonly completionProcessor?: Pick<
    LocalCompletionReceiptProcessor,
    'process'
  >;
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
}

type CandidateDisposition =
  | Readonly<{ status: 'recovered' }>
  | Readonly<{ status: 'verified'; fingerprint: VerifiedFingerprint }>
  | Readonly<{ status: 'remaining' }>
  | Readonly<{ status: 'failed' }>;

interface AggregateSnapshot {
  readonly run: RunRecord;
  readonly attempt: RunAttemptRecord | null;
}

interface VerifiedFingerprint {
  readonly runId: string;
  readonly runStatus: 'running';
  readonly runVersion: number;
  readonly attemptId: string;
  readonly attemptStatus: 'running';
  readonly callbackSequence: number;
  readonly executorHandle: string;
  readonly pid: number;
}

interface EventDraft {
  readonly sequence: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

class LocalRunRecoveryConcurrentWriteError extends Error {}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function assertSafeTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function validatePage(value: unknown): LocalRunStartupRecoveryPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Local Run recovery page is invalid');
  }
  const page = value as unknown as Record<string, unknown>;
  if (
    !exactKeys(page, PAGE_KEYS) ||
    !Array.isArray(page.candidates) ||
    page.candidates.length > MAX_LOCAL_RUN_RECOVERY_ITEMS ||
    typeof page.truncated !== 'boolean'
  ) {
    throw new TypeError('Local Run recovery page shape or bounds are invalid');
  }
  const candidates: LocalRunStartupRecoveryCandidate[] = [];
  const runIds = new Set<string>();
  for (const value of page.candidates) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Local Run recovery candidate is invalid');
    }
    const candidate = value as Record<string, unknown>;
    if (
      !exactKeys(candidate, CANDIDATE_KEYS) ||
      typeof candidate.runId !== 'string' ||
      candidate.runId.length < 1 ||
      candidate.runId.length > 128 ||
      /[\0\r\n]/.test(candidate.runId) ||
      (candidate.runStatus !== 'dispatching' &&
        candidate.runStatus !== 'running') ||
      !Number.isSafeInteger(candidate.activeAttemptCount) ||
      (candidate.activeAttemptCount as number) < 0 ||
      (candidate.activeAttemptCount as number) > MAX_LOCAL_RUN_RECOVERY_ITEMS ||
      runIds.has(candidate.runId)
    ) {
      throw new TypeError('Local Run recovery candidate fields are invalid');
    }
    runIds.add(candidate.runId);
    candidates.push(
      Object.freeze({
        runId: candidate.runId,
        runStatus: candidate.runStatus,
        activeAttemptCount: candidate.activeAttemptCount as number,
      }),
    );
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    truncated: page.truncated,
  });
}

function reserveEvent(run: RunRecord): Readonly<{
  run: RunRecord;
  sequence: number;
}> {
  const version = run.version + 1;
  const sequence = run.eventSequence + 1;
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1
  ) {
    throw new TypeError('Local Run recovery version or sequence overflowed');
  }
  return Object.freeze({
    run: { ...run, version, eventSequence: sequence },
    sequence,
  });
}

function event(
  id: string,
  runId: string,
  attemptId: string | undefined,
  draft: EventDraft,
  dedupeKey: string,
  actorType: RunEventRecord['actorType'],
  actorId: string,
  atMs: number,
): RunEventRecord {
  return {
    id,
    runId,
    sequence: draft.sequence,
    type: draft.type,
    dedupeKey,
    actorType,
    actorId,
    ...(attemptId === undefined ? {} : { attemptId }),
    payload: draft.payload,
    createdAtMs: atMs,
  };
}

function atOrAfter(
  now: number,
  run: RunRecord,
  attempt?: RunAttemptRecord,
): number {
  assertSafeTimestamp(now, 'Local Run recovery observation');
  return Math.max(
    now,
    run.createdAtMs,
    run.startedAtMs ?? 0,
    attempt?.createdAtMs ?? 0,
    attempt?.startedAtMs ?? 0,
  );
}

function fingerprint(snapshot: AggregateSnapshot): VerifiedFingerprint {
  const { run, attempt } = snapshot;
  if (
    run.status !== 'running' ||
    !attempt ||
    attempt.status !== 'running' ||
    attempt.executorType !== 'local_process' ||
    !attempt.executorHandle ||
    !Number.isSafeInteger(attempt.pid) ||
    (attempt.pid as number) < 1
  ) {
    throw new TypeError('Verified local Run snapshot is not running');
  }
  return Object.freeze({
    runId: run.id,
    runStatus: 'running',
    runVersion: run.version,
    attemptId: attempt.id,
    attemptStatus: 'running',
    callbackSequence: attempt.callbackSequence,
    executorHandle: attempt.executorHandle,
    pid: attempt.pid as number,
  });
}

function sameFingerprint(
  expected: VerifiedFingerprint,
  snapshot: AggregateSnapshot,
): boolean {
  const attempt = snapshot.attempt;
  return (
    snapshot.run.id === expected.runId &&
    snapshot.run.status === expected.runStatus &&
    snapshot.run.version === expected.runVersion &&
    attempt?.id === expected.attemptId &&
    attempt.status === expected.attemptStatus &&
    attempt.callbackSequence === expected.callbackSequence &&
    attempt.executorHandle === expected.executorHandle &&
    attempt.pid === expected.pid
  );
}

/**
 * One bounded startup coordinator. It never scans receipt directories, starts
 * an Executor, or treats missing/invalid evidence as proof of process exit.
 */
export class LocalRunStartupRecoveryCoordinator {
  private readonly clock: { now(): number };
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly receiptPublishGraceMs: number;
  private readonly createEventId: () => string;
  private readonly journal?: LocalRunStartupRecoveryCoordinatorOptions['journal'];
  private readonly quarantineRetentionMs: number;
  private readonly onDiagnostic?: LocalRunStartupRecoveryCoordinatorOptions['onDiagnostic'];
  private readonly completionProcessor: Pick<
    LocalCompletionReceiptProcessor,
    'process'
  >;

  constructor(
    private readonly repository: RunRepository,
    private readonly source: LocalRunStartupRecoverySource,
    receipts: CompletionReceiptStore,
    private readonly inspector: LocalPersistedExecutionInspector,
    options: LocalRunStartupRecoveryCoordinatorOptions = {},
  ) {
    this.clock = options.clock ?? { now: Date.now };
    this.wait =
      options.wait ??
      ((delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.receiptPublishGraceMs = options.receiptPublishGraceMs ?? 0;
    if (
      !Number.isSafeInteger(this.receiptPublishGraceMs) ||
      this.receiptPublishGraceMs < 0 ||
      this.receiptPublishGraceMs > MAX_LOCAL_RUN_RECEIPT_GRACE_MS
    ) {
      throw new RangeError(
        `receiptPublishGraceMs must be between 0 and ${MAX_LOCAL_RUN_RECEIPT_GRACE_MS}`,
      );
    }
    if (inspector.executorType !== 'local_process') {
      throw new TypeError('Local Run recovery inspector type is invalid');
    }
    this.createEventId = options.createEventId ?? randomUUID;
    this.journal = options.journal;
    this.quarantineRetentionMs = options.quarantineRetentionMs ?? 60 * 60_000;
    if (
      !Number.isSafeInteger(this.quarantineRetentionMs) ||
      this.quarantineRetentionMs < 0 ||
      this.quarantineRetentionMs > MAX_LOCAL_RUN_QUARANTINE_RETENTION_MS
    ) {
      throw new RangeError(
        `quarantineRetentionMs must be between 0 and ${MAX_LOCAL_RUN_QUARANTINE_RETENTION_MS}`,
      );
    }
    this.onDiagnostic = options.onDiagnostic;
    this.completionProcessor =
      options.completionProcessor ??
      new LocalCompletionReceiptProcessor(repository, receipts, {
        clock: this.clock,
        createEventId: this.createEventId,
        ...(this.journal === undefined ? {} : { journal: this.journal }),
        quarantineRetentionMs: this.quarantineRetentionMs,
        ...(this.onDiagnostic === undefined
          ? {}
          : { onDiagnostic: this.onDiagnostic }),
      });
  }

  async recover(): Promise<LocalRunStartupRecoverySummary> {
    const initial = validatePage(
      await this.source.inspectCandidates({
        limit: MAX_LOCAL_RUN_RECOVERY_ITEMS,
      }),
    );
    if (initial.truncated) {
      return Object.freeze({
        safe: false,
        scanned: initial.candidates.length,
        recovered: 0,
        remaining: initial.candidates.length,
        failed: 0,
        truncated: true,
      });
    }
    if (initial.candidates.length === 0) {
      return Object.freeze({
        safe: true,
        scanned: 0,
        recovered: 0,
        remaining: 0,
        failed: 0,
        truncated: false,
      });
    }

    let recovered = 0;
    let remaining = 0;
    let failed = 0;
    const verified = new Map<string, VerifiedFingerprint>();
    for (const candidate of initial.candidates) {
      const disposition = await this.reconcile(candidate);
      if (disposition.status === 'recovered') recovered += 1;
      if (disposition.status === 'verified') {
        recovered += 1;
        verified.set(candidate.runId, disposition.fingerprint);
      }
      if (disposition.status === 'remaining') remaining += 1;
      if (disposition.status === 'failed') failed += 1;
    }

    if (remaining === 0 && failed === 0) {
      const final = await this.verify(verified);
      if (final.remaining > 0 || final.failed > 0) {
        const unresolved = Math.min(
          initial.candidates.length,
          Math.max(1, final.remaining + final.failed),
        );
        recovered = Math.max(0, recovered - unresolved);
        failed = Math.min(unresolved, final.failed);
        remaining = unresolved - failed;
      }
    }
    return Object.freeze({
      safe: remaining === 0 && failed === 0,
      scanned: initial.candidates.length,
      recovered,
      remaining,
      failed,
      truncated: false,
    });
  }

  private async reconcile(
    candidate: LocalRunStartupRecoveryCandidate,
  ): Promise<CandidateDisposition> {
    try {
      if (candidate.activeAttemptCount > 1) {
        return Object.freeze({ status: 'remaining' });
      }
      let snapshot = await this.load(candidate.runId);
      if (
        !snapshot ||
        snapshot.run.executionOwner !== 'runtime' ||
        snapshot.run.status !== candidate.runStatus
      ) {
        return Object.freeze({ status: 'remaining' });
      }
      const attempt = snapshot.attempt;
      if (candidate.activeAttemptCount === 0) {
        if (snapshot.run.status !== 'dispatching' || attempt !== null) {
          return Object.freeze({ status: 'remaining' });
        }
        return (await this.markRunLostWithoutAttempt(snapshot.run))
          ? Object.freeze({ status: 'recovered' })
          : Object.freeze({ status: 'remaining' });
      }
      if (
        !attempt ||
        !ACTIVE_ATTEMPT_STATUSES.has(attempt.status) ||
        attempt.runId !== snapshot.run.id
      ) {
        return Object.freeze({ status: 'remaining' });
      }

      const completion = await this.completionProcessor.process(attempt.id);
      if (completion === 'completed' || completion === 'already_terminal') {
        return Object.freeze({ status: 'recovered' });
      }
      if (completion === 'invalid')
        return Object.freeze({ status: 'remaining' });
      if (attempt.status === 'claimed') {
        return (await this.markAggregateLost(snapshot, 'unstarted_claim'))
          ? Object.freeze({ status: 'recovered' })
          : Object.freeze({ status: 'remaining' });
      }
      if (
        attempt.executorType !== 'local_process' ||
        !attempt.executorHandle ||
        !Number.isSafeInteger(attempt.pid) ||
        (attempt.pid as number) < 1
      ) {
        return Object.freeze({ status: 'remaining' });
      }

      const inspection = await this.inspector.inspect(attempt.executorHandle);
      if (inspection.status === 'unknown') {
        return inspection.reason === 'provider_unavailable'
          ? Object.freeze({ status: 'failed' })
          : Object.freeze({ status: 'remaining' });
      }
      if (inspection.identityPid !== attempt.pid) {
        return Object.freeze({ status: 'remaining' });
      }
      if (inspection.status === 'running') {
        snapshot = await this.markObservedRunning(snapshot);
        return snapshot
          ? Object.freeze({
              status: 'verified',
              fingerprint: fingerprint(snapshot),
            })
          : Object.freeze({ status: 'remaining' });
      }

      if (this.receiptPublishGraceMs > 0) {
        await this.wait(this.receiptPublishGraceMs);
        const delayed = await this.load(candidate.runId);
        if (!delayed || !delayed.attempt || delayed.attempt.id !== attempt.id) {
          return Object.freeze({ status: 'remaining' });
        }
        const lateCompletion = await this.completionProcessor.process(
          attempt.id,
        );
        if (lateCompletion === 'invalid') {
          return Object.freeze({ status: 'remaining' });
        }
        if (
          lateCompletion === 'completed' ||
          lateCompletion === 'already_terminal'
        ) {
          return Object.freeze({ status: 'recovered' });
        }
        snapshot = delayed;
      }
      return (await this.markAggregateLost(snapshot, 'process_not_running'))
        ? Object.freeze({ status: 'recovered' })
        : Object.freeze({ status: 'remaining' });
    } catch {
      return Object.freeze({ status: 'failed' });
    }
  }

  private async verify(
    verified: ReadonlyMap<string, VerifiedFingerprint>,
  ): Promise<Readonly<{ remaining: number; failed: number }>> {
    let remaining = 0;
    let failed = 0;
    let page: LocalRunStartupRecoveryPage;
    try {
      page = validatePage(
        await this.source.inspectCandidates({
          limit: MAX_LOCAL_RUN_RECOVERY_ITEMS,
        }),
      );
    } catch {
      return Object.freeze({ remaining: 0, failed: 1 });
    }
    if (page.truncated) {
      return Object.freeze({
        remaining: page.candidates.length,
        failed: 0,
      });
    }
    for (const candidate of page.candidates) {
      const expected = verified.get(candidate.runId);
      if (!expected || candidate.activeAttemptCount !== 1) {
        remaining += 1;
        continue;
      }
      try {
        const completion = await this.completionProcessor.process(
          expected.attemptId,
        );
        if (completion === 'completed' || completion === 'already_terminal') {
          continue;
        }
        if (completion === 'invalid') {
          remaining += 1;
          continue;
        }
        const snapshot = await this.load(candidate.runId);
        if (!snapshot || !sameFingerprint(expected, snapshot)) {
          remaining += 1;
          continue;
        }
        const inspection = await this.inspector.inspect(
          expected.executorHandle,
        );
        if (
          inspection.status !== 'running' ||
          inspection.identityPid !== expected.pid
        ) {
          remaining += 1;
        }
      } catch {
        failed += 1;
      }
    }
    return Object.freeze({ remaining, failed });
  }

  private load(runId: string): Promise<AggregateSnapshot | null> {
    return this.repository.transaction(async (transaction) => {
      const run = await transaction.findRunById(runId);
      if (!run) return null;
      const attempt = await transaction.findLatestAttemptByRunId(runId);
      return Object.freeze({ run, attempt });
    });
  }

  private async markRunLostWithoutAttempt(run: RunRecord): Promise<boolean> {
    return this.repository.transaction(async (transaction) => {
      const current = await transaction.findRunById(run.id);
      if (
        !current ||
        current.version !== run.version ||
        current.status !== 'dispatching' ||
        current.executionOwner !== 'runtime' ||
        (await transaction.findLatestAttemptByRunId(run.id)) !== null
      ) {
        return false;
      }
      const atMs = atOrAfter(this.clock.now(), current);
      const reserved = reserveEvent(current);
      const next: RunRecord = {
        ...reserved.run,
        status: 'lost',
        errorCode: 'RECOVERY_ATTEMPT_MISSING_BEFORE_START',
        errorSummary: 'Dispatching Run has no durable Attempt',
      };
      if (!(await transaction.compareAndSetRun(next, current.version))) {
        throw new LocalRunRecoveryConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          current.id,
          undefined,
          {
            sequence: reserved.sequence,
            type: 'run.lost',
            payload: Object.freeze({
              from_status: current.status,
              to_status: 'lost',
              error_code: next.errorCode,
              version: next.version,
            }),
          },
          `local-recovery:run:${current.id}:${current.version}:missing-attempt`,
          'reconciler',
          'local-startup',
          atMs,
        ),
      );
      return true;
    });
  }

  private async markAggregateLost(
    expected: AggregateSnapshot,
    reason: 'unstarted_claim' | 'process_not_running',
  ): Promise<boolean> {
    return this.repository.transaction(async (transaction) => {
      const current = await this.reloadExact(transaction, expected);
      if (!current || !current.attempt) return false;
      const { run, attempt } = current;
      if (
        run.cancelRequestedAtMs !== undefined ||
        !ACTIVE_ATTEMPT_STATUSES.has(attempt.status) ||
        (reason === 'unstarted_claim' && attempt.status !== 'claimed') ||
        (reason === 'process_not_running' &&
          attempt.status !== 'starting' &&
          attempt.status !== 'running')
      ) {
        return false;
      }
      const errorCode =
        reason === 'unstarted_claim'
          ? 'RECOVERY_UNSTARTED_CLAIM'
          : 'RECOVERY_PROCESS_NOT_RUNNING';
      const errorSummary =
        reason === 'unstarted_claim'
          ? 'Claimed Attempt never crossed the start barrier'
          : 'Durable process identity proves the execution is not running';
      const atMs = atOrAfter(this.clock.now(), run, attempt);
      const attemptReserved = reserveEvent(run);
      const nextAttempt: RunAttemptRecord = {
        ...attempt,
        status: 'lost',
        finishedAtMs: atMs,
        errorCode,
        errorSummary,
      };
      await this.persistRunAndAttempt(
        transaction,
        run,
        attempt,
        attemptReserved.run,
        nextAttempt,
      );
      await transaction.appendEvent(
        event(
          this.createEventId(),
          run.id,
          attempt.id,
          {
            sequence: attemptReserved.sequence,
            type: 'attempt.lost',
            payload: Object.freeze({
              attempt_id: attempt.id,
              from_status: attempt.status,
              to_status: 'lost',
              error_code: errorCode,
              version: attemptReserved.run.version,
            }),
          },
          `local-recovery:attempt:${attempt.id}:${attempt.callbackSequence}:${reason}`,
          'reconciler',
          'local-startup',
          atMs,
        ),
      );
      const runReserved = reserveEvent(attemptReserved.run);
      const nextRun: RunRecord = {
        ...runReserved.run,
        status: 'lost',
        errorCode,
        errorSummary,
      };
      if (
        !(await transaction.compareAndSetRun(
          nextRun,
          attemptReserved.run.version,
        ))
      ) {
        throw new LocalRunRecoveryConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          run.id,
          attempt.id,
          {
            sequence: runReserved.sequence,
            type: 'run.lost',
            payload: Object.freeze({
              from_status: run.status,
              to_status: 'lost',
              error_code: errorCode,
              version: nextRun.version,
            }),
          },
          `local-recovery:run:${run.id}:${attempt.id}:${run.version}:${reason}`,
          'reconciler',
          'local-startup',
          atMs,
        ),
      );
      return true;
    });
  }

  private async markObservedRunning(
    expected: AggregateSnapshot,
  ): Promise<AggregateSnapshot | null> {
    return this.repository.transaction(async (transaction) => {
      const current = await this.reloadExact(transaction, expected);
      if (!current || !current.attempt) return null;
      let { run, attempt } = current;
      const originalRunStatus = run.status;
      const atMs = atOrAfter(this.clock.now(), run, attempt);
      if (attempt.status === 'starting') {
        const reserved = reserveEvent(run);
        const nextAttempt: RunAttemptRecord = {
          ...attempt,
          status: 'running',
          startedAtMs: attempt.startedAtMs ?? atMs,
        };
        await this.persistRunAndAttempt(
          transaction,
          run,
          attempt,
          reserved.run,
          nextAttempt,
        );
        await transaction.appendEvent(
          event(
            this.createEventId(),
            run.id,
            attempt.id,
            {
              sequence: reserved.sequence,
              type: 'attempt.running',
              payload: Object.freeze({
                attempt_id: attempt.id,
                from_status: attempt.status,
                to_status: 'running',
                evidence: 'durable_process_identity',
                version: reserved.run.version,
              }),
            },
            `local-recovery:attempt:${attempt.id}:${attempt.callbackSequence}:running`,
            'reconciler',
            'local-startup',
            atMs,
          ),
        );
        run = reserved.run;
        attempt = nextAttempt;
      }
      if (run.status === 'dispatching') {
        const reserved = reserveEvent(run);
        const nextRun: RunRecord = {
          ...reserved.run,
          status: 'running',
          startedAtMs: run.startedAtMs ?? atMs,
        };
        if (!(await transaction.compareAndSetRun(nextRun, run.version))) {
          throw new LocalRunRecoveryConcurrentWriteError();
        }
        await transaction.appendEvent(
          event(
            this.createEventId(),
            run.id,
            attempt.id,
            {
              sequence: reserved.sequence,
              type: 'run.running',
              payload: Object.freeze({
                from_status: originalRunStatus,
                to_status: 'running',
                evidence: 'durable_process_identity',
                version: nextRun.version,
              }),
            },
            `local-recovery:run:${run.id}:${attempt.id}:${run.version}:running`,
            'reconciler',
            'local-startup',
            atMs,
          ),
        );
        run = nextRun;
      }
      if (run.status !== 'running' || attempt.status !== 'running') return null;
      return Object.freeze({ run, attempt });
    });
  }

  private async reloadExact(
    transaction: RunRepositoryTransaction,
    expected: AggregateSnapshot,
  ): Promise<AggregateSnapshot | null> {
    const run = await transaction.findRunById(expected.run.id);
    const expectedAttempt = expected.attempt;
    if (!run || run.version !== expected.run.version) return null;
    if (!expectedAttempt) {
      return Object.freeze({ run, attempt: null });
    }
    const attempt = await transaction.findAttemptById(expectedAttempt.id);
    if (
      !attempt ||
      attempt.runId !== run.id ||
      attempt.status !== expectedAttempt.status ||
      attempt.callbackSequence !== expectedAttempt.callbackSequence ||
      attempt.executorHandle !== expectedAttempt.executorHandle ||
      attempt.pid !== expectedAttempt.pid
    ) {
      return null;
    }
    return Object.freeze({ run, attempt });
  }

  private async persistRunAndAttempt(
    transaction: RunRepositoryTransaction,
    run: RunRecord,
    attempt: RunAttemptRecord,
    nextRun: RunRecord,
    nextAttempt: RunAttemptRecord,
  ): Promise<void> {
    if (!(await transaction.compareAndSetRun(nextRun, run.version))) {
      throw new LocalRunRecoveryConcurrentWriteError();
    }
    if (
      !(await transaction.compareAndSetAttempt(nextAttempt, {
        status: attempt.status,
        callbackSequence: attempt.callbackSequence,
      }))
    ) {
      throw new LocalRunRecoveryConcurrentWriteError();
    }
  }
}
