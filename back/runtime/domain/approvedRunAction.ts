import { createHash } from 'crypto';
import { EXECUTOR_TYPES, type ExecutorType } from './execution';
import {
  assertApprovalMutationId,
  assertApprovalRequestId,
  assertApprovalTimestamp,
} from './approvalRequest';
import { assertProjectPolicyProjectId } from './projectPolicy';

export const APPROVED_RUN_ACTION_TYPE = 'run.create';
export const APPROVED_RUN_RECEIPT_SCHEMA_VERSION = 1;
export const APPROVED_RUN_RECEIPT_RESULT_CODE = 'approved_run_created';

export interface ApprovedRunCreationPlan {
  schemaVersion: 1;
  actionRef: string;
  projectId: string;
  taskId: string;
  taskRevision: string;
  executorType: ExecutorType;
  priority: number;
  taskName?: string;
  taskSnapshotRef?: string;
  inputRef?: string;
}

export interface ApprovedRunCreationReceipt {
  schemaVersion: 1;
  dispatchId: string;
  approvalRequestId: string;
  projectId: string;
  actionType: typeof APPROVED_RUN_ACTION_TYPE;
  actionDigest: string;
  executionAttempt: number;
  executionVersion: number;
  startedAtMs: number;
  idempotencyKey: string;
  outcome: 'succeeded';
  resultCode: typeof APPROVED_RUN_RECEIPT_RESULT_CODE;
  resourceType: 'run';
  resourceId: string;
  finishedAtMs: number;
  evidenceDigest: string;
  createdAtMs: number;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_EXECUTION_VERSION = 2_147_483_647;

export class InvalidApprovedRunActionError extends TypeError {
  constructor(message: string) {
    super(`Approved Run action is invalid: ${message}`);
    this.name = 'InvalidApprovedRunActionError';
  }
}

export class ApprovedRunActionBindingConflictError extends Error {
  readonly code = 'APPROVED_RUN_ACTION_BINDING_CONFLICT';

  constructor() {
    super('Approved Run action identity does not match its durable receipt');
    this.name = 'ApprovedRunActionBindingConflictError';
  }
}

export class ApprovedRunActionRepositoryError extends Error {
  readonly code = 'APPROVED_RUN_ACTION_REPOSITORY_ERROR';

  constructor() {
    super('Approved Run action repository is unavailable');
    this.name = 'ApprovedRunActionRepositoryError';
  }
}

function exactKeys(value: object, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidApprovedRunActionError('object shape is invalid');
  }
}

function assertBoundedText(name: string, value: string, maximum: number): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidApprovedRunActionError(`${name} is invalid`);
  }
}

function assertIdentifier(name: string, value: string, maximum: number): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new InvalidApprovedRunActionError(`${name} is invalid`);
  }
}

function assertPositiveInteger(
  name: string,
  value: number,
  maximum = MAX_EXECUTION_VERSION,
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new InvalidApprovedRunActionError(`${name} is invalid`);
  }
}

export function normalizeApprovedRunCreationPlan(
  value: ApprovedRunCreationPlan,
): Readonly<ApprovedRunCreationPlan> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovedRunActionError('plan must be an object');
  }
  exactKeys(value, [
    'schemaVersion',
    'actionRef',
    'projectId',
    'taskId',
    'taskRevision',
    'executorType',
    'priority',
    ...(value.taskName === undefined ? [] : ['taskName']),
    ...(value.taskSnapshotRef === undefined ? [] : ['taskSnapshotRef']),
    ...(value.inputRef === undefined ? [] : ['inputRef']),
  ]);
  if (value.schemaVersion !== 1) {
    throw new InvalidApprovedRunActionError('schema version is unsupported');
  }
  assertIdentifier('actionRef', value.actionRef, 255);
  assertProjectPolicyProjectId(value.projectId);
  assertBoundedText('taskId', value.taskId, 255);
  assertBoundedText('taskRevision', value.taskRevision, 128);
  if (!EXECUTOR_TYPES.includes(value.executorType)) {
    throw new InvalidApprovedRunActionError('executorType is unsupported');
  }
  if (
    !Number.isSafeInteger(value.priority) ||
    value.priority < -2_147_483_648 ||
    value.priority > 2_147_483_647
  ) {
    throw new InvalidApprovedRunActionError('priority is invalid');
  }
  if (value.taskName !== undefined) {
    assertBoundedText('taskName', value.taskName, 255);
  }
  if (value.taskSnapshotRef !== undefined) {
    assertBoundedText('taskSnapshotRef', value.taskSnapshotRef, 512);
  }
  if (value.inputRef !== undefined) {
    assertBoundedText('inputRef', value.inputRef, 512);
  }
  return Object.freeze({ ...value });
}

export function digestApprovedRunCreationPlan(
  value: ApprovedRunCreationPlan,
): string {
  const plan = normalizeApprovedRunCreationPlan(value);
  const canonical = JSON.stringify({
    schemaVersion: plan.schemaVersion,
    actionType: APPROVED_RUN_ACTION_TYPE,
    actionRef: plan.actionRef,
    projectId: plan.projectId,
    taskId: plan.taskId,
    taskRevision: plan.taskRevision,
    executorType: plan.executorType,
    priority: plan.priority,
    taskName: plan.taskName ?? null,
    taskSnapshotRef: plan.taskSnapshotRef ?? null,
    inputRef: plan.inputRef ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function canonicalApprovedRunReceipt(
  receipt: Omit<ApprovedRunCreationReceipt, 'evidenceDigest'>,
): string {
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    dispatchId: receipt.dispatchId,
    approvalRequestId: receipt.approvalRequestId,
    projectId: receipt.projectId,
    actionType: receipt.actionType,
    actionDigest: receipt.actionDigest,
    executionAttempt: receipt.executionAttempt,
    executionVersion: receipt.executionVersion,
    startedAtMs: receipt.startedAtMs,
    idempotencyKey: receipt.idempotencyKey,
    outcome: receipt.outcome,
    resultCode: receipt.resultCode,
    resourceType: receipt.resourceType,
    resourceId: receipt.resourceId,
    finishedAtMs: receipt.finishedAtMs,
    createdAtMs: receipt.createdAtMs,
  });
}

export function digestApprovedRunCreationReceipt(
  receipt: Omit<ApprovedRunCreationReceipt, 'evidenceDigest'>,
): string {
  return createHash('sha256')
    .update(canonicalApprovedRunReceipt(receipt), 'utf8')
    .digest('hex');
}

export function normalizeApprovedRunCreationReceipt(
  value: ApprovedRunCreationReceipt,
): Readonly<ApprovedRunCreationReceipt> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovedRunActionError('receipt must be an object');
  }
  exactKeys(value, [
    'schemaVersion',
    'dispatchId',
    'approvalRequestId',
    'projectId',
    'actionType',
    'actionDigest',
    'executionAttempt',
    'executionVersion',
    'startedAtMs',
    'idempotencyKey',
    'outcome',
    'resultCode',
    'resourceType',
    'resourceId',
    'finishedAtMs',
    'evidenceDigest',
    'createdAtMs',
  ]);
  if (value.schemaVersion !== APPROVED_RUN_RECEIPT_SCHEMA_VERSION) {
    throw new InvalidApprovedRunActionError(
      'receipt schema version is unsupported',
    );
  }
  assertApprovalMutationId(value.dispatchId);
  assertApprovalRequestId(value.approvalRequestId);
  assertProjectPolicyProjectId(value.projectId);
  if (value.actionType !== APPROVED_RUN_ACTION_TYPE) {
    throw new InvalidApprovedRunActionError('actionType is invalid');
  }
  if (!DIGEST_PATTERN.test(value.actionDigest)) {
    throw new InvalidApprovedRunActionError('actionDigest is invalid');
  }
  assertPositiveInteger('executionAttempt', value.executionAttempt, 16);
  assertPositiveInteger('executionVersion', value.executionVersion);
  assertApprovalTimestamp('startedAtMs', value.startedAtMs);
  if (value.idempotencyKey !== value.dispatchId) {
    throw new InvalidApprovedRunActionError('idempotency binding is invalid');
  }
  if (
    value.outcome !== 'succeeded' ||
    value.resultCode !== APPROVED_RUN_RECEIPT_RESULT_CODE ||
    value.resourceType !== 'run'
  ) {
    throw new InvalidApprovedRunActionError('result tuple is invalid');
  }
  assertIdentifier('resourceId', value.resourceId, 64);
  assertApprovalTimestamp('finishedAtMs', value.finishedAtMs);
  assertApprovalTimestamp('createdAtMs', value.createdAtMs);
  if (
    value.finishedAtMs < value.startedAtMs ||
    value.createdAtMs !== value.finishedAtMs
  ) {
    throw new InvalidApprovedRunActionError('receipt timestamps are invalid');
  }
  if (!DIGEST_PATTERN.test(value.evidenceDigest)) {
    throw new InvalidApprovedRunActionError('evidenceDigest is invalid');
  }
  const { evidenceDigest, ...unsigned } = value;
  if (digestApprovedRunCreationReceipt(unsigned) !== evidenceDigest) {
    throw new InvalidApprovedRunActionError('evidenceDigest does not match');
  }
  return Object.freeze({ ...value });
}
