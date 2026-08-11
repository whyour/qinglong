import { createHash } from 'node:crypto';

import {
  approvedActionDispatchDigest,
  normalizeApprovedActionDispatchRecord,
  type ApprovedActionDispatchRecord,
} from './approvedAction';

export const APPROVED_ACTION_EXECUTION_SCHEMA =
  'qinglong/approved-action-execution@v1' as const;
export const APPROVED_ACTION_EXECUTION_STATUSES = [
  'pending',
  'leased',
  'executing',
  'retry_wait',
  'succeeded',
  'failed',
  'blocked',
] as const;

export type ApprovedActionExecutionStatus =
  (typeof APPROVED_ACTION_EXECUTION_STATUSES)[number];
export type ApprovedActionExecutionEffectiveStatus =
  | ApprovedActionExecutionStatus
  | 'recovery_required';

export interface ApprovedActionExecutionRecord {
  readonly schema: typeof APPROVED_ACTION_EXECUTION_SCHEMA;
  readonly dispatchId: string;
  readonly dispatchDigest: string;
  readonly projectId: string;
  readonly status: ApprovedActionExecutionStatus;
  readonly version: number;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly eligibleAtMs: number | null;
  readonly nextAttemptAtMs: number | null;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly resultMutationId: string | null;
  readonly resultCode: string | null;
  readonly resultDigest: string | null;
  readonly completedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly executionDigest: string;
}

export interface ApprovedActionExecutionSnapshot {
  readonly dispatch: Readonly<ApprovedActionDispatchRecord>;
  readonly execution: Readonly<ApprovedActionExecutionRecord>;
}

export interface ApprovedActionExecutionCursor {
  readonly eligibleAtMs: number;
  readonly dispatchId: string;
}

export interface ListDueApprovedActionExecutionsQuery {
  readonly nowMs: number;
  readonly limit: number;
  readonly actionTypes: readonly string[];
  readonly cursor?: ApprovedActionExecutionCursor;
}

export interface ListDueApprovedActionExecutionsResult {
  readonly executions: readonly Readonly<ApprovedActionExecutionSnapshot>[];
  readonly truncated: boolean;
  readonly nextCursor?: Readonly<ApprovedActionExecutionCursor>;
}

export interface ClaimApprovedActionExecutionCommand {
  readonly dispatchId: string;
  readonly owner: string;
  readonly leaseToken: string;
  readonly nowMs: number;
  readonly leaseDurationMs: number;
}

export type ClaimApprovedActionExecutionResult =
  | Readonly<{
      status: 'claimed';
      snapshot: Readonly<ApprovedActionExecutionSnapshot>;
    }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{
      status:
        | 'not_due'
        | 'leased'
        | 'executing'
        | 'recovery_required'
        | 'succeeded'
        | 'failed'
        | 'blocked';
      snapshot: Readonly<ApprovedActionExecutionSnapshot>;
    }>;

export interface StartApprovedActionExecutionCommand {
  readonly dispatchId: string;
  readonly approvalRequestId: string;
  readonly actionDigest: string;
  readonly owner: string;
  readonly leaseToken: string;
  readonly expectedVersion: number;
  readonly startedAtMs: number;
}

export interface RenewApprovedActionExecutionCommand {
  readonly dispatchId: string;
  readonly owner: string;
  readonly leaseToken: string;
  readonly expectedVersion: number;
  readonly nowMs: number;
  readonly leaseDurationMs: number;
}

export interface ReleaseApprovedActionExecutionBeforeStartCommand {
  readonly dispatchId: string;
  readonly owner: string;
  readonly leaseToken: string;
  readonly expectedVersion: number;
  readonly resultMutationId: string;
  readonly resultCode: string;
  readonly atMs: number;
  readonly retryAtMs?: number;
}

export interface CompleteApprovedActionExecutionCommand {
  readonly dispatchId: string;
  readonly owner: string;
  readonly leaseToken: string;
  readonly expectedVersion: number;
  readonly resultMutationId: string;
  readonly outcome: 'succeeded' | 'failed' | 'indeterminate';
  readonly resultCode: string;
  readonly resultDigest?: string;
  readonly completedAtMs: number;
}

export interface ApprovedActionExecutionRepository {
  findExecutionByDispatchId(
    dispatchId: string,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot> | null>;
  listDueExecutions(
    query: ListDueApprovedActionExecutionsQuery,
  ): Promise<ListDueApprovedActionExecutionsResult>;
  claimExecution(
    command: ClaimApprovedActionExecutionCommand,
  ): Promise<ClaimApprovedActionExecutionResult>;
  startExecution(
    command: StartApprovedActionExecutionCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>>;
  renewExecution(
    command: RenewApprovedActionExecutionCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>>;
  releaseExecutionBeforeStart(
    command: ReleaseApprovedActionExecutionBeforeStartCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>>;
  completeExecution(
    command: CompleteApprovedActionExecutionCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>>;
}

export const DEFAULT_APPROVED_ACTION_MAX_ATTEMPTS = 5;
export const MAX_APPROVED_ACTION_ATTEMPTS = 16;
export const MAX_APPROVED_ACTION_EXECUTION_VERSION = 2_147_483_647;
export const MAX_APPROVED_ACTION_LEASE_ID_LENGTH = 128;
export const MAX_APPROVED_ACTION_RESULT_CODE_LENGTH = 64;
export const MAX_APPROVED_ACTION_EXECUTION_PAGE_SIZE = 64;
export const MAX_APPROVED_ACTION_LEASE_DURATION_MS = 10 * 60 * 1000;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESULT_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export class InvalidApprovedActionExecutionError extends TypeError {
  readonly code = 'APPROVED_ACTION_EXECUTION_INVALID';

  constructor(message: string) {
    super(`Approved Action execution is invalid: ${message}`);
    this.name = 'InvalidApprovedActionExecutionError';
  }
}

export class ApprovedActionExecutionFenceConflictError extends Error {
  readonly code = 'APPROVED_ACTION_EXECUTION_FENCE_CONFLICT';

  constructor() {
    super('Approved Action execution fence changed');
    this.name = 'ApprovedActionExecutionFenceConflictError';
  }
}

export class ApprovedActionExecutionStateConflictError extends Error {
  readonly code = 'APPROVED_ACTION_EXECUTION_STATE_CONFLICT';

  constructor() {
    super('Approved Action execution is not in the required state');
    this.name = 'ApprovedActionExecutionStateConflictError';
  }
}

export class ApprovedActionExecutionBindingConflictError extends Error {
  readonly code = 'APPROVED_ACTION_EXECUTION_BINDING_CONFLICT';

  constructor() {
    super('Approved Action execution does not match its dispatch');
    this.name = 'ApprovedActionExecutionBindingConflictError';
  }
}

export class ApprovedActionExecutionUnavailableError extends Error {
  readonly code = 'APPROVED_ACTION_EXECUTION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Approved Action execution authority is unavailable', options);
    this.name = 'ApprovedActionExecutionUnavailableError';
  }
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidApprovedActionExecutionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  const allowed = new Set([...expected, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    throw new InvalidApprovedActionExecutionError(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidApprovedActionExecutionError(`${label} is invalid`);
  }
  return value;
}

function resultCode(value: unknown): string {
  if (typeof value !== 'string' || !RESULT_CODE_PATTERN.test(value)) {
    throw new InvalidApprovedActionExecutionError('result code is invalid');
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidApprovedActionExecutionError(`${label} is invalid`);
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new InvalidApprovedActionExecutionError(`${label} is invalid`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  return integer(value, label, 0, Number.MAX_SAFE_INTEGER);
}

function nullableTimestamp(value: unknown, label: string): number | null {
  return value === null ? null : timestamp(value, label);
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : identifier(value, label);
}

function nullableResultCode(value: unknown): string | null {
  return value === null ? null : resultCode(value);
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : digest(value, label);
}

function contractDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(value))
    .digest('hex');
}

function withoutExecutionDigest(
  value: Omit<ApprovedActionExecutionRecord, 'executionDigest'>,
): Omit<ApprovedActionExecutionRecord, 'executionDigest'> {
  return Object.freeze(value);
}

function withExecutionDigest(
  value: Omit<ApprovedActionExecutionRecord, 'executionDigest'>,
): Readonly<ApprovedActionExecutionRecord> {
  const normalized = withoutExecutionDigest(value);
  return Object.freeze({
    ...normalized,
    executionDigest: contractDigest(
      'qinglong/approved-action-execution-digest@v1',
      normalized,
    ),
  });
}

function executionWithoutDigest(
  value: Readonly<ApprovedActionExecutionRecord>,
): Omit<ApprovedActionExecutionRecord, 'executionDigest'> {
  const { executionDigest: _executionDigest, ...record } = value;
  return record;
}

function sameLease(
  record: Readonly<ApprovedActionExecutionRecord>,
  owner: string,
  leaseToken: string,
  expectedVersion: number,
): boolean {
  return (
    record.leaseOwner === owner &&
    record.leaseToken === leaseToken &&
    record.version === expectedVersion
  );
}

export function createApprovedActionExecution(
  dispatchValue: ApprovedActionDispatchRecord,
  maxAttempts = DEFAULT_APPROVED_ACTION_MAX_ATTEMPTS,
): Readonly<ApprovedActionExecutionRecord> {
  const dispatch = normalizeApprovedActionDispatchRecord(dispatchValue);
  return withExecutionDigest({
    schema: APPROVED_ACTION_EXECUTION_SCHEMA,
    dispatchId: dispatch.id,
    dispatchDigest: approvedActionDispatchDigest(dispatch),
    projectId: dispatch.projectId,
    status: 'pending',
    version: 0,
    attemptCount: 0,
    maxAttempts: integer(
      maxAttempts,
      'maximum attempts',
      1,
      MAX_APPROVED_ACTION_ATTEMPTS,
    ),
    eligibleAtMs: dispatch.createdAtMs,
    nextAttemptAtMs: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAtMs: null,
    startedAtMs: null,
    resultMutationId: null,
    resultCode: null,
    resultDigest: null,
    completedAtMs: null,
    createdAtMs: dispatch.createdAtMs,
    updatedAtMs: dispatch.createdAtMs,
  });
}

export function normalizeApprovedActionExecutionRecord(
  value: ApprovedActionExecutionRecord,
): Readonly<ApprovedActionExecutionRecord> {
  const record = dataRecord(value, 'record');
  exactKeys(
    record,
    [
      'schema',
      'dispatchId',
      'dispatchDigest',
      'projectId',
      'status',
      'version',
      'attemptCount',
      'maxAttempts',
      'eligibleAtMs',
      'nextAttemptAtMs',
      'leaseOwner',
      'leaseToken',
      'leaseExpiresAtMs',
      'startedAtMs',
      'resultMutationId',
      'resultCode',
      'resultDigest',
      'completedAtMs',
      'createdAtMs',
      'updatedAtMs',
      'executionDigest',
    ],
    [],
    'record',
  );
  if (
    value.schema !== APPROVED_ACTION_EXECUTION_SCHEMA ||
    !APPROVED_ACTION_EXECUTION_STATUSES.includes(value.status)
  ) {
    throw new InvalidApprovedActionExecutionError(
      'schema or status is invalid',
    );
  }
  const normalized = {
    schema: APPROVED_ACTION_EXECUTION_SCHEMA,
    dispatchId: identifier(value.dispatchId, 'dispatch id'),
    dispatchDigest: digest(value.dispatchDigest, 'dispatch digest'),
    projectId: identifier(value.projectId, 'project id'),
    status: value.status,
    version: integer(
      value.version,
      'version',
      0,
      MAX_APPROVED_ACTION_EXECUTION_VERSION,
    ),
    attemptCount: integer(
      value.attemptCount,
      'attempt count',
      0,
      MAX_APPROVED_ACTION_ATTEMPTS,
    ),
    maxAttempts: integer(
      value.maxAttempts,
      'maximum attempts',
      1,
      MAX_APPROVED_ACTION_ATTEMPTS,
    ),
    eligibleAtMs: nullableTimestamp(value.eligibleAtMs, 'eligible time'),
    nextAttemptAtMs: nullableTimestamp(
      value.nextAttemptAtMs,
      'next attempt time',
    ),
    leaseOwner: nullableIdentifier(value.leaseOwner, 'lease owner'),
    leaseToken: nullableIdentifier(value.leaseToken, 'lease token'),
    leaseExpiresAtMs: nullableTimestamp(
      value.leaseExpiresAtMs,
      'lease expiry',
    ),
    startedAtMs: nullableTimestamp(value.startedAtMs, 'start time'),
    resultMutationId: nullableIdentifier(
      value.resultMutationId,
      'result mutation id',
    ),
    resultCode: nullableResultCode(value.resultCode),
    resultDigest: nullableDigest(value.resultDigest, 'result digest'),
    completedAtMs: nullableTimestamp(value.completedAtMs, 'completion time'),
    createdAtMs: timestamp(value.createdAtMs, 'creation time'),
    updatedAtMs: timestamp(value.updatedAtMs, 'update time'),
  } satisfies Omit<ApprovedActionExecutionRecord, 'executionDigest'>;
  const executionDigest = digest(value.executionDigest, 'execution digest');
  if (
    normalized.attemptCount > normalized.maxAttempts ||
    normalized.updatedAtMs < normalized.createdAtMs
  ) {
    throw new InvalidApprovedActionExecutionError(
      'attempt or timestamp range is invalid',
    );
  }

  const leaseValues = [
    normalized.leaseOwner,
    normalized.leaseToken,
    normalized.leaseExpiresAtMs,
  ];
  const hasLease = leaseValues.every((entry) => entry !== null);
  if (
    leaseValues.some((entry) => entry !== null) !== hasLease ||
    (hasLease &&
      (normalized.leaseExpiresAtMs! <= normalized.updatedAtMs ||
        normalized.leaseExpiresAtMs! - normalized.updatedAtMs >
          MAX_APPROVED_ACTION_LEASE_DURATION_MS))
  ) {
    throw new InvalidApprovedActionExecutionError('lease tuple is invalid');
  }

  const resultValues = [
    normalized.resultMutationId,
    normalized.resultCode,
  ];
  const hasResult = resultValues.every((entry) => entry !== null);
  if (resultValues.some((entry) => entry !== null) !== hasResult) {
    throw new InvalidApprovedActionExecutionError('result tuple is invalid');
  }
  const terminal = ['succeeded', 'failed', 'blocked'].includes(
    normalized.status,
  );
  if (
    (normalized.status === 'pending' &&
      (normalized.version !== 0 ||
        normalized.attemptCount !== 0 ||
        normalized.eligibleAtMs === null ||
        normalized.nextAttemptAtMs !== null ||
        hasLease ||
        normalized.startedAtMs !== null ||
        hasResult ||
        normalized.resultDigest !== null ||
        normalized.completedAtMs !== null)) ||
    (normalized.status === 'leased' &&
      (!hasLease ||
        normalized.attemptCount < 1 ||
        normalized.eligibleAtMs !== normalized.leaseExpiresAtMs ||
        normalized.nextAttemptAtMs !== null ||
        normalized.startedAtMs !== null ||
        hasResult ||
        normalized.resultDigest !== null ||
        normalized.completedAtMs !== null)) ||
    (normalized.status === 'executing' &&
      (!hasLease ||
        normalized.attemptCount < 1 ||
        normalized.eligibleAtMs !== null ||
        normalized.nextAttemptAtMs !== null ||
        normalized.startedAtMs === null ||
        hasResult ||
        normalized.resultDigest !== null ||
        normalized.completedAtMs !== null)) ||
    (normalized.status === 'retry_wait' &&
      (hasLease ||
        normalized.attemptCount < 1 ||
        normalized.attemptCount >= normalized.maxAttempts ||
        normalized.eligibleAtMs === null ||
        normalized.eligibleAtMs !== normalized.nextAttemptAtMs ||
        normalized.startedAtMs !== null ||
        !hasResult ||
        normalized.resultDigest !== null ||
        normalized.completedAtMs !== null)) ||
    (terminal &&
      (hasLease ||
        normalized.eligibleAtMs !== null ||
        normalized.nextAttemptAtMs !== null ||
        !hasResult ||
        normalized.completedAtMs === null))
  ) {
    throw new InvalidApprovedActionExecutionError(
      `${normalized.status} tuple is invalid`,
    );
  }
  if (
    normalized.status === 'succeeded' &&
    (normalized.startedAtMs === null || normalized.resultDigest === null)
  ) {
    throw new InvalidApprovedActionExecutionError(
      'successful execution has no start barrier or result digest',
    );
  }
  if (
    normalized.status === 'failed' &&
    normalized.startedAtMs === null
  ) {
    throw new InvalidApprovedActionExecutionError(
      'failed execution has no start barrier',
    );
  }
  if (
    normalized.startedAtMs !== null &&
    (normalized.startedAtMs < normalized.createdAtMs ||
      normalized.startedAtMs > normalized.updatedAtMs)
  ) {
    throw new InvalidApprovedActionExecutionError(
      'start timestamp is invalid',
    );
  }
  if (
    normalized.completedAtMs !== null &&
    (normalized.completedAtMs <
      (normalized.startedAtMs ?? normalized.createdAtMs) ||
      normalized.completedAtMs !== normalized.updatedAtMs)
  ) {
    throw new InvalidApprovedActionExecutionError(
      'completion timestamp is invalid',
    );
  }
  if (
    executionDigest !==
    contractDigest(
      'qinglong/approved-action-execution-digest@v1',
      normalized,
    )
  ) {
    throw new InvalidApprovedActionExecutionError(
      'execution digest does not match the record',
    );
  }
  return Object.freeze({ ...normalized, executionDigest });
}

export function normalizeApprovedActionExecutionSnapshot(
  value: ApprovedActionExecutionSnapshot,
): Readonly<ApprovedActionExecutionSnapshot> {
  const snapshot = dataRecord(value, 'snapshot');
  exactKeys(snapshot, ['dispatch', 'execution'], [], 'snapshot');
  const dispatch = normalizeApprovedActionDispatchRecord(value.dispatch);
  const execution = normalizeApprovedActionExecutionRecord(value.execution);
  if (
    execution.dispatchId !== dispatch.id ||
    execution.dispatchDigest !== approvedActionDispatchDigest(dispatch) ||
    execution.projectId !== dispatch.projectId
  ) {
    throw new ApprovedActionExecutionBindingConflictError();
  }
  return Object.freeze({ dispatch, execution });
}

export function normalizeApprovedActionExecutionCursor(
  value: ApprovedActionExecutionCursor,
): Readonly<ApprovedActionExecutionCursor> {
  const cursor = dataRecord(value, 'cursor');
  exactKeys(cursor, ['eligibleAtMs', 'dispatchId'], [], 'cursor');
  return Object.freeze({
    eligibleAtMs: timestamp(value.eligibleAtMs, 'cursor eligible time'),
    dispatchId: identifier(value.dispatchId, 'cursor dispatch id'),
  });
}

export function approvedActionExecutionEffectiveStatus(
  recordValue: ApprovedActionExecutionRecord,
  nowMsValue: number,
): ApprovedActionExecutionEffectiveStatus {
  const record = normalizeApprovedActionExecutionRecord(recordValue);
  const nowMs = timestamp(nowMsValue, 'observation time');
  if (
    record.status === 'executing' &&
    record.leaseExpiresAtMs !== null &&
    nowMs >= record.leaseExpiresAtMs
  ) {
    return 'recovery_required';
  }
  return record.status;
}

export function claimApprovedActionExecution(
  recordValue: ApprovedActionExecutionRecord,
  commandValue: Omit<ClaimApprovedActionExecutionCommand, 'dispatchId'>,
): Readonly<ApprovedActionExecutionRecord> {
  const record = normalizeApprovedActionExecutionRecord(recordValue);
  const command = dataRecord(commandValue, 'claim command');
  exactKeys(
    command,
    ['owner', 'leaseToken', 'nowMs', 'leaseDurationMs'],
    [],
    'claim command',
  );
  const owner = identifier(commandValue.owner, 'lease owner');
  const leaseToken = identifier(commandValue.leaseToken, 'lease token');
  const nowMs = timestamp(commandValue.nowMs, 'claim time');
  const leaseDurationMs = integer(
    commandValue.leaseDurationMs,
    'lease duration',
    1,
    MAX_APPROVED_ACTION_LEASE_DURATION_MS,
  );
  const due =
    (record.status === 'pending' || record.status === 'retry_wait') &&
    record.eligibleAtMs !== null &&
    record.eligibleAtMs <= nowMs;
  const reclaimable =
    record.status === 'leased' &&
    record.leaseExpiresAtMs !== null &&
    record.leaseExpiresAtMs <= nowMs;
  if (!due && !reclaimable) {
    throw new ApprovedActionExecutionStateConflictError();
  }
  if (record.attemptCount >= record.maxAttempts) {
    throw new ApprovedActionExecutionStateConflictError();
  }
  const leaseExpiresAtMs = Math.min(
    Number.MAX_SAFE_INTEGER,
    nowMs + leaseDurationMs,
  );
  return withExecutionDigest({
    ...executionWithoutDigest(record),
    status: 'leased',
    version: record.version + 1,
    attemptCount: record.attemptCount + 1,
    eligibleAtMs: leaseExpiresAtMs,
    nextAttemptAtMs: null,
    leaseOwner: owner,
    leaseToken,
    leaseExpiresAtMs,
    startedAtMs: null,
    resultMutationId: null,
    resultCode: null,
    resultDigest: null,
    completedAtMs: null,
    updatedAtMs: nowMs,
  });
}

export function startApprovedActionExecution(
  snapshotValue: ApprovedActionExecutionSnapshot,
  commandValue: StartApprovedActionExecutionCommand,
): Readonly<ApprovedActionExecutionRecord> {
  const snapshot = normalizeApprovedActionExecutionSnapshot(snapshotValue);
  const command = dataRecord(commandValue, 'start command');
  exactKeys(
    command,
    [
      'dispatchId',
      'approvalRequestId',
      'actionDigest',
      'owner',
      'leaseToken',
      'expectedVersion',
      'startedAtMs',
    ],
    [],
    'start command',
  );
  const dispatchId = identifier(commandValue.dispatchId, 'dispatch id');
  const approvalRequestId = identifier(
    commandValue.approvalRequestId,
    'approval request id',
  );
  const actionDigest = digest(commandValue.actionDigest, 'action digest');
  const owner = identifier(commandValue.owner, 'lease owner');
  const leaseToken = identifier(commandValue.leaseToken, 'lease token');
  const expectedVersion = integer(
    commandValue.expectedVersion,
    'expected version',
    0,
    MAX_APPROVED_ACTION_EXECUTION_VERSION,
  );
  const startedAtMs = timestamp(commandValue.startedAtMs, 'start time');
  if (
    snapshot.execution.status !== 'leased' ||
    !sameLease(snapshot.execution, owner, leaseToken, expectedVersion) ||
    dispatchId !== snapshot.dispatch.id ||
    approvalRequestId !== snapshot.dispatch.approvalRequestId ||
    actionDigest !== snapshot.dispatch.action.actionDigest ||
    snapshot.execution.leaseExpiresAtMs === null ||
    startedAtMs < snapshot.execution.updatedAtMs ||
    startedAtMs >= snapshot.execution.leaseExpiresAtMs
  ) {
    throw new ApprovedActionExecutionFenceConflictError();
  }
  return withExecutionDigest({
    ...executionWithoutDigest(snapshot.execution),
    status: 'executing',
    version: snapshot.execution.version + 1,
    eligibleAtMs: null,
    startedAtMs,
    updatedAtMs: startedAtMs,
  });
}

export function renewApprovedActionExecution(
  recordValue: ApprovedActionExecutionRecord,
  commandValue: Omit<RenewApprovedActionExecutionCommand, 'dispatchId'>,
): Readonly<ApprovedActionExecutionRecord> {
  const record = normalizeApprovedActionExecutionRecord(recordValue);
  const command = dataRecord(commandValue, 'renew command');
  exactKeys(
    command,
    ['owner', 'leaseToken', 'expectedVersion', 'nowMs', 'leaseDurationMs'],
    [],
    'renew command',
  );
  const owner = identifier(commandValue.owner, 'lease owner');
  const leaseToken = identifier(commandValue.leaseToken, 'lease token');
  const expectedVersion = integer(
    commandValue.expectedVersion,
    'expected version',
    0,
    MAX_APPROVED_ACTION_EXECUTION_VERSION,
  );
  const nowMs = timestamp(commandValue.nowMs, 'renewal time');
  const leaseDurationMs = integer(
    commandValue.leaseDurationMs,
    'lease duration',
    1,
    MAX_APPROVED_ACTION_LEASE_DURATION_MS,
  );
  if (
    (record.status !== 'leased' && record.status !== 'executing') ||
    !sameLease(record, owner, leaseToken, expectedVersion) ||
    record.leaseExpiresAtMs === null ||
    nowMs < record.updatedAtMs ||
    nowMs >= record.leaseExpiresAtMs
  ) {
    throw new ApprovedActionExecutionFenceConflictError();
  }
  const leaseExpiresAtMs = Math.min(
    Number.MAX_SAFE_INTEGER,
    nowMs + leaseDurationMs,
  );
  return withExecutionDigest({
    ...executionWithoutDigest(record),
    version: record.version + 1,
    eligibleAtMs:
      record.status === 'leased' ? leaseExpiresAtMs : record.eligibleAtMs,
    leaseExpiresAtMs,
    updatedAtMs: nowMs,
  });
}

export function releaseApprovedActionExecutionBeforeStart(
  recordValue: ApprovedActionExecutionRecord,
  commandValue: Omit<
    ReleaseApprovedActionExecutionBeforeStartCommand,
    'dispatchId'
  >,
): Readonly<ApprovedActionExecutionRecord> {
  const record = normalizeApprovedActionExecutionRecord(recordValue);
  const command = dataRecord(commandValue, 'release command');
  exactKeys(
    command,
    [
      'owner',
      'leaseToken',
      'expectedVersion',
      'resultMutationId',
      'resultCode',
      'atMs',
    ],
    ['retryAtMs'],
    'release command',
  );
  const owner = identifier(commandValue.owner, 'lease owner');
  const leaseToken = identifier(commandValue.leaseToken, 'lease token');
  const expectedVersion = integer(
    commandValue.expectedVersion,
    'expected version',
    0,
    MAX_APPROVED_ACTION_EXECUTION_VERSION,
  );
  const resultMutationId = identifier(
    commandValue.resultMutationId,
    'result mutation id',
  );
  const normalizedResultCode = resultCode(commandValue.resultCode);
  const atMs = timestamp(commandValue.atMs, 'release time');
  const retryAtMs =
    commandValue.retryAtMs === undefined
      ? undefined
      : timestamp(commandValue.retryAtMs, 'retry time');
  if (
    record.status !== 'leased' ||
    !sameLease(record, owner, leaseToken, expectedVersion) ||
    record.startedAtMs !== null ||
    atMs < record.updatedAtMs ||
    (retryAtMs !== undefined && retryAtMs <= atMs)
  ) {
    throw new ApprovedActionExecutionFenceConflictError();
  }
  const retry =
    retryAtMs !== undefined && record.attemptCount < record.maxAttempts;
  return withExecutionDigest({
    ...executionWithoutDigest(record),
    status: retry ? 'retry_wait' : 'blocked',
    version: record.version + 1,
    eligibleAtMs: retry ? retryAtMs! : null,
    nextAttemptAtMs: retry ? retryAtMs! : null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAtMs: null,
    resultMutationId,
    resultCode: normalizedResultCode,
    resultDigest: null,
    completedAtMs: retry ? null : atMs,
    updatedAtMs: atMs,
  });
}

export function completeApprovedActionExecution(
  recordValue: ApprovedActionExecutionRecord,
  commandValue: Omit<CompleteApprovedActionExecutionCommand, 'dispatchId'>,
): Readonly<ApprovedActionExecutionRecord> {
  const record = normalizeApprovedActionExecutionRecord(recordValue);
  const command = dataRecord(commandValue, 'complete command');
  exactKeys(
    command,
    [
      'owner',
      'leaseToken',
      'expectedVersion',
      'resultMutationId',
      'outcome',
      'resultCode',
      'completedAtMs',
    ],
    ['resultDigest'],
    'complete command',
  );
  const owner = identifier(commandValue.owner, 'lease owner');
  const leaseToken = identifier(commandValue.leaseToken, 'lease token');
  const expectedVersion = integer(
    commandValue.expectedVersion,
    'expected version',
    0,
    MAX_APPROVED_ACTION_EXECUTION_VERSION,
  );
  const resultMutationId = identifier(
    commandValue.resultMutationId,
    'result mutation id',
  );
  const normalizedResultCode = resultCode(commandValue.resultCode);
  const completedAtMs = timestamp(commandValue.completedAtMs, 'completion time');
  const resultDigestValue =
    commandValue.resultDigest === undefined
      ? null
      : digest(commandValue.resultDigest, 'result digest');
  if (
    !['succeeded', 'failed', 'indeterminate'].includes(commandValue.outcome) ||
    record.status !== 'executing' ||
    !sameLease(record, owner, leaseToken, expectedVersion) ||
    record.startedAtMs === null ||
    completedAtMs < record.updatedAtMs ||
    (commandValue.outcome === 'succeeded' && resultDigestValue === null) ||
    (commandValue.outcome !== 'succeeded' && resultDigestValue !== null)
  ) {
    throw new ApprovedActionExecutionFenceConflictError();
  }
  const status =
    commandValue.outcome === 'indeterminate'
      ? 'blocked'
      : commandValue.outcome;
  return withExecutionDigest({
    ...executionWithoutDigest(record),
    status,
    version: record.version + 1,
    eligibleAtMs: null,
    nextAttemptAtMs: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAtMs: null,
    resultMutationId,
    resultCode: normalizedResultCode,
    resultDigest: resultDigestValue,
    completedAtMs,
    updatedAtMs: completedAtMs,
  });
}
