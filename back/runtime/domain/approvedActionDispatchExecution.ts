import {
  assertApprovalMutationId,
  assertApprovalTimestamp,
  type ApprovedActionDispatchRecord,
} from './approvalRequest';
import { assertProjectPolicyProjectId } from './projectPolicy';

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

export interface ApprovedActionDispatchExecutionRecord {
  dispatchId: string;
  projectId: string;
  status: ApprovedActionExecutionStatus;
  version: number;
  attemptCount: number;
  maxAttempts: number;
  eligibleAtMs: number | null;
  nextAttemptAtMs: number | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAtMs: number | null;
  startedAtMs: number | null;
  resultMutationId: string | null;
  lastResultCode: string | null;
  completedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ApprovedActionDispatchExecutionSnapshot {
  dispatch: Readonly<ApprovedActionDispatchRecord>;
  execution: Readonly<ApprovedActionDispatchExecutionRecord>;
}

export interface ApprovedActionDispatchCursor {
  eligibleAtMs: number;
  dispatchId: string;
}

export const DEFAULT_APPROVED_ACTION_MAX_ATTEMPTS = 5;
export const MAX_APPROVED_ACTION_ATTEMPTS = 16;
export const MAX_APPROVED_ACTION_EXECUTION_VERSION = 2_147_483_647;
export const MAX_APPROVED_ACTION_LEASE_ID_LENGTH = 128;
export const MAX_APPROVED_ACTION_RESULT_CODE_LENGTH = 64;
export const MAX_APPROVED_ACTION_DISPATCH_PAGE_SIZE = 64;
export const MAX_APPROVED_ACTION_LEASE_DURATION_MS = 10 * 60 * 1000;

const EXECUTION_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export class InvalidApprovedActionExecutionError extends TypeError {
  constructor(message: string) {
    super(`Approved action execution is invalid: ${message}`);
    this.name = 'InvalidApprovedActionExecutionError';
  }
}

export class ApprovedActionDispatchNotFoundError extends Error {
  readonly code = 'APPROVED_ACTION_DISPATCH_NOT_FOUND';

  constructor() {
    super('Approved action dispatch does not exist');
    this.name = 'ApprovedActionDispatchNotFoundError';
  }
}

export class ApprovedActionDispatchFenceRejectedError extends Error {
  readonly code = 'APPROVED_ACTION_DISPATCH_FENCE_REJECTED';

  constructor() {
    super('Approved action dispatch execution fence was rejected');
    this.name = 'ApprovedActionDispatchFenceRejectedError';
  }
}

export class ApprovedActionDispatchStateConflictError extends Error {
  readonly code = 'APPROVED_ACTION_DISPATCH_STATE_CONFLICT';

  constructor() {
    super('Approved action dispatch is not in the required execution state');
    this.name = 'ApprovedActionDispatchStateConflictError';
  }
}

export class ApprovedActionDispatchBindingConflictError extends Error {
  readonly code = 'APPROVED_ACTION_DISPATCH_BINDING_CONFLICT';

  constructor() {
    super('Approved action dispatch identity does not match its execution');
    this.name = 'ApprovedActionDispatchBindingConflictError';
  }
}

export class ApprovedActionDispatchRepositoryError extends Error {
  readonly code = 'APPROVED_ACTION_DISPATCH_REPOSITORY_ERROR';

  constructor() {
    super('Approved action dispatch repository is unavailable');
    this.name = 'ApprovedActionDispatchRepositoryError';
  }
}

function assertExactKeys(
  name: string,
  value: object,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidApprovedActionExecutionError(`${name} shape is invalid`);
  }
}

function assertInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new InvalidApprovedActionExecutionError(`${name} is invalid`);
  }
}

function assertNullableTimestamp(name: string, value: number | null): void {
  if (value !== null) assertApprovalTimestamp(name, value);
}

function assertNullableIdentifier(
  name: string,
  value: string | null,
  maximum: number,
): void {
  if (
    value !== null &&
    (typeof value !== 'string' ||
      value.length < 1 ||
      value.length > maximum ||
      !EXECUTION_IDENTIFIER_PATTERN.test(value))
  ) {
    throw new InvalidApprovedActionExecutionError(`${name} is invalid`);
  }
}

function allNull(values: readonly unknown[]): boolean {
  return values.every((value) => value === null);
}

function allPresent(values: readonly unknown[]): boolean {
  return values.every((value) => value !== null);
}

export function assertApprovedActionLeaseIdentity(value: string): void {
  if (typeof value !== 'string') {
    throw new InvalidApprovedActionExecutionError('lease identity is invalid');
  }
  assertNullableIdentifier(
    'lease identity',
    value,
    MAX_APPROVED_ACTION_LEASE_ID_LENGTH,
  );
}

export function assertApprovedActionResultCode(value: string): void {
  if (typeof value !== 'string') {
    throw new InvalidApprovedActionExecutionError('result code is invalid');
  }
  assertNullableIdentifier(
    'result code',
    value,
    MAX_APPROVED_ACTION_RESULT_CODE_LENGTH,
  );
}

export function assertApprovedActionLeaseDuration(value: number): void {
  assertInteger(
    'lease duration',
    value,
    1,
    MAX_APPROVED_ACTION_LEASE_DURATION_MS,
  );
}

export function assertApprovedActionPageSize(value: number): void {
  assertInteger('page size', value, 1, MAX_APPROVED_ACTION_DISPATCH_PAGE_SIZE);
}

export function normalizeApprovedActionDispatchCursor(
  value: ApprovedActionDispatchCursor,
): Readonly<ApprovedActionDispatchCursor> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovedActionExecutionError('cursor must be an object');
  }
  assertExactKeys('cursor', value, ['eligibleAtMs', 'dispatchId']);
  assertApprovalTimestamp('cursor eligibleAtMs', value.eligibleAtMs);
  assertApprovalMutationId(value.dispatchId);
  return Object.freeze({ ...value });
}

export function normalizeApprovedActionDispatchExecutionRecord(
  value: ApprovedActionDispatchExecutionRecord,
): Readonly<ApprovedActionDispatchExecutionRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovedActionExecutionError('record must be an object');
  }
  assertExactKeys('record', value, [
    'dispatchId',
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
    'lastResultCode',
    'completedAtMs',
    'createdAtMs',
    'updatedAtMs',
  ]);
  assertApprovalMutationId(value.dispatchId);
  assertProjectPolicyProjectId(value.projectId);
  if (!APPROVED_ACTION_EXECUTION_STATUSES.includes(value.status)) {
    throw new InvalidApprovedActionExecutionError('status is invalid');
  }
  assertInteger(
    'version',
    value.version,
    0,
    MAX_APPROVED_ACTION_EXECUTION_VERSION,
  );
  assertInteger(
    'attempt count',
    value.attemptCount,
    0,
    MAX_APPROVED_ACTION_ATTEMPTS,
  );
  assertInteger(
    'max attempts',
    value.maxAttempts,
    1,
    MAX_APPROVED_ACTION_ATTEMPTS,
  );
  if (value.attemptCount > value.maxAttempts) {
    throw new InvalidApprovedActionExecutionError(
      'attempt count exceeds its maximum',
    );
  }
  for (const [name, timestamp] of [
    ['eligibleAtMs', value.eligibleAtMs],
    ['nextAttemptAtMs', value.nextAttemptAtMs],
    ['leaseExpiresAtMs', value.leaseExpiresAtMs],
    ['startedAtMs', value.startedAtMs],
    ['completedAtMs', value.completedAtMs],
  ] as const) {
    assertNullableTimestamp(name, timestamp);
  }
  assertApprovalTimestamp('createdAtMs', value.createdAtMs);
  assertApprovalTimestamp('updatedAtMs', value.updatedAtMs);
  if (value.updatedAtMs < value.createdAtMs) {
    throw new InvalidApprovedActionExecutionError('timestamps are invalid');
  }
  assertNullableIdentifier(
    'lease owner',
    value.leaseOwner,
    MAX_APPROVED_ACTION_LEASE_ID_LENGTH,
  );
  assertNullableIdentifier(
    'lease token',
    value.leaseToken,
    MAX_APPROVED_ACTION_LEASE_ID_LENGTH,
  );
  assertNullableIdentifier('result mutation id', value.resultMutationId, 64);
  assertNullableIdentifier(
    'last result code',
    value.lastResultCode,
    MAX_APPROVED_ACTION_RESULT_CODE_LENGTH,
  );

  const leaseTuple = [
    value.leaseOwner,
    value.leaseToken,
    value.leaseExpiresAtMs,
  ];
  if (!allNull(leaseTuple) && !allPresent(leaseTuple)) {
    throw new InvalidApprovedActionExecutionError('lease tuple is incomplete');
  }
  const hasLease = allPresent(leaseTuple);
  if (
    hasLease &&
    (value.leaseExpiresAtMs! <= value.updatedAtMs ||
      value.leaseExpiresAtMs! - value.updatedAtMs >
        MAX_APPROVED_ACTION_LEASE_DURATION_MS)
  ) {
    throw new InvalidApprovedActionExecutionError('lease lifetime is invalid');
  }

  const terminal = ['succeeded', 'failed', 'blocked'].includes(value.status);
  if (
    value.status === 'pending' &&
    (value.version !== 0 ||
      value.attemptCount !== 0 ||
      value.eligibleAtMs === null ||
      value.nextAttemptAtMs !== null ||
      hasLease ||
      value.startedAtMs !== null ||
      value.resultMutationId !== null ||
      value.lastResultCode !== null ||
      value.completedAtMs !== null)
  ) {
    throw new InvalidApprovedActionExecutionError('pending tuple is invalid');
  }
  if (
    value.status === 'leased' &&
    (!hasLease ||
      value.attemptCount < 1 ||
      value.eligibleAtMs !== value.leaseExpiresAtMs ||
      value.nextAttemptAtMs !== null ||
      value.startedAtMs !== null ||
      value.resultMutationId !== null ||
      value.lastResultCode !== null ||
      value.completedAtMs !== null)
  ) {
    throw new InvalidApprovedActionExecutionError('leased tuple is invalid');
  }
  if (
    value.status === 'executing' &&
    (!hasLease ||
      value.attemptCount < 1 ||
      value.eligibleAtMs !== null ||
      value.nextAttemptAtMs !== null ||
      value.startedAtMs === null ||
      value.resultMutationId !== null ||
      value.lastResultCode !== null ||
      value.completedAtMs !== null)
  ) {
    throw new InvalidApprovedActionExecutionError('executing tuple is invalid');
  }
  if (
    value.status === 'retry_wait' &&
    (hasLease ||
      value.attemptCount < 1 ||
      value.attemptCount >= value.maxAttempts ||
      value.eligibleAtMs === null ||
      value.eligibleAtMs !== value.nextAttemptAtMs ||
      value.startedAtMs !== null ||
      value.resultMutationId === null ||
      value.lastResultCode === null ||
      value.completedAtMs !== null)
  ) {
    throw new InvalidApprovedActionExecutionError(
      'retry wait tuple is invalid',
    );
  }
  if (
    terminal &&
    (hasLease ||
      value.eligibleAtMs !== null ||
      value.nextAttemptAtMs !== null ||
      value.resultMutationId === null ||
      value.lastResultCode === null ||
      value.completedAtMs === null)
  ) {
    throw new InvalidApprovedActionExecutionError('terminal tuple is invalid');
  }
  if (
    (value.status === 'succeeded' || value.status === 'failed') &&
    value.startedAtMs === null
  ) {
    throw new InvalidApprovedActionExecutionError(
      'completed execution has no start barrier',
    );
  }
  if (
    value.startedAtMs !== null &&
    (value.startedAtMs < value.createdAtMs ||
      value.startedAtMs > value.updatedAtMs)
  ) {
    throw new InvalidApprovedActionExecutionError(
      'execution start timestamp is invalid',
    );
  }
  if (
    value.completedAtMs !== null &&
    (value.completedAtMs < (value.startedAtMs ?? value.createdAtMs) ||
      value.completedAtMs !== value.updatedAtMs)
  ) {
    throw new InvalidApprovedActionExecutionError(
      'completion timestamp is invalid',
    );
  }
  return Object.freeze({ ...value });
}

export function approvedActionExecutionEffectiveStatus(
  record: Readonly<ApprovedActionDispatchExecutionRecord>,
  nowMs: number,
): ApprovedActionExecutionEffectiveStatus {
  const normalized = normalizeApprovedActionDispatchExecutionRecord(record);
  assertApprovalTimestamp('nowMs', nowMs);
  if (
    normalized.status === 'executing' &&
    normalized.leaseExpiresAtMs !== null &&
    nowMs >= normalized.leaseExpiresAtMs
  ) {
    return 'recovery_required';
  }
  return normalized.status;
}
