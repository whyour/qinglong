export class CancellationDispatchError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = false,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidCancellationDispatchCommandError extends CancellationDispatchError {
  constructor(message: string) {
    super(message, 'INVALID_CANCELLATION_DISPATCH_COMMAND');
  }
}

export class CancellationDispatchBindingConflictError extends CancellationDispatchError {
  constructor(runId: string, attemptId: string) {
    super(
      `Cancellation dispatch for Run ${runId} is already bound to another Attempt than ${attemptId}`,
      'CANCELLATION_DISPATCH_BINDING_CONFLICT',
    );
  }
}

export class CancellationDispatchFenceRejectedError extends CancellationDispatchError {
  constructor(runId: string) {
    super(
      `Cancellation dispatch lease for Run ${runId} is stale or no longer owned by this worker`,
      'CANCELLATION_DISPATCH_FENCE_REJECTED',
    );
  }
}

export class CancellationDispatchRepositoryError extends CancellationDispatchError {
  constructor(cause?: unknown) {
    super(
      'Cancellation dispatch repository operation failed',
      'CANCELLATION_DISPATCH_REPOSITORY_FAILED',
      false,
      cause,
    );
  }
}
