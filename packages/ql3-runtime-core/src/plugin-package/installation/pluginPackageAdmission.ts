import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  approvedActionDispatchDigest,
  normalizeApprovedActionDispatchRecord,
  type ApprovedActionDispatchRecord,
} from '../../approved-action/approvedAction';
import {
  normalizeApprovedActionExecutionRecord,
  type ApprovedActionExecutionRecord,
} from '../../approved-action/approvedActionExecution';
import {
  createPluginPackageInstall,
  normalizePluginPackageInstallCreate,
  normalizePluginPackageInstallRecord,
  normalizePluginPackageLock,
  pluginPackageInstallCreate,
  type PluginPackageInstallCreate,
  type PluginPackageInstallRecord,
  type PluginPackageInstallRepository,
  type PluginPackageLock,
} from './pluginPackageInstall';
import {
  normalizePluginPackageInstallProposal,
  resolvePluginPackageInstallProposal,
  type PluginPackageInstallProposal,
} from '../pluginPackageProposal';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '../../security/audit/securityAudit';

export const PLUGIN_PACKAGE_INSTALL_ACTION_TYPE =
  'plugin_package.install' as const;
export const PLUGIN_PACKAGE_ADMISSION_RECEIPT_SCHEMA =
  'qinglong/plugin-package-admission-receipt@v1' as const;
export const PLUGIN_PACKAGE_ADMISSION_AUDIT_OPERATION =
  'plugin_package.admit' as const;
export const PLUGIN_PACKAGE_ADMISSION_AUDIT_REASON =
  'approved_action' as const;

export interface PluginPackageAdmissionRequest {
  readonly lock: PluginPackageLock;
  readonly proposalDigest: string;
  readonly execution: ApprovedActionExecutionRecord;
  readonly installationId: string;
  readonly mutationId: string;
  readonly admittedAtMs: number;
  readonly audit: SecurityAuditRecord;
}

export interface PluginPackageAdmissionReceipt {
  readonly schema: typeof PLUGIN_PACKAGE_ADMISSION_RECEIPT_SCHEMA;
  readonly dispatchId: string;
  readonly dispatchDigest: string;
  readonly approvalRequestId: string;
  readonly actionRef: string;
  readonly projectId: string;
  readonly packageName: string;
  readonly installationId: string;
  readonly lockDigest: string;
  readonly recordDigest: string;
  readonly mutationId: string;
  readonly mutationDigest: string;
  readonly auditEventId: string;
  readonly admittedAtMs: number;
  readonly receiptDigest: string;
}

export interface BoundPluginPackageAdmission {
  readonly create: Readonly<PluginPackageInstallCreate>;
  readonly receipt: Readonly<PluginPackageAdmissionReceipt>;
}

export interface PluginPackageAdmissionResult {
  readonly status: 'admitted' | 'existing';
  readonly record: Readonly<PluginPackageInstallRecord>;
  readonly receipt: Readonly<PluginPackageAdmissionReceipt>;
}

export interface PluginPackageAdmissionRepository
  extends PluginPackageInstallRepository {
  findAdmissionReceipt(
    dispatchId: string,
  ): Promise<Readonly<PluginPackageAdmissionReceipt> | null>;
  admit(
    request: PluginPackageAdmissionRequest,
  ): Promise<Readonly<PluginPackageAdmissionResult>>;
}

export class InvalidPluginPackageAdmissionError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_ADMISSION_INVALID';

  constructor(message: string) {
    super(`Plugin Package admission is invalid: ${message}`);
    this.name = 'InvalidPluginPackageAdmissionError';
  }
}

export class PluginPackageAdmissionBindingConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_ADMISSION_BINDING_CONFLICT';

  constructor() {
    super('Plugin Package admission does not match its approved dispatch');
    this.name = 'PluginPackageAdmissionBindingConflictError';
  }
}

export class PluginPackageAdmissionReceiptConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_ADMISSION_RECEIPT_CONFLICT';

  constructor() {
    super('Plugin Package admission conflicts with its durable receipt');
    this.name = 'PluginPackageAdmissionReceiptConflictError';
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidPluginPackageAdmissionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidPluginPackageAdmissionError(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidPluginPackageAdmissionError(`${label} is invalid`);
  }
  return value;
}

function actionRef(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    throw new InvalidPluginPackageAdmissionError(
      'approved action reference is invalid',
    );
  }
  return value;
}

function packageName(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME_PATTERN.test(value)) {
    throw new InvalidPluginPackageAdmissionError('package name is invalid');
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidPluginPackageAdmissionError(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidPluginPackageAdmissionError(`${label} is invalid`);
  }
  return value as number;
}

function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function contractDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(value))
    .digest('hex');
}

function receiptWithoutDigest(
  value: Omit<PluginPackageAdmissionReceipt, 'receiptDigest'>,
): Omit<PluginPackageAdmissionReceipt, 'receiptDigest'> {
  return Object.freeze(value);
}

function withReceiptDigest(
  value: Omit<PluginPackageAdmissionReceipt, 'receiptDigest'>,
): Readonly<PluginPackageAdmissionReceipt> {
  const normalized = receiptWithoutDigest(value);
  return Object.freeze({
    ...normalized,
    receiptDigest: contractDigest(
      'qinglong/plugin-package-admission-receipt-digest@v1',
      normalized,
    ),
  });
}

function assertAuditBinding(
  dispatch: Readonly<ApprovedActionDispatchRecord>,
  audit: Readonly<SecurityAuditRecord>,
  admittedAtMs: number,
): void {
  if (
    audit.requestId !== dispatch.id ||
    audit.operationId !== PLUGIN_PACKAGE_ADMISSION_AUDIT_OPERATION ||
    audit.projectId !== dispatch.projectId ||
    audit.subject?.type !== dispatch.consumedBy.type ||
    audit.subject.id !== dispatch.consumedBy.id ||
    audit.authenticationId === null ||
    audit.outcome !== 'allowed' ||
    !same(audit.reasons, [PLUGIN_PACKAGE_ADMISSION_AUDIT_REASON]) ||
    audit.fence?.projectVersion !== dispatch.approvalFence.projectVersion ||
    audit.fence.bindingVersion !== dispatch.approvalFence.bindingVersion ||
    audit.occurredAtMs !== admittedAtMs
  ) {
    throw new PluginPackageAdmissionBindingConflictError();
  }
}

function assertDispatchBinding(
  dispatch: Readonly<ApprovedActionDispatchRecord>,
  lock: Readonly<PluginPackageLock>,
  admittedAtMs: number,
): void {
  const approval = lock.approval;
  if (
    dispatch.id !== approval.dispatchId ||
    dispatch.approvalRequestId !== approval.requestId ||
    approval.requestVersion !== 3 ||
    dispatch.projectId !== lock.projectId ||
    dispatch.action.permission !== 'package.manage' ||
    dispatch.action.actionType !== PLUGIN_PACKAGE_INSTALL_ACTION_TYPE ||
    dispatch.action.actionDigest !== lock.actionDigest ||
    dispatch.action.previewDigest !== lock.planDigest ||
    dispatch.action.actionDigest !== approval.actionDigest ||
    dispatch.action.previewDigest !== approval.previewDigest ||
    dispatch.approvedBy.type !== approval.approvedBy.type ||
    dispatch.approvedBy.id !== approval.approvedBy.id ||
    dispatch.approvedAtMs !== approval.approvedAtMs ||
    dispatch.expiresAtMs !== approval.expiresAtMs ||
    dispatch.approvalFence.projectVersion !==
      approval.fence.projectVersion ||
    dispatch.approvalFence.bindingVersion !==
      approval.fence.bindingVersion ||
    admittedAtMs < dispatch.createdAtMs ||
    admittedAtMs < lock.createdAtMs ||
    admittedAtMs >= dispatch.expiresAtMs
  ) {
    throw new PluginPackageAdmissionBindingConflictError();
  }
}

function assertProposalBinding(
  dispatch: Readonly<ApprovedActionDispatchRecord>,
  proposalValue: PluginPackageInstallProposal,
  request: Readonly<PluginPackageAdmissionRequest>,
): void {
  const proposal = normalizePluginPackageInstallProposal(proposalValue);
  let resolved: Readonly<PluginPackageLock>;
  try {
    resolved = resolvePluginPackageInstallProposal(
      proposal,
      dispatch,
      request.lock.createdAtMs,
    );
  } catch {
    throw new PluginPackageAdmissionBindingConflictError();
  }
  if (
    proposal.proposalDigest !== request.proposalDigest ||
    !same(resolved, request.lock)
  ) {
    throw new PluginPackageAdmissionBindingConflictError();
  }
}

function assertExecutionBinding(
  dispatch: Readonly<ApprovedActionDispatchRecord>,
  currentExecutionValue: ApprovedActionExecutionRecord,
  request: Readonly<PluginPackageAdmissionRequest>,
  observedAtMs: number,
): void {
  const currentExecution = normalizeApprovedActionExecutionRecord(
    currentExecutionValue,
  );
  const expectedExecution = request.execution;
  if (
    !same(currentExecution, expectedExecution) ||
    currentExecution.dispatchId !== dispatch.id ||
    currentExecution.dispatchDigest !== approvedActionDispatchDigest(dispatch) ||
    currentExecution.projectId !== dispatch.projectId ||
    currentExecution.status !== 'executing' ||
    currentExecution.startedAtMs === null ||
    currentExecution.leaseOwner === null ||
    currentExecution.leaseToken === null ||
    currentExecution.leaseExpiresAtMs === null ||
    request.admittedAtMs < currentExecution.startedAtMs ||
    request.admittedAtMs >= currentExecution.leaseExpiresAtMs ||
    observedAtMs < currentExecution.startedAtMs ||
    observedAtMs >= currentExecution.leaseExpiresAtMs
  ) {
    throw new PluginPackageAdmissionBindingConflictError();
  }
}

export function normalizePluginPackageAdmissionRequest(
  value: PluginPackageAdmissionRequest,
): Readonly<PluginPackageAdmissionRequest> {
  const request = dataRecord(value, 'request');
  exactKeys(
    request,
    [
      'lock',
      'proposalDigest',
      'execution',
      'installationId',
      'mutationId',
      'admittedAtMs',
      'audit',
    ],
    'request',
  );
  const execution = normalizeApprovedActionExecutionRecord(value.execution);
  if (execution.status !== 'executing') {
    throw new InvalidPluginPackageAdmissionError(
      'execution has not crossed the start barrier',
    );
  }
  return Object.freeze({
    lock: normalizePluginPackageLock(value.lock),
    proposalDigest: digest(value.proposalDigest, 'proposal digest'),
    execution,
    installationId: identifier(value.installationId, 'installation id'),
    mutationId: identifier(value.mutationId, 'mutation id'),
    admittedAtMs: timestamp(value.admittedAtMs, 'admission time'),
    audit: normalizeSecurityAuditRecord(value.audit),
  });
}

export function bindPluginPackageAdmission(
  dispatchValue: ApprovedActionDispatchRecord,
  proposalValue: PluginPackageInstallProposal,
  currentExecutionValue: ApprovedActionExecutionRecord,
  requestValue: PluginPackageAdmissionRequest,
  previousHeadValue: PluginPackageInstallRecord | null,
  observedAtMsValue: number,
): Readonly<BoundPluginPackageAdmission> {
  const dispatch = normalizeApprovedActionDispatchRecord(dispatchValue);
  const request = normalizePluginPackageAdmissionRequest(requestValue);
  const observedAtMs = timestamp(observedAtMsValue, 'observed admission time');
  const previousHead =
    previousHeadValue === null
      ? null
      : normalizePluginPackageInstallRecord(previousHeadValue);
  assertDispatchBinding(dispatch, request.lock, request.admittedAtMs);
  assertProposalBinding(dispatch, proposalValue, request);
  assertExecutionBinding(
    dispatch,
    currentExecutionValue,
    request,
    observedAtMs,
  );
  assertAuditBinding(dispatch, request.audit, request.admittedAtMs);
  const record = createPluginPackageInstall(request.lock, {
    installationId: request.installationId,
    mutationId: request.mutationId,
    occurredAtMs: request.admittedAtMs,
  });
  const create = pluginPackageInstallCreate(
    request.lock,
    record,
    previousHead,
  );
  return Object.freeze({
    create,
    receipt: withReceiptDigest({
      schema: PLUGIN_PACKAGE_ADMISSION_RECEIPT_SCHEMA,
      dispatchId: dispatch.id,
      dispatchDigest: approvedActionDispatchDigest(dispatch),
      approvalRequestId: dispatch.approvalRequestId,
      actionRef: dispatch.action.actionRef,
      projectId: record.projectId,
      packageName: record.packageName,
      installationId: record.installationId,
      lockDigest: record.lockDigest,
      recordDigest: record.recordDigest,
      mutationId: create.mutationId,
      mutationDigest: create.mutationDigest,
      auditEventId: request.audit.eventId,
      admittedAtMs: request.admittedAtMs,
    }),
  });
}

export function normalizePluginPackageAdmissionReceipt(
  value: PluginPackageAdmissionReceipt,
): Readonly<PluginPackageAdmissionReceipt> {
  const receipt = dataRecord(value, 'receipt');
  exactKeys(
    receipt,
    [
      'schema',
      'dispatchId',
      'dispatchDigest',
      'approvalRequestId',
      'actionRef',
      'projectId',
      'packageName',
      'installationId',
      'lockDigest',
      'recordDigest',
      'mutationId',
      'mutationDigest',
      'auditEventId',
      'admittedAtMs',
      'receiptDigest',
    ],
    'receipt',
  );
  if (value.schema !== PLUGIN_PACKAGE_ADMISSION_RECEIPT_SCHEMA) {
    throw new InvalidPluginPackageAdmissionError(
      'receipt schema is invalid',
    );
  }
  const normalized = withReceiptDigest({
    schema: PLUGIN_PACKAGE_ADMISSION_RECEIPT_SCHEMA,
    dispatchId: identifier(value.dispatchId, 'dispatch id'),
    dispatchDigest: digest(value.dispatchDigest, 'dispatch digest'),
    approvalRequestId: identifier(
      value.approvalRequestId,
      'approval request id',
    ),
    actionRef: actionRef(value.actionRef),
    projectId: identifier(value.projectId, 'project id'),
    packageName: packageName(value.packageName),
    installationId: identifier(value.installationId, 'installation id'),
    lockDigest: digest(value.lockDigest, 'lock digest'),
    recordDigest: digest(value.recordDigest, 'record digest'),
    mutationId: identifier(value.mutationId, 'mutation id'),
    mutationDigest: digest(value.mutationDigest, 'mutation digest'),
    auditEventId: identifier(value.auditEventId, 'audit event id'),
    admittedAtMs: timestamp(value.admittedAtMs, 'admission time'),
  });
  if (normalized.receiptDigest !== value.receiptDigest) {
    throw new InvalidPluginPackageAdmissionError(
      'receipt digest does not match',
    );
  }
  return normalized;
}

export function pluginPackageAdmissionReceiptDigest(
  value: PluginPackageAdmissionReceipt,
): string {
  return normalizePluginPackageAdmissionReceipt(value).receiptDigest;
}

export function assertPluginPackageAdmissionReplay(
  dispatchValue: ApprovedActionDispatchRecord,
  proposalValue: PluginPackageInstallProposal,
  requestValue: PluginPackageAdmissionRequest,
  receiptValue: PluginPackageAdmissionReceipt,
  durableRecordValue: PluginPackageInstallRecord,
): void {
  const dispatch = normalizeApprovedActionDispatchRecord(dispatchValue);
  const request = normalizePluginPackageAdmissionRequest(requestValue);
  const receipt = normalizePluginPackageAdmissionReceipt(receiptValue);
  const durableRecord = normalizePluginPackageInstallRecord(
    durableRecordValue,
  );
  assertDispatchBinding(dispatch, request.lock, receipt.admittedAtMs);
  assertProposalBinding(dispatch, proposalValue, request);
  assertAuditBinding(dispatch, request.audit, receipt.admittedAtMs);
  if (
    receipt.dispatchId !== dispatch.id ||
    receipt.dispatchDigest !== approvedActionDispatchDigest(dispatch) ||
    receipt.approvalRequestId !== dispatch.approvalRequestId ||
    receipt.actionRef !== dispatch.action.actionRef ||
    receipt.projectId !== request.lock.projectId ||
    receipt.packageName !== request.lock.packageName ||
    receipt.installationId !== request.installationId ||
    receipt.lockDigest !== request.lock.lockDigest ||
    receipt.mutationId !== request.mutationId ||
    receipt.auditEventId !== request.audit.eventId ||
    receipt.admittedAtMs !== request.admittedAtMs ||
    durableRecord.installationId !== receipt.installationId ||
    durableRecord.projectId !== receipt.projectId ||
    durableRecord.packageName !== receipt.packageName ||
    durableRecord.lockDigest !== receipt.lockDigest ||
    durableRecord.createdAtMs !== receipt.admittedAtMs
  ) {
    throw new PluginPackageAdmissionReceiptConflictError();
  }
  const initial = createPluginPackageInstall(request.lock, {
    installationId: request.installationId,
    mutationId: request.mutationId,
    occurredAtMs: request.admittedAtMs,
  });
  if (initial.recordDigest !== receipt.recordDigest) {
    throw new PluginPackageAdmissionReceiptConflictError();
  }
}
