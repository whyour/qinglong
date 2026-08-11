import { randomUUID } from 'crypto';
import {
  assertLocalExecutionControlLimit,
  normalizeLocalActiveExecutionCandidate,
  normalizeLocalExecutionControlCandidate,
  type LocalActiveExecutionCandidate,
  type LocalActiveExecutionCursor,
  type LocalExecutionControlCandidate,
  type LocalExecutionControlCursor,
  type LocalExecutionControlSource,
} from '@qinglong/runtime-core/local-execution-control';
import type {
  RunAttemptRecord,
  RunCancellationReason,
  RunEventRecord,
  RunRecord,
  RunRepository,
} from '@qinglong/runtime-core/run-repository';
import type {
  LocalProcessController,
  LocalProcessStopResult,
} from '@qinglong/local-process';
import type { LocalCompletionReceiptProcessor } from './completion';
import type { LocalWorkflowTaskExecutionRepository } from '../execution/workflowTaskExecution';

export const MAX_LOCAL_EXECUTION_CONTROL_PAGES = 16;

const ACTIVE_ATTEMPT_STATUSES = new Set(['claimed', 'starting', 'running']);
const ACTIVE_RUN_STATUSES = new Set(['dispatching', 'running']);
const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);

export type LocalExecutionControlDisposition =
  | 'terminal'
  | 'cancel_requested'
  | 'stale'
  | 'remaining';

export interface LocalExecutionControlCoordinatorOptions {
  readonly clock?: { now(): number };
  readonly createEventId?: () => string;
  readonly workflowTasks?: LocalWorkflowTaskExecutionRepository;
}

interface ActiveSnapshot {
  readonly run: RunRecord;
  readonly attempt: RunAttemptRecord;
}

class LocalExecutionControlConcurrentWriteError extends Error {}

function timestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function reserveEvent(run: RunRecord): Readonly<{
  run: RunRecord;
  sequence: number;
}> {
  const version = run.version + 1;
  const sequence = run.eventSequence + 1;
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(sequence)) {
    throw new RangeError(
      'Local execution control aggregate counter overflowed',
    );
  }
  return Object.freeze({
    run: { ...run, version, eventSequence: sequence },
    sequence,
  });
}

function atOrAfter(
  now: number,
  run: RunRecord,
  attempt?: RunAttemptRecord,
): number {
  return Math.max(
    timestamp(now, 'Local execution control observation'),
    run.createdAtMs,
    run.startedAtMs ?? 0,
    attempt?.createdAtMs ?? 0,
    attempt?.startedAtMs ?? 0,
  );
}

function event(
  id: string,
  run: RunRecord,
  attemptId: string,
  sequence: number,
  type: string,
  dedupeKey: string,
  payload: Readonly<Record<string, unknown>>,
  actorId: string,
  atMs: number,
): RunEventRecord {
  return {
    id,
    runId: run.id,
    attemptId,
    sequence,
    type,
    dedupeKey,
    actorType: 'reconciler',
    actorId,
    payload,
    createdAtMs: atMs,
  };
}

function terminalFor(reason: RunCancellationReason): Readonly<{
  status: 'cancelled' | 'timed_out';
  errorCode: string;
  errorSummary: string;
}> {
  return reason === 'timeout'
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

function conclusiveStop(result: LocalProcessStopResult): boolean {
  return result.status === 'stopped' || result.status === 'already_exited';
}

export class LocalExecutionControlCoordinator {
  private readonly clock: { now(): number };
  private readonly createEventId: () => string;
  private readonly workflowTasks:
    | LocalWorkflowTaskExecutionRepository
    | undefined;

  constructor(
    private readonly repository: RunRepository,
    private readonly completions: Pick<
      LocalCompletionReceiptProcessor,
      'process'
    >,
    private readonly controller: Pick<LocalProcessController, 'stop'>,
    options: LocalExecutionControlCoordinatorOptions = {},
  ) {
    this.clock = options.clock ?? { now: Date.now };
    this.createEventId = options.createEventId ?? randomUUID;
    this.workflowTasks = options.workflowTasks;
    if (
      this.workflowTasks !== undefined &&
      (typeof this.workflowTasks.requestTimeout !== 'function' ||
        typeof this.workflowTasks.recordControlTerminal !== 'function')
    ) {
      throw new TypeError(
        'Local Workflow Task execution control repository is invalid',
      );
    }
  }

  async process(
    value: LocalExecutionControlCandidate,
  ): Promise<LocalExecutionControlDisposition> {
    let candidate = normalizeLocalExecutionControlCandidate(value);
    if (candidate.kind === 'deadline') {
      const current = await this.loadActive(
        candidate.runId,
        candidate.attemptId,
      );
      if (!current) return 'stale';
      const requested =
        current.attempt.stepRunId === undefined
          ? await this.requestCancellation(
              candidate.runId,
              candidate.attemptId,
              'timeout',
              candidate.dueAtMs,
              true,
            )
          : this.workflowTasks === undefined
            ? false
            : (await this.workflowTasks.requestTimeout({
                run: current.run,
                attempt: current.attempt,
                dueAtMs: candidate.dueAtMs,
                eventId: this.createEventId(),
              })) !== 'stale';
      if (!requested) return 'stale';
      candidate = Object.freeze({
        kind: 'cancellation',
        runId: candidate.runId,
        attemptId: candidate.attemptId,
        dueAtMs: candidate.dueAtMs,
        cancelReason: 'timeout',
      });
    }

    const completion = await this.completions.process(candidate.attemptId);
    if (completion === 'completed' || completion === 'already_terminal') {
      return 'terminal';
    }
    if (completion === 'invalid') return 'remaining';

    const snapshot = await this.loadActive(
      candidate.runId,
      candidate.attemptId,
    );
    if (!snapshot) return 'stale';
    const reason =
      snapshot.attempt.stepRunId === undefined
        ? snapshot.run.cancelReason
        : snapshot.run.cancelRequestedAtMs === undefined
          ? candidate.cancelReason === 'timeout'
            ? 'timeout'
            : undefined
          : snapshot.run.cancelReason;
    if (reason === undefined) return 'stale';
    if (snapshot.attempt.status === 'claimed') {
      return (await this.markTerminal(snapshot, reason))
        ? 'terminal'
        : 'remaining';
    }
    if (!snapshot.attempt.executorHandle) return 'remaining';

    const stopped = await this.controller.stop(snapshot.attempt.executorHandle);
    const lateCompletion = await this.completions.process(candidate.attemptId);
    if (
      lateCompletion === 'completed' ||
      lateCompletion === 'already_terminal'
    ) {
      return 'terminal';
    }
    if (!conclusiveStop(stopped)) return 'remaining';
    return (await this.markTerminal(snapshot, reason))
      ? 'terminal'
      : 'remaining';
  }

  async requestShutdown(
    value: LocalActiveExecutionCandidate,
    requestedAtMs: number,
  ): Promise<LocalExecutionControlDisposition> {
    const candidate = normalizeLocalActiveExecutionCandidate(value);
    const current = await this.loadActive(candidate.runId, candidate.attemptId);
    if (!current) return 'stale';
    const reason = current.run.cancelReason ?? 'shutdown';
    if (current.run.cancelRequestedAtMs === undefined) {
      const requested = await this.requestCancellation(
        candidate.runId,
        candidate.attemptId,
        reason,
        requestedAtMs,
        false,
      );
      if (!requested) return 'stale';
    }
    return this.process({
      kind: 'cancellation',
      runId: candidate.runId,
      attemptId: candidate.attemptId,
      dueAtMs: current.run.cancelRequestedAtMs ?? requestedAtMs,
      cancelReason: reason,
    });
  }

  private loadActive(
    runId: string,
    attemptId: string,
  ): Promise<ActiveSnapshot | null> {
    return this.repository.transaction(async (transaction) => {
      const run = await transaction.findRunById(runId);
      const attempt = await transaction.findAttemptById(attemptId);
      if (
        !run ||
        !attempt ||
        attempt.runId !== run.id ||
        run.executionOwner !== 'runtime' ||
        !ACTIVE_RUN_STATUSES.has(run.status) ||
        !ACTIVE_ATTEMPT_STATUSES.has(attempt.status) ||
        attempt.executorType !== 'local_process'
      ) {
        return null;
      }
      if (attempt.stepRunId === undefined) {
        const latest = await transaction.findLatestAttemptByRunId(run.id);
        if (latest?.id !== attempt.id) return null;
      }
      return Object.freeze({ run, attempt });
    });
  }

  private requestCancellation(
    runId: string,
    attemptId: string,
    reason: RunCancellationReason,
    requestedAtMs: number,
    requireDeadline: boolean,
  ): Promise<boolean> {
    return this.repository.transaction(async (transaction) => {
      const run = await transaction.findRunById(runId);
      const attempt = await transaction.findAttemptById(attemptId);
      if (
        !run ||
        !attempt ||
        attempt.runId !== run.id ||
        run.executionOwner !== 'runtime' ||
        !ACTIVE_RUN_STATUSES.has(run.status) ||
        !ACTIVE_ATTEMPT_STATUSES.has(attempt.status) ||
        attempt.executorType !== 'local_process' ||
        (attempt.stepRunId === undefined &&
          (await transaction.findLatestAttemptByRunId(run.id))?.id !==
            attempt.id)
      ) {
        return false;
      }
      if (run.cancelRequestedAtMs !== undefined) {
        return run.cancelReason === reason;
      }
      const observedAtMs = timestamp(
        requestedAtMs,
        'Cancellation request time',
      );
      if (
        requireDeadline &&
        (attempt.deadlineAtMs === undefined ||
          attempt.deadlineAtMs > observedAtMs)
      ) {
        return false;
      }
      const atMs = atOrAfter(observedAtMs, run, attempt);
      const reserved = reserveEvent(run);
      const next: RunRecord = {
        ...reserved.run,
        cancelRequestedAtMs: atMs,
        cancelReason: reason,
      };
      if (!(await transaction.compareAndSetRun(next, run.version))) {
        throw new LocalExecutionControlConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          run,
          attempt.id,
          reserved.sequence,
          'run.cancel_requested',
          `local-control:${attempt.id}:${reason}:${run.version}`,
          Object.freeze({
            reason,
            from_status: run.status,
            version: next.version,
          }),
          requireDeadline ? 'local-deadline' : 'local-shutdown',
          atMs,
        ),
      );
      return true;
    });
  }

  private markTerminal(
    expected: ActiveSnapshot,
    reason: RunCancellationReason,
  ): Promise<boolean> {
    if (expected.attempt.stepRunId !== undefined) {
      if (!this.workflowTasks) return Promise.resolve(false);
      const terminal = terminalFor(reason);
      const atMs = atOrAfter(this.clock.now(), expected.run, expected.attempt);
      return this.workflowTasks
        .recordControlTerminal({
          run: expected.run,
          attempt: expected.attempt,
          reason,
          terminalStatus: terminal.status,
          errorCode: terminal.errorCode,
          errorSummary: terminal.errorSummary,
          finishedAtMs: atMs,
          attemptEventId: this.createEventId(),
          stepMutationId: this.createEventId(),
        })
        .then(
          (result) =>
            result === 'terminal' || result === 'already_terminal',
        );
    }
    return this.repository.transaction(async (transaction) => {
      const run = await transaction.findRunById(expected.run.id);
      const attempt = await transaction.findAttemptById(expected.attempt.id);
      if (
        !run ||
        !attempt ||
        run.version < expected.run.version ||
        attempt.runId !== run.id ||
        run.executionOwner !== 'runtime' ||
        !ACTIVE_RUN_STATUSES.has(run.status) ||
        !ACTIVE_ATTEMPT_STATUSES.has(attempt.status) ||
        attempt.callbackSequence !== expected.attempt.callbackSequence ||
        attempt.executorHandle !== expected.attempt.executorHandle ||
        attempt.pid !== expected.attempt.pid ||
        run.cancelRequestedAtMs === undefined ||
        run.cancelReason !== reason ||
        (await transaction.findLatestAttemptByRunId(run.id))?.id !== attempt.id
      ) {
        return TERMINAL_RUN_STATUSES.has(run?.status ?? 'created');
      }
      const terminal = terminalFor(reason);
      const atMs = atOrAfter(this.clock.now(), run, attempt);
      const attemptReserved = reserveEvent(run);
      const nextAttempt: RunAttemptRecord = {
        ...attempt,
        status: terminal.status,
        finishedAtMs: atMs,
        errorCode: terminal.errorCode,
        errorSummary: terminal.errorSummary,
      };
      if (
        !(await transaction.compareAndSetRun(attemptReserved.run, run.version))
      ) {
        throw new LocalExecutionControlConcurrentWriteError();
      }
      if (
        !(await transaction.compareAndSetAttempt(nextAttempt, {
          status: attempt.status,
          callbackSequence: attempt.callbackSequence,
        }))
      ) {
        throw new LocalExecutionControlConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          run,
          attempt.id,
          attemptReserved.sequence,
          `attempt.${terminal.status}`,
          `local-control:${attempt.id}:${attempt.callbackSequence}:attempt`,
          Object.freeze({
            attempt_id: attempt.id,
            from_status: attempt.status,
            to_status: terminal.status,
            reason,
            version: attemptReserved.run.version,
          }),
          'local-execution-control',
          atMs,
        ),
      );
      const runReserved = reserveEvent(attemptReserved.run);
      const nextRun: RunRecord = {
        ...runReserved.run,
        status: terminal.status,
        finishedAtMs: atMs,
        errorCode: terminal.errorCode,
        errorSummary: terminal.errorSummary,
      };
      if (
        !(await transaction.compareAndSetRun(
          nextRun,
          attemptReserved.run.version,
        ))
      ) {
        throw new LocalExecutionControlConcurrentWriteError();
      }
      await transaction.appendEvent(
        event(
          this.createEventId(),
          run,
          attempt.id,
          runReserved.sequence,
          `run.${terminal.status}`,
          `local-control:${attempt.id}:${attempt.callbackSequence}:run`,
          Object.freeze({
            from_status: run.status,
            to_status: terminal.status,
            reason,
            version: nextRun.version,
          }),
          'local-execution-control',
          atMs,
        ),
      );
      return true;
    });
  }
}

export interface LocalExecutionControlScanSummary {
  readonly scanned: number;
  readonly terminal: number;
  readonly cancelRequested: number;
  readonly stale: number;
  readonly remaining: number;
  readonly failed: number;
  readonly truncated: boolean;
  readonly nextCursor?: LocalExecutionControlCursor;
}

export interface LocalExecutionDrainSummary {
  readonly scanned: number;
  readonly terminal: number;
  readonly remaining: number;
  readonly failed: number;
  readonly truncated: boolean;
}

function controlCursor(candidate: LocalExecutionControlCandidate) {
  return Object.freeze({
    dueAtMs: candidate.dueAtMs,
    kind: candidate.kind,
    attemptId: candidate.attemptId,
  });
}

function controlAdvances(
  previous: LocalExecutionControlCursor,
  next: LocalExecutionControlCursor,
): boolean {
  return (
    next.dueAtMs > previous.dueAtMs ||
    (next.dueAtMs === previous.dueAtMs &&
      (next.kind > previous.kind ||
        (next.kind === previous.kind && next.attemptId > previous.attemptId)))
  );
}

function activeCursor(candidate: LocalActiveExecutionCandidate) {
  return Object.freeze({
    attemptCreatedAtMs: candidate.attemptCreatedAtMs,
    attemptId: candidate.attemptId,
  });
}

function activeAdvances(
  previous: LocalActiveExecutionCursor,
  next: LocalActiveExecutionCursor,
): boolean {
  return (
    next.attemptCreatedAtMs > previous.attemptCreatedAtMs ||
    (next.attemptCreatedAtMs === previous.attemptCreatedAtMs &&
      next.attemptId > previous.attemptId)
  );
}

export class LocalExecutionControlScanner {
  constructor(
    private readonly source: LocalExecutionControlSource,
    private readonly coordinator: Pick<
      LocalExecutionControlCoordinator,
      'process' | 'requestShutdown'
    >,
    private readonly clock: { now(): number } = { now: Date.now },
  ) {}

  async scan(options: {
    readonly limit: number;
    readonly cursor?: LocalExecutionControlCursor;
  }): Promise<LocalExecutionControlScanSummary> {
    assertLocalExecutionControlLimit(options.limit);
    const observedAtMs = timestamp(
      this.clock.now(),
      'Local execution control scan time',
    );
    const page = await this.source.listLocalExecutionControlCandidates({
      observedAtMs,
      limit: options.limit,
      ...(options.cursor === undefined ? {} : { after: options.cursor }),
    });
    if (page.candidates.length > options.limit) {
      throw new RangeError('Local execution control source exceeded page size');
    }
    let previous = options.cursor;
    let terminal = 0;
    let cancelRequested = 0;
    let stale = 0;
    let remaining = 0;
    let failed = 0;
    for (const value of page.candidates) {
      const candidate = normalizeLocalExecutionControlCandidate(value);
      const cursor = controlCursor(candidate);
      if (previous && !controlAdvances(previous, cursor)) {
        throw new TypeError(
          'Local execution control page is not strictly ordered',
        );
      }
      previous = cursor;
      try {
        const disposition = await this.coordinator.process(candidate);
        if (disposition === 'terminal') terminal += 1;
        if (disposition === 'cancel_requested') cancelRequested += 1;
        if (disposition === 'stale') stale += 1;
        if (disposition === 'remaining') remaining += 1;
      } catch {
        failed += 1;
      }
    }
    if (page.truncated && page.candidates.length === 0) {
      throw new TypeError(
        'Local execution control source returned an empty truncated page',
      );
    }
    return Object.freeze({
      scanned: page.candidates.length,
      terminal,
      cancelRequested,
      stale,
      remaining,
      failed,
      truncated: page.truncated,
      ...(page.truncated && previous ? { nextCursor: previous } : {}),
    });
  }

  async drain(options: {
    readonly limit: number;
    readonly maxPages: number;
  }): Promise<LocalExecutionDrainSummary> {
    assertLocalExecutionControlLimit(options.limit);
    if (
      !Number.isSafeInteger(options.maxPages) ||
      options.maxPages < 1 ||
      options.maxPages > MAX_LOCAL_EXECUTION_CONTROL_PAGES
    ) {
      throw new RangeError('Local execution drain page budget is invalid');
    }
    const requestedAtMs = timestamp(
      this.clock.now(),
      'Local execution drain time',
    );
    let cursor: LocalActiveExecutionCursor | undefined;
    let scanned = 0;
    let terminal = 0;
    let remaining = 0;
    let failed = 0;
    let truncated = false;
    for (let pageIndex = 0; pageIndex < options.maxPages; pageIndex += 1) {
      const page = await this.source.listLocalActiveExecutions({
        limit: options.limit,
        ...(cursor === undefined ? {} : { after: cursor }),
      });
      if (page.candidates.length > options.limit) {
        throw new RangeError(
          'Local active execution source exceeded page size',
        );
      }
      let previous = cursor;
      for (const value of page.candidates) {
        const candidate = normalizeLocalActiveExecutionCandidate(value);
        const next = activeCursor(candidate);
        if (previous && !activeAdvances(previous, next)) {
          throw new TypeError(
            'Local active execution page is not strictly ordered',
          );
        }
        previous = next;
        scanned += 1;
        try {
          const disposition = await this.coordinator.requestShutdown(
            candidate,
            requestedAtMs,
          );
          if (disposition === 'terminal' || disposition === 'stale')
            terminal += 1;
          else remaining += 1;
        } catch {
          failed += 1;
        }
      }
      truncated = page.truncated;
      if (!page.truncated) break;
      if (!previous) {
        throw new TypeError(
          'Local active execution source returned an empty truncated page',
        );
      }
      cursor = previous;
    }
    return Object.freeze({
      scanned,
      terminal,
      remaining,
      failed,
      truncated,
    });
  }
}
