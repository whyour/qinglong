import { createHash } from 'node:crypto';
import type { RunEventRecord } from '../run';

export const CANCELLATION_DISPATCH_STATUSES = Object.freeze([
  'pending',
  'leased',
  'retry_wait',
  'dispatched',
  'blocked',
] as const);

export type CancellationDispatchStatus =
  (typeof CANCELLATION_DISPATCH_STATUSES)[number];

export const CANCELLATION_DISPATCH_RESULTS = Object.freeze([
  'termination_requested',
  'already_exited',
  'identity_mismatch',
  'pid_mismatch',
  'unsupported',
  'invalid',
  'controller_missing',
  'handle_missing',
  'dispatch_error',
] as const);

export type CancellationDispatchResult =
  (typeof CANCELLATION_DISPATCH_RESULTS)[number];

export const CANCELLATION_DISPATCH_RETRYABLE_RESULTS = Object.freeze([
  'controller_missing',
  'handle_missing',
  'dispatch_error',
] as const satisfies readonly CancellationDispatchResult[]);

export const CANCELLATION_DISPATCH_BLOCKING_RESULTS = Object.freeze([
  'identity_mismatch',
  'pid_mismatch',
  'unsupported',
  'invalid',
] as const satisfies readonly CancellationDispatchResult[]);

const CANCELLATION_DISPATCH_RETRY_HISTORY_RESULTS = new Set<
  CancellationDispatchResult
>([
  ...CANCELLATION_DISPATCH_RETRYABLE_RESULTS,
  ...CANCELLATION_DISPATCH_BLOCKING_RESULTS,
]);

export const MAX_CANCELLATION_DISPATCH_LEASE_MS = 5 * 60_000;
export const MAX_CANCELLATION_DISPATCH_RETRY_DELAY_MS = 24 * 60 * 60_000;

export interface CancellationDispatchRecord {
  readonly runId: string;
  readonly attemptId: string;
  readonly status: CancellationDispatchStatus;
  readonly version: number;
  readonly dispatchCount: number;
  readonly nextAttemptAtMs?: number;
  readonly leaseOwner?: string;
  readonly leaseTokenDigest?: string;
  readonly leaseExpiresAtMs?: number;
  readonly lastResult?: CancellationDispatchResult;
  readonly lastDispatchedAtMs?: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ClaimCancellationDispatchCommand {
  readonly runId: string;
  readonly attemptId: string;
  readonly requestedAtMs: number;
  readonly owner: string;
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
}

export type ClaimCancellationDispatchResult =
  | Readonly<{
      status: 'claimed';
      dispatch: Readonly<CancellationDispatchRecord>;
      leaseToken: string;
    }>
  | Readonly<{ status: 'not_eligible' }>
  | Readonly<{
      status: 'not_due' | 'leased' | 'dispatched' | 'blocked';
      dispatch: Readonly<CancellationDispatchRecord>;
    }>;

export interface RecordCancellationDispatchResultCommand {
  readonly runId: string;
  readonly attemptId: string;
  readonly owner: string;
  readonly leaseToken: string;
  readonly expectedVersion: number;
  readonly result: CancellationDispatchResult;
  readonly retryDelayMs?: number;
  readonly eventId: string;
}

export interface RecordCancellationDispatchResult {
  readonly dispatch: Readonly<CancellationDispatchRecord>;
  readonly event: Readonly<RunEventRecord>;
}

export interface CancellationDispatchRepository {
  findByRunId(
    runId: string,
  ): Promise<Readonly<CancellationDispatchRecord> | null>;
  claim(
    command: Readonly<ClaimCancellationDispatchCommand>,
  ): Promise<ClaimCancellationDispatchResult>;
  recordResult(
    command: Readonly<RecordCancellationDispatchResultCommand>,
  ): Promise<Readonly<RecordCancellationDispatchResult>>;
}

export class CancellationDispatchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
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
      { cause },
    );
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidCancellationDispatchCommandError(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidCancellationDispatchCommandError(
      `${name} shape is invalid`,
    );
  }
}

function identifier(
  value: unknown,
  name: string,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new InvalidCancellationDispatchCommandError(`${name} is invalid`);
  }
  return value;
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new InvalidCancellationDispatchCommandError(`${name} is invalid`);
  }
  return value;
}

export function digestCancellationDispatchLeaseToken(value: string): string {
  const token = identifier(value, 'leaseToken', 128);
  return createHash('sha256')
    .update('qinglong.cancellation-dispatch-lease.v1\0', 'utf8')
    .update(token, 'utf8')
    .digest('hex');
}

export function normalizeCancellationDispatchRunId(value: string): string {
  return identifier(value, 'runId', 36);
}

export function normalizeClaimCancellationDispatchCommand(
  value: Readonly<ClaimCancellationDispatchCommand>,
): Readonly<ClaimCancellationDispatchCommand> {
  const command = record(value, 'claim command');
  exactKeys(
    command,
    [
      'runId',
      'attemptId',
      'requestedAtMs',
      'owner',
      'leaseToken',
      'leaseDurationMs',
    ],
    'claim command',
  );
  return Object.freeze({
    runId: identifier(command.runId, 'runId', 36),
    attemptId: identifier(command.attemptId, 'attemptId', 36),
    requestedAtMs: integer(command.requestedAtMs, 'requestedAtMs', 0),
    owner: identifier(command.owner, 'owner', 128),
    leaseToken: identifier(command.leaseToken, 'leaseToken', 128),
    leaseDurationMs: integer(
      command.leaseDurationMs,
      'leaseDurationMs',
      1,
      MAX_CANCELLATION_DISPATCH_LEASE_MS,
    ),
  });
}

export function normalizeRecordCancellationDispatchResultCommand(
  value: Readonly<RecordCancellationDispatchResultCommand>,
): Readonly<RecordCancellationDispatchResultCommand> {
  const command = record(value, 'result command');
  const retryable = CANCELLATION_DISPATCH_RETRYABLE_RESULTS.includes(
    command.result as (typeof CANCELLATION_DISPATCH_RETRYABLE_RESULTS)[number],
  );
  exactKeys(
    command,
    [
      'runId',
      'attemptId',
      'owner',
      'leaseToken',
      'expectedVersion',
      'result',
      ...(retryable ? ['retryDelayMs'] : []),
      'eventId',
    ],
    'result command',
  );
  if (
    !CANCELLATION_DISPATCH_RESULTS.includes(
      command.result as CancellationDispatchResult,
    )
  ) {
    throw new InvalidCancellationDispatchCommandError('result is invalid');
  }
  return Object.freeze({
    runId: identifier(command.runId, 'runId', 36),
    attemptId: identifier(command.attemptId, 'attemptId', 36),
    owner: identifier(command.owner, 'owner', 128),
    leaseToken: identifier(command.leaseToken, 'leaseToken', 128),
    expectedVersion: integer(
      command.expectedVersion,
      'expectedVersion',
      1,
      2_147_483_647,
    ),
    result: command.result as CancellationDispatchResult,
    ...(retryable
      ? {
          retryDelayMs: integer(
            command.retryDelayMs,
            'retryDelayMs',
            1,
            MAX_CANCELLATION_DISPATCH_RETRY_DELAY_MS,
          ),
        }
      : {}),
    eventId: identifier(command.eventId, 'eventId', 36),
  });
}

export function cancellationDispatchResultState(
  result: CancellationDispatchResult,
): Readonly<{
  status: Extract<
    CancellationDispatchStatus,
    'retry_wait' | 'dispatched' | 'blocked'
  >;
  eventType:
    | 'run.cancel_dispatch_failed'
    | 'run.cancel_dispatched'
    | 'run.cancel_dispatch_blocked';
}> {
  if (
    CANCELLATION_DISPATCH_RETRYABLE_RESULTS.includes(
      result as (typeof CANCELLATION_DISPATCH_RETRYABLE_RESULTS)[number],
    )
  ) {
    return Object.freeze({
      status: 'retry_wait',
      eventType: 'run.cancel_dispatch_failed',
    });
  }
  if (
    CANCELLATION_DISPATCH_BLOCKING_RESULTS.includes(
      result as (typeof CANCELLATION_DISPATCH_BLOCKING_RESULTS)[number],
    )
  ) {
    return Object.freeze({
      status: 'blocked',
      eventType: 'run.cancel_dispatch_blocked',
    });
  }
  if (!CANCELLATION_DISPATCH_RESULTS.includes(result)) {
    throw new InvalidCancellationDispatchCommandError('result is invalid');
  }
  return Object.freeze({
    status: 'dispatched',
    eventType: 'run.cancel_dispatched',
  });
}

export function normalizeCancellationDispatchRecord(
  value: CancellationDispatchRecord,
): Readonly<CancellationDispatchRecord> {
  const dispatch = record(value, 'dispatch record');
  const optionalKeys = [
    'nextAttemptAtMs',
    'leaseOwner',
    'leaseTokenDigest',
    'leaseExpiresAtMs',
    'lastResult',
    'lastDispatchedAtMs',
  ].filter((key) => dispatch[key] !== undefined);
  exactKeys(
    dispatch,
    [
      'runId',
      'attemptId',
      'status',
      'version',
      'dispatchCount',
      ...optionalKeys,
      'createdAtMs',
      'updatedAtMs',
    ],
    'dispatch record',
  );
  if (
    !CANCELLATION_DISPATCH_STATUSES.includes(
      dispatch.status as CancellationDispatchStatus,
    )
  ) {
    throw new InvalidCancellationDispatchCommandError('status is invalid');
  }
  const status = dispatch.status as CancellationDispatchStatus;
  const createdAtMs = integer(dispatch.createdAtMs, 'createdAtMs', 0);
  const updatedAtMs = integer(dispatch.updatedAtMs, 'updatedAtMs', createdAtMs);
  const version = integer(dispatch.version, 'version', 0, 2_147_483_647);
  const dispatchCount = integer(
    dispatch.dispatchCount,
    'dispatchCount',
    0,
    2_147_483_647,
  );
  const lastResult = dispatch.lastResult as
    | CancellationDispatchResult
    | undefined;
  const hasLease =
    dispatch.leaseOwner !== undefined ||
    dispatch.leaseTokenDigest !== undefined ||
    dispatch.leaseExpiresAtMs !== undefined;
  if (
    (status === 'leased' &&
      (typeof dispatch.leaseTokenDigest !== 'string' ||
        !SHA256_PATTERN.test(dispatch.leaseTokenDigest) ||
        dispatch.leaseOwner === undefined ||
        dispatch.leaseExpiresAtMs === undefined)) ||
    (status !== 'leased' && hasLease) ||
    ((status === 'pending' || status === 'retry_wait') &&
      dispatch.nextAttemptAtMs === undefined) ||
    ((status === 'leased' || status === 'dispatched' || status === 'blocked') &&
      dispatch.nextAttemptAtMs !== undefined) ||
    ((status === 'dispatched' || status === 'blocked') &&
      lastResult === undefined) ||
    (status === 'pending' &&
      (version !== 0 || dispatchCount !== 0 || lastResult !== undefined)) ||
    (status !== 'pending' && dispatchCount < 1) ||
    version < dispatchCount ||
    (status === 'leased' &&
      lastResult !== undefined &&
      !CANCELLATION_DISPATCH_RETRY_HISTORY_RESULTS.has(lastResult)) ||
    (status === 'retry_wait' &&
      (lastResult === undefined ||
        !CANCELLATION_DISPATCH_RETRY_HISTORY_RESULTS.has(lastResult))) ||
    (status === 'dispatched' &&
      lastResult !== 'termination_requested' &&
      lastResult !== 'already_exited') ||
    (status === 'blocked' &&
      !CANCELLATION_DISPATCH_BLOCKING_RESULTS.includes(
        lastResult as (typeof CANCELLATION_DISPATCH_BLOCKING_RESULTS)[number],
      ))
  ) {
    throw new InvalidCancellationDispatchCommandError(
      'dispatch state is inconsistent',
    );
  }
  if (
    dispatch.lastResult !== undefined &&
    !CANCELLATION_DISPATCH_RESULTS.includes(
      dispatch.lastResult as CancellationDispatchResult,
    )
  ) {
    throw new InvalidCancellationDispatchCommandError('lastResult is invalid');
  }
  return Object.freeze({
    runId: identifier(dispatch.runId, 'runId', 36),
    attemptId: identifier(dispatch.attemptId, 'attemptId', 36),
    status,
    version,
    dispatchCount,
    ...(dispatch.nextAttemptAtMs === undefined
      ? {}
      : {
          nextAttemptAtMs: integer(
            dispatch.nextAttemptAtMs,
            'nextAttemptAtMs',
            0,
          ),
        }),
    ...(dispatch.leaseOwner === undefined
      ? {}
      : { leaseOwner: identifier(dispatch.leaseOwner, 'leaseOwner', 128) }),
    ...(dispatch.leaseTokenDigest === undefined
      ? {}
      : { leaseTokenDigest: dispatch.leaseTokenDigest as string }),
    ...(dispatch.leaseExpiresAtMs === undefined
      ? {}
      : {
          leaseExpiresAtMs: integer(
            dispatch.leaseExpiresAtMs,
            'leaseExpiresAtMs',
            0,
          ),
        }),
    ...(lastResult === undefined
      ? {}
      : { lastResult }),
    ...(dispatch.lastDispatchedAtMs === undefined
      ? {}
      : {
          lastDispatchedAtMs: integer(
            dispatch.lastDispatchedAtMs,
            'lastDispatchedAtMs',
            0,
          ),
        }),
    createdAtMs,
    updatedAtMs,
  });
}
