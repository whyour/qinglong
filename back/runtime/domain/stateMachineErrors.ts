import type { RunAttemptStatus, RunStatus } from './run';

export class RunStateMachineError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class RunVersionConflictError extends RunStateMachineError {
  constructor(
    public readonly runId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      'Run version does not match the expected version',
      'RUN_VERSION_CONFLICT',
    );
  }
}

export class InvalidRunTransitionError extends RunStateMachineError {
  constructor(
    public readonly runId: string,
    public readonly from: RunStatus,
    public readonly to: RunStatus,
  ) {
    super(
      `Run cannot transition from ${from} to ${to}`,
      'INVALID_RUN_TRANSITION',
    );
  }
}

export class InvalidRunAttemptTransitionError extends RunStateMachineError {
  constructor(
    public readonly attemptId: string,
    public readonly from: RunAttemptStatus,
    public readonly to: RunAttemptStatus,
  ) {
    super(
      `RunAttempt cannot transition from ${from} to ${to}`,
      'INVALID_RUN_ATTEMPT_TRANSITION',
    );
  }
}

export class InvalidTransitionTimestampError extends RunStateMachineError {
  constructor(message: string) {
    super(message, 'INVALID_TRANSITION_TIMESTAMP');
  }
}

export class InvalidTransitionMetadataError extends RunStateMachineError {
  constructor(message: string) {
    super(message, 'INVALID_TRANSITION_METADATA');
  }
}
