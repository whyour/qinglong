import type {
  RunAttemptRecord,
  RunEventRecord,
  RunRecord,
} from './run';
import {
  runRetryDelayMs,
  type RunRetryPolicyRecord,
} from './runRetryPolicy';

export const MAX_CLUSTER_RUN_LOST_RETRY_PAGE_SIZE = 64;

export type ClusterRunLostRetryDisposition =
  | 'scheduled'
  | 'requeued'
  | 'failed_disabled'
  | 'failed_unsafe'
  | 'failed_exhausted';

export interface ClusterRunLostRetryPageCommand {
  readonly limit: number;
}

export interface ClusterRunLostRetryPageResult {
  readonly scanned: number;
  readonly scheduled: number;
  readonly requeued: number;
  readonly failed: number;
  readonly raced: number;
  readonly hasMore: boolean;
}

export interface ClusterRunLostRetryRepository {
  reconcilePage(
    command: Readonly<ClusterRunLostRetryPageCommand>,
  ): Promise<Readonly<ClusterRunLostRetryPageResult>>;
}

export interface ClusterRunLostRetryCoordinatorOptions {
  readonly pageSize?: number;
}

export interface ClusterRunLostRetryTransitionInput {
  readonly run: Readonly<RunRecord>;
  readonly attempt: Readonly<RunAttemptRecord>;
  readonly policy: Readonly<RunRetryPolicyRecord> | null;
  readonly observedAtMs: number;
  readonly runEventId: string;
  readonly attemptId?: string;
  readonly attemptEventId?: string;
}

export interface ClusterRunLostRetryTransition {
  readonly disposition: ClusterRunLostRetryDisposition;
  readonly runTransitions: readonly Readonly<RunRecord>[];
  readonly policy?: Readonly<RunRetryPolicyRecord>;
  readonly attempt?: Readonly<RunAttemptRecord>;
  readonly events: readonly Readonly<RunEventRecord>[];
}

export class ClusterRunLostRetryUnavailableError extends Error {
  readonly code = 'CLUSTER_RUN_LOST_RETRY_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Cluster Run lost retry is unavailable', options);
    this.name = 'ClusterRunLostRetryUnavailableError';
  }
}

export class InvalidClusterRunLostRetryTransitionError extends TypeError {
  readonly code = 'CLUSTER_RUN_LOST_RETRY_INVALID';

  constructor(message: string) {
    super(`Cluster Run lost retry is invalid: ${message}`);
    this.name = 'InvalidClusterRunLostRetryTransitionError';
  }
}

function invalid(message: string): never {
  throw new InvalidClusterRunLostRetryTransitionError(message);
}

function boundedInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function identifier(name: string, value: string | undefined): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return invalid(`${name} is invalid`);
  }
  return value;
}

function reserve(
  current: Readonly<RunRecord>,
  status: RunRecord['status'],
  atMs: number,
  error?: Readonly<{ code: string; summary: string }>,
): Readonly<RunRecord> {
  const version = current.version + 1;
  const eventSequence = current.eventSequence + 1;
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !Number.isSafeInteger(eventSequence) ||
    eventSequence < 1
  ) {
    return invalid('Run counter overflowed');
  }
  const next: RunRecord = {
    ...current,
    status,
    version,
    eventSequence,
  };
  if (status === 'queued') {
    next.queuedAtMs = atMs;
    delete next.errorCode;
    delete next.errorSummary;
  } else if (error) {
    next.errorCode = error.code;
    next.errorSummary = error.summary;
  }
  if (status === 'failed') next.finishedAtMs = atMs;
  return Object.freeze(next);
}

function event(
  id: string,
  run: Readonly<RunRecord>,
  attemptId: string,
  type: string,
  dedupeKey: string,
  createdAtMs: number,
  payload: Readonly<Record<string, unknown>>,
): Readonly<RunEventRecord> {
  return Object.freeze({
    id: identifier('event ID', id),
    runId: run.id,
    sequence: run.eventSequence,
    type,
    dedupeKey,
    actorType: 'reconciler',
    attemptId,
    payload: Object.freeze({ ...payload, version: run.version }),
    createdAtMs,
  });
}

function transitionTime(
  input: Readonly<ClusterRunLostRetryTransitionInput>,
): number {
  const atMs = input.observedAtMs;
  if (!Number.isSafeInteger(atMs) || atMs < 0) {
    return invalid('observation time is invalid');
  }
  const lowerBound = Math.max(
    input.run.createdAtMs,
    input.run.startedAtMs ?? 0,
    input.attempt.createdAtMs,
    input.attempt.startedAtMs ?? 0,
    input.attempt.finishedAtMs ?? 0,
    input.policy?.updatedAtMs ?? 0,
  );
  if (atMs < lowerBound) return invalid('observation precedes durable state');
  return atMs;
}

function finish(
  input: Readonly<ClusterRunLostRetryTransitionInput>,
  atMs: number,
  disposition:
    | 'failed_disabled'
    | 'failed_unsafe'
    | 'failed_exhausted',
  error: Readonly<{ code: string; summary: string }>,
): Readonly<ClusterRunLostRetryTransition> {
  const run = reserve(input.run, 'failed', atMs, error);
  let policy = input.policy ?? undefined;
  if (input.policy?.nextAttemptAtMs !== undefined) {
    const { nextAttemptAtMs: _nextAttemptAtMs, ...withoutNextAttempt } =
      input.policy;
    policy = Object.freeze({
      ...withoutNextAttempt,
      version: input.policy.version + 1,
      updatedAtMs: atMs,
    });
  }
  return Object.freeze({
    disposition,
    runTransitions: Object.freeze([run]),
    ...(policy === undefined ? {} : { policy }),
    events: Object.freeze([
      event(
        input.runEventId,
        run,
        input.attempt.id,
        'run.failed',
        `cluster-lost-retry:${disposition}:${input.attempt.id}`,
        atMs,
        {
          from_status: input.run.status,
          to_status: 'failed',
          attempt: input.attempt.attempt,
          error_code: error.code,
        },
      ),
    ]),
  });
}

/**
 * Pure, profile-neutral lost recovery policy. Storage owns row locking and
 * persistence; this function can only schedule, create a fresh Attempt, or
 * terminalize an unsafe/exhausted Run.
 */
export function buildClusterRunLostRetryTransition(
  input: Readonly<ClusterRunLostRetryTransitionInput>,
): Readonly<ClusterRunLostRetryTransition> {
  const { run, attempt, policy } = input;
  if (
    !run ||
    !attempt ||
    run.executionOwner !== 'runtime' ||
    run.triggerType === 'plugin_package_workflow' ||
    (run.status !== 'lost' && run.status !== 'retry_wait') ||
    run.cancelRequestedAtMs !== undefined ||
    attempt.runId !== run.id ||
    attempt.status !== 'lost' ||
    attempt.attempt < 1
  ) {
    return invalid('aggregate is not eligible');
  }
  const atMs = transitionTime(input);
  identifier('Run ID', run.id);
  identifier('Attempt ID', attempt.id);
  identifier('Run event ID', input.runEventId);

  if (!policy || !policy.retryOnLost || policy.maxAttempts <= 1) {
    return finish(input, atMs, 'failed_disabled', {
      code: 'RUN_LOST_RETRY_DISABLED',
      summary: 'Run was lost and automatic retry was not enabled at admission',
    });
  }
  if (policy.runId !== run.id) return invalid('retry policy Run mismatches');
  if (policy.safety === 'unknown') {
    return finish(input, atMs, 'failed_unsafe', {
      code: 'RUN_LOST_RETRY_UNSAFE',
      summary: 'Run was lost but execution safety was not declared',
    });
  }
  if (attempt.attempt >= policy.maxAttempts) {
    return finish(input, atMs, 'failed_exhausted', {
      code: 'RUN_LOST_RETRY_EXHAUSTED',
      summary: 'Run exhausted its admitted automatic retry attempts',
    });
  }

  if (run.status === 'lost') {
    const nextAttemptAtMs =
      Math.max(run.createdAtMs, attempt.createdAtMs, attempt.finishedAtMs ?? 0) +
      runRetryDelayMs(policy, attempt.attempt);
    if (!Number.isSafeInteger(nextAttemptAtMs)) {
      return invalid('next Attempt time overflowed');
    }
    const error = {
      code: 'RUN_LOST_RETRY_SCHEDULED',
      summary: 'A fresh Attempt will be created after the admitted backoff',
    };
    const nextRun = reserve(run, 'retry_wait', atMs, error);
    const nextPolicy = Object.freeze({
      ...policy,
      nextAttemptAtMs,
      version: policy.version + 1,
      updatedAtMs: atMs,
    });
    return Object.freeze({
      disposition: 'scheduled',
      runTransitions: Object.freeze([nextRun]),
      policy: nextPolicy,
      events: Object.freeze([
        event(
          input.runEventId,
          nextRun,
          attempt.id,
          'run.retry_wait',
          `cluster-lost-retry:scheduled:${attempt.id}`,
          atMs,
          {
            from_status: 'lost',
            to_status: 'retry_wait',
            attempt: attempt.attempt,
            max_attempts: policy.maxAttempts,
            safety: policy.safety,
            next_attempt_at_ms: nextAttemptAtMs,
            error_code: error.code,
          },
        ),
      ]),
    });
  }

  if (
    policy.nextAttemptAtMs === undefined ||
    policy.nextAttemptAtMs > atMs
  ) {
    return invalid('retry_wait policy is not due');
  }
  const nextAttemptId = identifier('replacement Attempt ID', input.attemptId);
  const nextAttemptEventId = identifier(
    'Attempt event ID',
    input.attemptEventId,
  );
  const queued = reserve(run, 'queued', atMs);
  const claimed = reserve(queued, 'queued', atMs);
  const replacement = Object.freeze({
    id: nextAttemptId,
    runId: run.id,
    attempt: attempt.attempt + 1,
    status: 'claimed' as const,
    executorType: attempt.executorType,
    callbackSequence: 0,
    createdAtMs: atMs,
  });
  const { nextAttemptAtMs: _nextAttemptAtMs, ...withoutNextAttempt } = policy;
  const nextPolicy = Object.freeze({
    ...withoutNextAttempt,
    version: policy.version + 1,
    updatedAtMs: atMs,
  });
  return Object.freeze({
    disposition: 'requeued',
    runTransitions: Object.freeze([queued, claimed]),
    policy: nextPolicy,
    attempt: replacement,
    events: Object.freeze([
      event(
        input.runEventId,
        queued,
        replacement.id,
        'run.queued',
        `cluster-lost-retry:queued:${replacement.id}`,
        atMs,
        {
          from_status: 'retry_wait',
          to_status: 'queued',
          previous_attempt_id: attempt.id,
        },
      ),
      event(
        nextAttemptEventId,
        claimed,
        replacement.id,
        'attempt.claimed',
        `cluster-lost-retry:attempt-claimed:${replacement.id}`,
        atMs,
        {
          attempt: replacement.attempt,
          executor_type: replacement.executorType,
          previous_attempt_id: attempt.id,
        },
      ),
    ]),
  });
}

export function normalizeClusterRunLostRetryPageCommand(
  value: ClusterRunLostRetryPageCommand,
): Readonly<ClusterRunLostRetryPageCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, 'limit')
  ) {
    throw new TypeError('Cluster Run lost retry command is invalid');
  }
  return Object.freeze({
    limit: boundedInteger(
      'Cluster Run lost retry page size',
      value.limit,
      1,
      MAX_CLUSTER_RUN_LOST_RETRY_PAGE_SIZE,
    ),
  });
}

export function normalizeClusterRunLostRetryPageResult(
  value: ClusterRunLostRetryPageResult,
  limit = MAX_CLUSTER_RUN_LOST_RETRY_PAGE_SIZE,
): Readonly<ClusterRunLostRetryPageResult> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'failed,hasMore,raced,requeued,scanned,scheduled'
  ) {
    throw new TypeError('Cluster Run lost retry result is invalid');
  }
  const maximum = boundedInteger(
    'Cluster Run lost retry result limit',
    limit,
    1,
    MAX_CLUSTER_RUN_LOST_RETRY_PAGE_SIZE,
  );
  const scanned = boundedInteger(
    'Cluster Run lost retry scanned count',
    value.scanned,
    0,
    maximum,
  );
  const scheduled = boundedInteger(
    'Cluster Run lost retry scheduled count',
    value.scheduled,
    0,
    scanned,
  );
  const requeued = boundedInteger(
    'Cluster Run lost retry requeued count',
    value.requeued,
    0,
    scanned,
  );
  const failed = boundedInteger(
    'Cluster Run lost retry failed count',
    value.failed,
    0,
    scanned,
  );
  const raced = boundedInteger(
    'Cluster Run lost retry raced count',
    value.raced,
    0,
    scanned,
  );
  if (
    scheduled + requeued + failed + raced !== scanned ||
    typeof value.hasMore !== 'boolean'
  ) {
    throw new TypeError('Cluster Run lost retry result counts are invalid');
  }
  return Object.freeze({
    scanned,
    scheduled,
    requeued,
    failed,
    raced,
    hasMore: value.hasMore,
  });
}

/** One non-overlapping bounded page; deployment owns the shared cadence. */
export class ClusterRunLostRetryCoordinator {
  private readonly pageSize: number;
  private inFlight:
    | Promise<Readonly<ClusterRunLostRetryPageResult>>
    | undefined;

  constructor(
    private readonly repository: ClusterRunLostRetryRepository,
    options: ClusterRunLostRetryCoordinatorOptions = {},
  ) {
    if (
      typeof repository?.reconcilePage !== 'function' ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options)
    ) {
      throw new TypeError('Cluster Run lost retry coordinator is invalid');
    }
    this.pageSize = boundedInteger(
      'Cluster Run lost retry page size',
      options.pageSize ?? 16,
      1,
      MAX_CLUSTER_RUN_LOST_RETRY_PAGE_SIZE,
    );
  }

  reconcile(): Promise<Readonly<ClusterRunLostRetryPageResult>> {
    if (this.inFlight) return this.inFlight;
    const operation = Promise.resolve()
      .then(() =>
        this.repository.reconcilePage({ limit: this.pageSize }),
      )
      .then((result) =>
        normalizeClusterRunLostRetryPageResult(result, this.pageSize),
      )
      .catch((error: unknown) => {
        if (error instanceof ClusterRunLostRetryUnavailableError) throw error;
        throw new ClusterRunLostRetryUnavailableError({ cause: error });
      })
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = undefined;
      });
    this.inFlight = operation;
    return operation;
  }
}
