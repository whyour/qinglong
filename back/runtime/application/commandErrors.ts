import type { RunAttemptStatus } from '../domain/run';

export class RunCommandError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class RunNotFoundError extends RunCommandError {
  constructor(public readonly runId: string) {
    super('Run does not exist', 'RUN_NOT_FOUND');
  }
}

export class RunAttemptNotFoundError extends RunCommandError {
  constructor(public readonly attemptId: string) {
    super('RunAttempt does not exist', 'RUN_ATTEMPT_NOT_FOUND');
  }
}

export class RunAttemptConcurrentWriteError extends RunCommandError {
  constructor(
    public readonly attemptId: string,
    public readonly expectedStatus: RunAttemptStatus,
    public readonly expectedCallbackSequence: number,
  ) {
    super(
      'RunAttempt changed while applying the command',
      'RUN_ATTEMPT_CONCURRENT_WRITE',
    );
  }
}
