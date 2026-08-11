import type {
  RunAttemptRecord,
  RunAttemptStatus,
  RunCancellationReason,
  RunRecord,
  RunStatus,
} from './run';
import { RUN_CANCELLATION_REASONS } from './run';
import {
  InvalidRunAttemptTransitionError,
  InvalidRunTransitionError,
  InvalidTransitionMetadataError,
  InvalidTransitionTimestampError,
  RunVersionConflictError,
} from './stateMachineErrors';

export const MAX_RUN_ERROR_CODE_LENGTH = 128;
export const MAX_RUN_ERROR_SUMMARY_LENGTH = 1024;
export const MAX_EXECUTOR_HANDLE_LENGTH = 2048;
export const MAX_LOG_ARTIFACT_ID_LENGTH = 36;

export const RUN_TRANSITIONS: Readonly<
  Record<RunStatus, readonly RunStatus[]>
> = {
  created: ['queued', 'cancelled'],
  queued: ['dispatching', 'cancelled', 'timed_out'],
  dispatching: [
    'running',
    'retry_wait',
    'failed',
    'cancelled',
    'timed_out',
    'lost',
  ],
  running: [
    'waiting_approval',
    'retry_wait',
    'succeeded',
    'failed',
    'cancelled',
    'timed_out',
    'lost',
  ],
  waiting_approval: ['running', 'cancelled', 'timed_out'],
  retry_wait: ['queued', 'cancelled', 'timed_out'],
  lost: ['retry_wait', 'queued', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export const RUN_ATTEMPT_TRANSITIONS: Readonly<
  Record<RunAttemptStatus, readonly RunAttemptStatus[]>
> = {
  claimed: ['starting', 'cancelled', 'lost'],
  starting: ['running', 'failed', 'cancelled', 'timed_out', 'lost'],
  running: ['succeeded', 'failed', 'cancelled', 'timed_out', 'lost'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  lost: [],
};

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

const TERMINAL_RUN_ATTEMPT_STATUSES = new Set<RunAttemptStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);

const ERROR_RUN_STATUSES = new Set<RunStatus>([
  'retry_wait',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);

const ERROR_RUN_ATTEMPT_STATUSES = new Set<RunAttemptStatus>([
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);

export interface RunDomainEventDraft {
  sequence: number;
  type: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface RunTransitionCommand {
  to: RunStatus;
  expectedVersion: number;
  atMs: number;
  errorCode?: string;
  errorSummary?: string;
}

export interface RunAttemptTransitionCommand {
  to: RunAttemptStatus;
  expectedRunVersion: number;
  atMs: number;
  executorHandle?: string;
  pid?: number;
  logArtifactId?: string;
  deadlineAtMs?: number;
  callbackTokenHash?: string;
  callbackSequence?: number;
  exitCode?: number;
  errorCode?: string;
  errorSummary?: string;
}

export interface RunTransitionDecision {
  run: RunRecord;
  event: RunDomainEventDraft;
}

export interface RunAttemptTransitionDecision {
  run: RunRecord;
  attempt: RunAttemptRecord;
  event: RunDomainEventDraft;
}

export interface RunCancellationRequestCommand {
  expectedVersion: number;
  atMs: number;
  reason: RunCancellationReason;
}

export type RunCancellationRequestDecision =
  | {
      status: 'accepted';
      run: RunRecord;
      event: RunDomainEventDraft;
    }
  | {
      status: 'already_requested' | 'already_terminal';
      run: RunRecord;
    };

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function isTerminalRunAttemptStatus(status: RunAttemptStatus): boolean {
  return TERMINAL_RUN_ATTEMPT_STATUSES.has(status);
}

function assertVersion(run: RunRecord, expectedVersion: number): void {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new InvalidTransitionMetadataError(
      'expectedVersion must be a non-negative integer',
    );
  }
  if (run.version !== expectedVersion) {
    throw new RunVersionConflictError(run.id, expectedVersion, run.version);
  }
}

function assertTimestamp(
  atMs: number,
  createdAtMs: number,
  startedAtMs?: number,
): void {
  if (!Number.isSafeInteger(atMs) || atMs < 0) {
    throw new InvalidTransitionTimestampError(
      'Transition timestamp must be a non-negative safe integer',
    );
  }
  if (atMs < createdAtMs) {
    throw new InvalidTransitionTimestampError(
      'Transition timestamp cannot be earlier than creation time',
    );
  }
  if (startedAtMs !== undefined && atMs < startedAtMs) {
    throw new InvalidTransitionTimestampError(
      'Transition timestamp cannot be earlier than start time',
    );
  }
}

function assertErrorMetadata(
  status: RunStatus | RunAttemptStatus,
  errorStatuses: ReadonlySet<RunStatus | RunAttemptStatus>,
  errorCode?: string,
  errorSummary?: string,
): void {
  if (
    (errorCode !== undefined || errorSummary !== undefined) &&
    !errorStatuses.has(status)
  ) {
    throw new InvalidTransitionMetadataError(
      'Error metadata is not allowed for the target status',
    );
  }
  if (errorCode !== undefined && errorCode.length > MAX_RUN_ERROR_CODE_LENGTH) {
    throw new InvalidTransitionMetadataError('errorCode is too long');
  }
  if (
    errorSummary !== undefined &&
    errorSummary.length > MAX_RUN_ERROR_SUMMARY_LENGTH
  ) {
    throw new InvalidTransitionMetadataError('errorSummary is too long');
  }
}

function assertAttemptExecutionMetadata(
  attempt: RunAttemptRecord,
  command: RunAttemptTransitionCommand,
): void {
  const hasExecutionMetadata =
    command.executorHandle !== undefined ||
    command.pid !== undefined ||
    command.logArtifactId !== undefined ||
    command.deadlineAtMs !== undefined ||
    command.callbackTokenHash !== undefined;
  if (
    hasExecutionMetadata &&
    command.to !== 'starting' &&
    command.to !== 'running'
  ) {
    throw new InvalidTransitionMetadataError(
      'Execution metadata is only allowed while an Attempt is starting or running',
    );
  }
  if (
    command.executorHandle !== undefined &&
    (command.executorHandle.length < 1 ||
      command.executorHandle.length > MAX_EXECUTOR_HANDLE_LENGTH)
  ) {
    throw new InvalidTransitionMetadataError(
      'executorHandle has an invalid length',
    );
  }
  if (
    command.pid !== undefined &&
    (!Number.isSafeInteger(command.pid) || command.pid < 1)
  ) {
    throw new InvalidTransitionMetadataError(
      'pid must be a positive safe integer',
    );
  }
  if (
    command.logArtifactId !== undefined &&
    (command.logArtifactId.length < 1 ||
      command.logArtifactId.length > MAX_LOG_ARTIFACT_ID_LENGTH)
  ) {
    throw new InvalidTransitionMetadataError(
      'logArtifactId has an invalid length',
    );
  }
  if (command.deadlineAtMs !== undefined) {
    if (command.to !== 'starting') {
      throw new InvalidTransitionMetadataError(
        'deadlineAtMs is only allowed when an Attempt starts',
      );
    }
    if (
      !Number.isSafeInteger(command.deadlineAtMs) ||
      command.deadlineAtMs <= command.atMs
    ) {
      throw new InvalidTransitionMetadataError(
        'deadlineAtMs must be a safe integer after the transition time',
      );
    }
    if (
      attempt.deadlineAtMs !== undefined &&
      attempt.deadlineAtMs !== command.deadlineAtMs
    ) {
      throw new InvalidTransitionMetadataError(
        'deadlineAtMs cannot replace an existing Attempt deadline',
      );
    }
  }
  if (command.callbackTokenHash !== undefined) {
    if (command.to !== 'starting') {
      throw new InvalidTransitionMetadataError(
        'callbackTokenHash is only allowed when an Attempt starts',
      );
    }
    if (!/^[a-f0-9]{64}$/.test(command.callbackTokenHash)) {
      throw new InvalidTransitionMetadataError(
        'callbackTokenHash must be a lowercase SHA-256 digest',
      );
    }
    if (
      attempt.callbackTokenHash !== undefined &&
      attempt.callbackTokenHash !== command.callbackTokenHash
    ) {
      throw new InvalidTransitionMetadataError(
        'callbackTokenHash cannot replace an existing Attempt token',
      );
    }
  }
}

function assertAttemptCallbackSequence(
  attempt: RunAttemptRecord,
  command: RunAttemptTransitionCommand,
): void {
  if (command.callbackSequence === undefined) return;
  if (!isTerminalRunAttemptStatus(command.to)) {
    throw new InvalidTransitionMetadataError(
      'callbackSequence is only allowed for terminal Attempt states',
    );
  }
  if (
    !Number.isSafeInteger(command.callbackSequence) ||
    command.callbackSequence !== attempt.callbackSequence + 1
  ) {
    throw new InvalidTransitionMetadataError(
      'callbackSequence must advance the Attempt sequence exactly once',
    );
  }
}

export function reserveRunEvent(
  run: RunRecord,
  expectedVersion: number,
): { run: RunRecord; sequence: number } {
  assertVersion(run, expectedVersion);
  const sequence = run.eventSequence + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new InvalidTransitionMetadataError(
      'Run event sequence exceeds the supported range',
    );
  }
  return {
    run: {
      ...run,
      version: run.version + 1,
      eventSequence: sequence,
    },
    sequence,
  };
}

export function requestRunCancellation(
  current: RunRecord,
  command: RunCancellationRequestCommand,
): RunCancellationRequestDecision {
  assertTimestamp(command.atMs, current.createdAtMs, current.startedAtMs);
  if (!RUN_CANCELLATION_REASONS.includes(command.reason)) {
    throw new InvalidTransitionMetadataError(
      'Cancellation reason is not supported',
    );
  }
  assertVersion(current, command.expectedVersion);

  if (isTerminalRunStatus(current.status)) {
    return { status: 'already_terminal', run: current };
  }
  if (current.cancelRequestedAtMs !== undefined) {
    return { status: 'already_requested', run: current };
  }

  const reserved = reserveRunEvent(current, command.expectedVersion);
  const run: RunRecord = {
    ...reserved.run,
    cancelRequestedAtMs: command.atMs,
    cancelReason: command.reason,
  };
  return {
    status: 'accepted',
    run,
    event: {
      sequence: reserved.sequence,
      type: 'run.cancel_requested',
      payload: {
        status: current.status,
        reason: command.reason,
        requested_at_ms: command.atMs,
        version: run.version,
      },
    },
  };
}

export function transitionRun(
  current: RunRecord,
  command: RunTransitionCommand,
): RunTransitionDecision {
  assertTimestamp(command.atMs, current.createdAtMs, current.startedAtMs);
  assertErrorMetadata(
    command.to,
    ERROR_RUN_STATUSES,
    command.errorCode,
    command.errorSummary,
  );

  if (!RUN_TRANSITIONS[current.status].includes(command.to)) {
    throw new InvalidRunTransitionError(current.id, current.status, command.to);
  }

  const reserved = reserveRunEvent(current, command.expectedVersion);
  const next: RunRecord = {
    ...reserved.run,
    status: command.to,
  };

  if (command.to === 'queued') {
    next.queuedAtMs = command.atMs;
    delete next.errorCode;
    delete next.errorSummary;
  }
  if (command.to === 'running' && next.startedAtMs === undefined) {
    next.startedAtMs = command.atMs;
  }
  if (isTerminalRunStatus(command.to)) {
    next.finishedAtMs = command.atMs;
  }
  if (ERROR_RUN_STATUSES.has(command.to)) {
    if (command.errorCode !== undefined) next.errorCode = command.errorCode;
    if (command.errorSummary !== undefined)
      next.errorSummary = command.errorSummary;
  } else if (command.to === 'succeeded') {
    delete next.errorCode;
    delete next.errorSummary;
  }

  return {
    run: next,
    event: {
      sequence: reserved.sequence,
      type: `run.${command.to}`,
      payload: {
        from_status: current.status,
        to_status: command.to,
        version: next.version,
        ...(command.errorCode ? { error_code: command.errorCode } : {}),
      },
    },
  };
}

export function transitionRunAttempt(
  currentRun: RunRecord,
  currentAttempt: RunAttemptRecord,
  command: RunAttemptTransitionCommand,
): RunAttemptTransitionDecision {
  if (currentAttempt.runId !== currentRun.id) {
    throw new InvalidTransitionMetadataError(
      'RunAttempt does not belong to the supplied Run',
    );
  }
  assertTimestamp(
    command.atMs,
    currentAttempt.createdAtMs,
    currentAttempt.startedAtMs,
  );
  assertErrorMetadata(
    command.to,
    ERROR_RUN_ATTEMPT_STATUSES,
    command.errorCode,
    command.errorSummary,
  );
  assertAttemptExecutionMetadata(currentAttempt, command);
  assertAttemptCallbackSequence(currentAttempt, command);

  if (!RUN_ATTEMPT_TRANSITIONS[currentAttempt.status].includes(command.to)) {
    throw new InvalidRunAttemptTransitionError(
      currentAttempt.id,
      currentAttempt.status,
      command.to,
    );
  }
  if (isTerminalRunStatus(currentRun.status)) {
    throw new InvalidTransitionMetadataError(
      'Cannot transition an Attempt after its Run is terminal',
    );
  }
  if (
    command.exitCode !== undefined &&
    !isTerminalRunAttemptStatus(command.to)
  ) {
    throw new InvalidTransitionMetadataError(
      'exitCode is only allowed for terminal Attempt states',
    );
  }

  const reserved = reserveRunEvent(currentRun, command.expectedRunVersion);
  const nextAttempt: RunAttemptRecord = {
    ...currentAttempt,
    status: command.to,
  };

  if (command.to === 'running' && nextAttempt.startedAtMs === undefined) {
    nextAttempt.startedAtMs = command.atMs;
  }
  if (isTerminalRunAttemptStatus(command.to)) {
    nextAttempt.finishedAtMs = command.atMs;
  }
  if (command.exitCode !== undefined) {
    nextAttempt.exitCode = command.exitCode;
  }
  if (command.executorHandle !== undefined) {
    nextAttempt.executorHandle = command.executorHandle;
  }
  if (command.pid !== undefined) nextAttempt.pid = command.pid;
  if (command.logArtifactId !== undefined) {
    nextAttempt.logArtifactId = command.logArtifactId;
  }
  if (command.deadlineAtMs !== undefined) {
    nextAttempt.deadlineAtMs = command.deadlineAtMs;
  }
  if (command.callbackTokenHash !== undefined) {
    nextAttempt.callbackTokenHash = command.callbackTokenHash;
  }
  if (command.callbackSequence !== undefined) {
    nextAttempt.callbackSequence = command.callbackSequence;
  }
  if (ERROR_RUN_ATTEMPT_STATUSES.has(command.to)) {
    if (command.errorCode !== undefined)
      nextAttempt.errorCode = command.errorCode;
    if (command.errorSummary !== undefined)
      nextAttempt.errorSummary = command.errorSummary;
  } else if (command.to === 'succeeded') {
    delete nextAttempt.errorCode;
    delete nextAttempt.errorSummary;
  }

  return {
    run: reserved.run,
    attempt: nextAttempt,
    event: {
      sequence: reserved.sequence,
      type: `attempt.${command.to}`,
      payload: {
        attempt_id: currentAttempt.id,
        attempt: currentAttempt.attempt,
        from_status: currentAttempt.status,
        to_status: command.to,
        version: reserved.run.version,
        ...(command.exitCode !== undefined
          ? { exit_code: command.exitCode }
          : {}),
        ...(command.errorCode ? { error_code: command.errorCode } : {}),
        ...(command.deadlineAtMs === undefined
          ? {}
          : { deadline_at_ms: command.deadlineAtMs }),
        ...(command.callbackSequence === undefined
          ? {}
          : { callback_sequence: command.callbackSequence }),
      },
    },
  };
}
