export class ExecutorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidExecutionSpecError extends ExecutorError {
  constructor(message: string) {
    super(message, 'INVALID_EXECUTION_SPEC');
  }
}

export class ExecutorCapabilityUnavailableError extends ExecutorError {
  constructor(public readonly capability: string) {
    super(
      `Required executor capability is unavailable: ${capability}`,
      'EXECUTOR_CAPABILITY_UNAVAILABLE',
    );
  }
}

export class ExecutorStartError extends ExecutorError {
  constructor(cause?: unknown) {
    super(
      'Executor failed to start the process',
      'EXECUTOR_START_FAILED',
      cause,
    );
  }
}

export class ExecutorHandleNotFoundError extends ExecutorError {
  constructor(public readonly handleId: string) {
    super(
      'Execution handle is not owned by this executor instance',
      'EXECUTOR_HANDLE_NOT_FOUND',
    );
  }
}

export class ExecutorStopError extends ExecutorError {
  constructor(cause?: unknown) {
    super('Executor failed to stop the process', 'EXECUTOR_STOP_FAILED', cause);
  }
}
