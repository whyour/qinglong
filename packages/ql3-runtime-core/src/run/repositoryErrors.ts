export class RunRepositoryError extends Error {
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

export class DuplicateIdempotencyKeyError extends RunRepositoryError {
  constructor(
    public readonly projectId: string,
    public readonly idempotencyKey: string,
  ) {
    super(
      'A Run with the same project idempotency key already exists',
      'DUPLICATE_RUN_IDEMPOTENCY_KEY',
    );
  }
}

export class DuplicateRunAttemptError extends RunRepositoryError {
  constructor(public readonly runId: string, public readonly attempt: number) {
    super(
      'A RunAttempt with the same run and attempt number already exists',
      'DUPLICATE_RUN_ATTEMPT',
    );
  }
}

export class DuplicateRunEventError extends RunRepositoryError {
  constructor(
    public readonly runId: string,
    public readonly dedupeKey?: string,
  ) {
    super(
      'A RunEvent with the same sequence or dedupe key already exists',
      'DUPLICATE_RUN_EVENT',
    );
  }
}

export class RunRepositoryConstraintError extends RunRepositoryError {
  constructor(
    message = 'Run repository constraint violation',
    cause?: unknown,
  ) {
    super(message, 'RUN_REPOSITORY_CONSTRAINT', false, cause);
  }
}

export class RunRepositoryBusyError extends RunRepositoryError {
  constructor(cause?: unknown) {
    super(
      'Run repository is temporarily busy',
      'RUN_REPOSITORY_BUSY',
      true,
      cause,
    );
  }
}

export class RunRepositoryOperationError extends RunRepositoryError {
  constructor(cause?: unknown) {
    super(
      'Run repository operation failed',
      'RUN_REPOSITORY_OPERATION_FAILED',
      false,
      cause,
    );
  }
}

export class RunEventPayloadTooLargeError extends RunRepositoryError {
  constructor(
    public readonly actualBytes: number,
    public readonly maxBytes: number,
  ) {
    super(
      'RunEvent payload exceeds the configured size limit',
      'RUN_EVENT_PAYLOAD_TOO_LARGE',
    );
  }
}
