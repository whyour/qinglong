import { createHash, timingSafeEqual } from 'crypto';
import { v7 as uuidV7 } from 'uuid';
import type { ExecutionOutcome, ExecutionResult } from '../domain/execution';
import type {
  RunAttemptRecord,
  RunEventRecord,
  RunRecord,
  RunStatus,
} from '../domain/run';
import {
  isTerminalRunAttemptStatus,
  transitionRun,
  transitionRunAttempt,
  type RunDomainEventDraft,
} from '../domain/runStateMachine';
import type { RunRepository } from '../ports/runRepository';

interface TerminalMapping {
  attemptStatus: Exclude<
    RunAttemptRecord['status'],
    'claimed' | 'starting' | 'running'
  >;
  runStatus: Exclude<
    RunStatus,
    | 'created'
    | 'queued'
    | 'dispatching'
    | 'running'
    | 'waiting_approval'
    | 'retry_wait'
  >;
  errorCode?: string;
  errorSummary?: string;
}

const TERMINAL_MAPPING: Readonly<Record<ExecutionOutcome, TerminalMapping>> = {
  succeeded: {
    attemptStatus: 'succeeded',
    runStatus: 'succeeded',
  },
  failed: {
    attemptStatus: 'failed',
    runStatus: 'failed',
    errorCode: 'EXECUTION_FAILED',
    errorSummary: 'Execution completed without success',
  },
  cancelled: {
    attemptStatus: 'cancelled',
    runStatus: 'cancelled',
    errorCode: 'EXECUTION_CANCELLED',
    errorSummary: 'Execution was cancelled',
  },
  timed_out: {
    attemptStatus: 'timed_out',
    runStatus: 'timed_out',
    errorCode: 'EXECUTION_TIMED_OUT',
    errorSummary: 'Execution exceeded its configured timeout',
  },
  lost: {
    attemptStatus: 'lost',
    runStatus: 'lost',
    errorCode: 'EXECUTION_LOST',
    errorSummary: 'Execution ownership was lost',
  },
};

export const MAX_PRIMARY_COMPLETION_RETRIES = 4;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export type PrimaryCompletionSource =
  | { kind: 'executor'; executorType: string }
  | { kind: 'receipt'; token: string };

export interface PrimaryRunCompletionCommand {
  runId: string;
  attemptId: string;
  callbackSequence: number;
  result: ExecutionResult;
  source: PrimaryCompletionSource;
}

export interface PrimaryRunCompletionResult {
  status: 'applied' | 'already_terminal';
  run: RunRecord;
  attempt: RunAttemptRecord;
  result: ExecutionResult;
}

export type PrimaryCompletionEventIdFactory = () => string;

export class PrimaryCompletionNotFoundError extends Error {
  constructor() {
    super('Primary completion target was not found');
    this.name = 'PrimaryCompletionNotFoundError';
  }
}

export class PrimaryCompletionUnauthorizedError extends Error {
  constructor() {
    super('Primary completion source is not authorized');
    this.name = 'PrimaryCompletionUnauthorizedError';
  }
}

export class PrimaryCompletionSequenceError extends Error {
  constructor() {
    super('Primary completion callback sequence is invalid');
    this.name = 'PrimaryCompletionSequenceError';
  }
}

export class PrimaryCompletionStateError extends Error {
  constructor() {
    super('Primary completion target state is inconsistent');
    this.name = 'PrimaryCompletionStateError';
  }
}

class PrimaryCompletionConcurrentWriteError extends Error {}

export function hashPrimaryCompletionToken(token: string): string {
  if (!TOKEN_PATTERN.test(token)) {
    throw new TypeError('Primary completion token is invalid');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function validateResult(result: ExecutionResult): void {
  if (!Object.hasOwn(TERMINAL_MAPPING, result.outcome)) {
    throw new TypeError('Primary completion outcome is invalid');
  }
  if (
    !Number.isSafeInteger(result.startedAtMs) ||
    result.startedAtMs < 0 ||
    !Number.isSafeInteger(result.finishedAtMs) ||
    result.finishedAtMs < result.startedAtMs
  ) {
    throw new TypeError('Primary completion timestamps are invalid');
  }
  if (
    result.exitCode !== undefined &&
    (!Number.isInteger(result.exitCode) ||
      result.exitCode < 0 ||
      result.exitCode > 255)
  ) {
    throw new TypeError('Primary completion exitCode is invalid');
  }
}

function mappingFor(run: RunRecord, result: ExecutionResult): TerminalMapping {
  if (run.cancelRequestedAtMs !== undefined) {
    return run.cancelReason === 'timeout'
      ? TERMINAL_MAPPING.timed_out
      : TERMINAL_MAPPING.cancelled;
  }
  return TERMINAL_MAPPING[result.outcome];
}

function sameTerminalState(
  run: RunRecord,
  attempt: RunAttemptRecord,
  mapping: TerminalMapping,
): boolean {
  return (
    attempt.status === mapping.attemptStatus && run.status === mapping.runStatus
  );
}

function authorize(
  run: RunRecord,
  attempt: RunAttemptRecord,
  source: PrimaryCompletionSource,
): void {
  if (run.executionOwner !== 'runtime') {
    throw new PrimaryCompletionUnauthorizedError();
  }
  if (source.kind === 'executor') {
    if (!source.executorType || attempt.executorType !== source.executorType) {
      throw new PrimaryCompletionUnauthorizedError();
    }
    return;
  }

  let actualHash: string;
  try {
    actualHash = hashPrimaryCompletionToken(source.token);
  } catch {
    throw new PrimaryCompletionUnauthorizedError();
  }
  const expectedHash = attempt.callbackTokenHash;
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new PrimaryCompletionUnauthorizedError();
  }
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(actualHash, 'hex');
  if (!timingSafeEqual(expected, actual)) {
    throw new PrimaryCompletionUnauthorizedError();
  }
}

/**
 * The only terminal completion transaction for both live Executor callbacks
 * and durable receipt replay. Attempt, Run and both events commit atomically.
 */
export class PrimaryRunCompletionService {
  constructor(
    private readonly repository: RunRepository,
    private readonly createEventId: PrimaryCompletionEventIdFactory = uuidV7,
  ) {}

  async complete(
    command: PrimaryRunCompletionCommand,
  ): Promise<PrimaryRunCompletionResult> {
    if (
      !Number.isSafeInteger(command.callbackSequence) ||
      command.callbackSequence < 1
    ) {
      throw new PrimaryCompletionSequenceError();
    }
    validateResult(command.result);

    for (let retry = 0; retry <= MAX_PRIMARY_COMPLETION_RETRIES; retry += 1) {
      try {
        return await this.repository.transaction(async (transaction) => {
          const run = await transaction.findRunById(command.runId);
          const attempt = await transaction.findAttemptById(command.attemptId);
          if (!run || !attempt || attempt.runId !== run.id) {
            throw new PrimaryCompletionNotFoundError();
          }
          authorize(run, attempt, command.source);
          const mapping = mappingFor(run, command.result);

          if (isTerminalRunAttemptStatus(attempt.status)) {
            if (attempt.callbackSequence !== command.callbackSequence) {
              throw new PrimaryCompletionSequenceError();
            }
            if (!sameTerminalState(run, attempt, mapping)) {
              throw new PrimaryCompletionStateError();
            }
            return {
              status: 'already_terminal',
              run,
              attempt,
              result: command.result,
            };
          }
          if (command.callbackSequence !== attempt.callbackSequence + 1) {
            throw new PrimaryCompletionSequenceError();
          }
          if (
            run.status === 'succeeded' ||
            run.status === 'failed' ||
            run.status === 'cancelled' ||
            run.status === 'timed_out'
          ) {
            throw new PrimaryCompletionStateError();
          }

          const atMs = Math.max(
            run.createdAtMs,
            run.startedAtMs ?? 0,
            attempt.createdAtMs,
            attempt.startedAtMs ?? 0,
            command.result.finishedAtMs,
          );
          const attemptDecision = transitionRunAttempt(run, attempt, {
            to: mapping.attemptStatus,
            expectedRunVersion: run.version,
            atMs,
            callbackSequence: command.callbackSequence,
            ...(command.result.exitCode === undefined
              ? {}
              : { exitCode: command.result.exitCode }),
            ...(mapping.errorCode === undefined
              ? {}
              : { errorCode: mapping.errorCode }),
            ...(mapping.errorSummary === undefined
              ? {}
              : { errorSummary: mapping.errorSummary }),
          });
          const runDecision = transitionRun(attemptDecision.run, {
            to: mapping.runStatus,
            expectedVersion: attemptDecision.run.version,
            atMs,
            ...(mapping.errorCode === undefined
              ? {}
              : { errorCode: mapping.errorCode }),
            ...(mapping.errorSummary === undefined
              ? {}
              : { errorSummary: mapping.errorSummary }),
          });

          if (
            !(await transaction.compareAndSetRun(
              attemptDecision.run,
              run.version,
            ))
          ) {
            throw new PrimaryCompletionConcurrentWriteError();
          }
          if (
            !(await transaction.compareAndSetAttempt(attemptDecision.attempt, {
              status: attempt.status,
              callbackSequence: attempt.callbackSequence,
            }))
          ) {
            throw new PrimaryCompletionConcurrentWriteError();
          }
          await transaction.appendEvent(
            this.event(
              attemptDecision.run,
              attemptDecision.event,
              attempt.id,
              command.source,
              `primary-completion:${attempt.id}:${command.callbackSequence}:attempt`,
              atMs,
            ),
          );
          if (
            !(await transaction.compareAndSetRun(
              runDecision.run,
              attemptDecision.run.version,
            ))
          ) {
            throw new PrimaryCompletionConcurrentWriteError();
          }
          await transaction.appendEvent(
            this.event(
              runDecision.run,
              runDecision.event,
              attempt.id,
              command.source,
              `primary-completion:${attempt.id}:${command.callbackSequence}:run`,
              atMs,
            ),
          );

          return {
            status: 'applied',
            run: runDecision.run,
            attempt: attemptDecision.attempt,
            result: command.result,
          };
        });
      } catch (error) {
        if (
          !(error instanceof PrimaryCompletionConcurrentWriteError) ||
          retry === MAX_PRIMARY_COMPLETION_RETRIES
        ) {
          throw error;
        }
      }
    }
    throw new Error('Primary completion retry budget was exhausted');
  }

  private event(
    run: RunRecord,
    draft: RunDomainEventDraft,
    attemptId: string,
    source: PrimaryCompletionSource,
    dedupeKey: string,
    createdAtMs: number,
  ): RunEventRecord {
    return {
      id: this.createEventId(),
      runId: run.id,
      sequence: draft.sequence,
      type: draft.type,
      dedupeKey,
      actorType: 'executor',
      actorId:
        source.kind === 'executor' ? source.executorType : 'completion-receipt',
      attemptId,
      payload: draft.payload,
      createdAtMs,
    };
  }
}
