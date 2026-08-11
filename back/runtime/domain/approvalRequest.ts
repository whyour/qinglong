import {
  MAX_PROJECT_ROLE_BINDING_VERSION,
  assertProjectPolicyProjectId,
  normalizePolicySubject,
  normalizeProjectPermission,
  type PolicySubject,
  type ProjectPermission,
  type ProjectPolicyFence,
} from './projectPolicy';

export const APPROVAL_RISKS = ['low', 'medium', 'high', 'critical'] as const;
export const APPROVAL_REQUEST_STATES = [
  'pending',
  'approved',
  'rejected',
  'consumed',
] as const;
export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const;
export const APPROVED_ACTION_DISPATCH_STATES = ['pending'] as const;

export type ApprovalRisk = (typeof APPROVAL_RISKS)[number];
export type ApprovalRequestState = (typeof APPROVAL_REQUEST_STATES)[number];
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
export type ApprovalRequestEffectiveStatus = ApprovalRequestState | 'expired';
export type ApprovedActionDispatchState =
  (typeof APPROVED_ACTION_DISPATCH_STATES)[number];

export interface ApprovalActionBinding {
  permission: ProjectPermission;
  actionType: string;
  actionRef: string;
  actionDigest: string;
  previewDigest: string;
}

export interface ApprovalRequestRecord {
  id: string;
  projectId: string;
  version: number;
  state: ApprovalRequestState;
  action: ApprovalActionBinding;
  risk: ApprovalRisk;
  requestedBy: PolicySubject;
  requestedAtMs: number;
  expiresAtMs: number;
  decisionId: string | null;
  decision: ApprovalDecision | null;
  decisionReasonCode: string | null;
  decidedBy: PolicySubject | null;
  decidedAtMs: number | null;
  consumptionId: string | null;
  dispatchId: string | null;
  consumedBy: PolicySubject | null;
  consumedAtMs: number | null;
}

export interface ApprovedActionDispatchRecord {
  id: string;
  approvalRequestId: string;
  approvalRequestVersion: number;
  projectId: string;
  state: ApprovedActionDispatchState;
  action: ApprovalActionBinding;
  requestedBy: PolicySubject;
  consumedBy: PolicySubject;
  createdAtMs: number;
}

export const MAX_APPROVAL_REQUEST_ID_LENGTH = 64;
export const MAX_APPROVAL_MUTATION_ID_LENGTH = 64;
export const MAX_APPROVAL_ACTION_TYPE_LENGTH = 64;
export const MAX_APPROVAL_ACTION_REF_LENGTH = 255;
export const MAX_APPROVAL_REASON_CODE_LENGTH = 64;
export const MAX_APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MAX_APPROVAL_REQUEST_VERSION = 2_147_483_647;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export class InvalidApprovalValueError extends TypeError {
  constructor(message: string) {
    super(`Approval value is invalid: ${message}`);
    this.name = 'InvalidApprovalValueError';
  }
}

export class ApprovalRequestNotFoundError extends Error {
  readonly code = 'APPROVAL_REQUEST_NOT_FOUND';

  constructor() {
    super('Approval request does not exist');
    this.name = 'ApprovalRequestNotFoundError';
  }
}

export class ApprovalPolicyDeniedError extends Error {
  readonly code = 'APPROVAL_POLICY_DENIED';

  constructor() {
    super('Approval operation is denied by project policy');
    this.name = 'ApprovalPolicyDeniedError';
  }
}

export class ApprovalPolicyFenceConflictError extends Error {
  readonly code = 'APPROVAL_POLICY_FENCE_CONFLICT';

  constructor() {
    super('Approval policy snapshot changed before the mutation committed');
    this.name = 'ApprovalPolicyFenceConflictError';
  }
}

export class ApprovalRequestVersionConflictError extends Error {
  readonly code = 'APPROVAL_REQUEST_VERSION_CONFLICT';

  constructor() {
    super('Approval request version changed');
    this.name = 'ApprovalRequestVersionConflictError';
  }
}

export class ApprovalMutationConflictError extends Error {
  readonly code = 'APPROVAL_MUTATION_CONFLICT';

  constructor() {
    super('Approval mutation does not match its previous request');
    this.name = 'ApprovalMutationConflictError';
  }
}

export class ApprovalRequestStateConflictError extends Error {
  readonly code = 'APPROVAL_REQUEST_STATE_CONFLICT';

  constructor() {
    super('Approval request is not in the required state');
    this.name = 'ApprovalRequestStateConflictError';
  }
}

export class ApprovalRequestExpiredError extends Error {
  readonly code = 'APPROVAL_REQUEST_EXPIRED';

  constructor() {
    super('Approval request expired');
    this.name = 'ApprovalRequestExpiredError';
  }
}

export class ApprovalHumanDecisionRequiredError extends Error {
  readonly code = 'APPROVAL_HUMAN_DECISION_REQUIRED';

  constructor() {
    super('Approval decisions require an authenticated user subject');
    this.name = 'ApprovalHumanDecisionRequiredError';
  }
}

export class ApprovalSelfDecisionError extends Error {
  readonly code = 'APPROVAL_SELF_DECISION_REJECTED';

  constructor() {
    super('An approval requester cannot decide its own request');
    this.name = 'ApprovalSelfDecisionError';
  }
}

export class ApprovalUnavailableError extends Error {
  readonly code = 'APPROVAL_UNAVAILABLE';

  constructor() {
    super('Approval storage is unavailable');
    this.name = 'ApprovalUnavailableError';
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
    throw new InvalidApprovalValueError(`${name} shape is invalid`);
  }
}

function assertIdentifier(name: string, value: string, maximum: number): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new InvalidApprovalValueError(`${name} is invalid`);
  }
}

function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidApprovalValueError(`${name} is invalid`);
  }
}

function sameSubject(
  left: Readonly<PolicySubject>,
  right: Readonly<PolicySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

export function assertApprovalRequestId(value: string): void {
  assertIdentifier('request id', value, MAX_APPROVAL_REQUEST_ID_LENGTH);
}

export function assertApprovalMutationId(value: string): void {
  assertIdentifier('mutation id', value, MAX_APPROVAL_MUTATION_ID_LENGTH);
}

export function assertApprovalReasonCode(value: string): void {
  assertIdentifier(
    'decision reason code',
    value,
    MAX_APPROVAL_REASON_CODE_LENGTH,
  );
}

export function assertApprovalTimestamp(name: string, value: number): void {
  assertTimestamp(name, value);
}

export function assertApprovalRequestVersion(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_APPROVAL_REQUEST_VERSION
  ) {
    throw new InvalidApprovalValueError('request version is invalid');
  }
}

export function normalizeApprovalActionBinding(
  value: ApprovalActionBinding,
): Readonly<ApprovalActionBinding> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovalValueError('action must be an object');
  }
  assertExactKeys('action', value, [
    'permission',
    'actionType',
    'actionRef',
    'actionDigest',
    'previewDigest',
  ]);
  const permission = normalizeProjectPermission(value.permission);
  assertIdentifier(
    'action type',
    value.actionType,
    MAX_APPROVAL_ACTION_TYPE_LENGTH,
  );
  assertIdentifier(
    'action ref',
    value.actionRef,
    MAX_APPROVAL_ACTION_REF_LENGTH,
  );
  if (!DIGEST_PATTERN.test(value.actionDigest)) {
    throw new InvalidApprovalValueError('action digest is invalid');
  }
  if (!DIGEST_PATTERN.test(value.previewDigest)) {
    throw new InvalidApprovalValueError('preview digest is invalid');
  }
  return Object.freeze({
    permission,
    actionType: value.actionType,
    actionRef: value.actionRef,
    actionDigest: value.actionDigest,
    previewDigest: value.previewDigest,
  });
}

export function normalizeApprovalPolicyFence(
  value: ProjectPolicyFence,
): Readonly<ProjectPolicyFence> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovalValueError('policy fence must be an object');
  }
  assertExactKeys('policy fence', value, ['projectVersion', 'bindingVersion']);
  if (
    !Number.isSafeInteger(value.projectVersion) ||
    value.projectVersion < 1 ||
    value.projectVersion > MAX_PROJECT_ROLE_BINDING_VERSION
  ) {
    throw new InvalidApprovalValueError('project policy version is invalid');
  }
  if (
    value.bindingVersion !== null &&
    (!Number.isSafeInteger(value.bindingVersion) ||
      value.bindingVersion < 1 ||
      value.bindingVersion > MAX_PROJECT_ROLE_BINDING_VERSION)
  ) {
    throw new InvalidApprovalValueError('binding policy version is invalid');
  }
  return Object.freeze({ ...value });
}

export function normalizeApprovalRequestRecord(
  value: ApprovalRequestRecord,
): Readonly<ApprovalRequestRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovalValueError('request must be an object');
  }
  assertExactKeys('request', value, [
    'id',
    'projectId',
    'version',
    'state',
    'action',
    'risk',
    'requestedBy',
    'requestedAtMs',
    'expiresAtMs',
    'decisionId',
    'decision',
    'decisionReasonCode',
    'decidedBy',
    'decidedAtMs',
    'consumptionId',
    'dispatchId',
    'consumedBy',
    'consumedAtMs',
  ]);
  assertApprovalRequestId(value.id);
  assertProjectPolicyProjectId(value.projectId);
  assertApprovalRequestVersion(value.version);
  if (!APPROVAL_REQUEST_STATES.includes(value.state)) {
    throw new InvalidApprovalValueError('request state is invalid');
  }
  const action = normalizeApprovalActionBinding(value.action);
  if (!APPROVAL_RISKS.includes(value.risk)) {
    throw new InvalidApprovalValueError('risk is invalid');
  }
  const requestedBy = normalizePolicySubject(value.requestedBy);
  assertTimestamp('requestedAtMs', value.requestedAtMs);
  assertTimestamp('expiresAtMs', value.expiresAtMs);
  if (
    value.expiresAtMs <= value.requestedAtMs ||
    value.expiresAtMs - value.requestedAtMs > MAX_APPROVAL_LIFETIME_MS
  ) {
    throw new InvalidApprovalValueError('request lifetime is invalid');
  }

  const decisionValues = [
    value.decisionId,
    value.decision,
    value.decisionReasonCode,
    value.decidedBy,
    value.decidedAtMs,
  ];
  const hasDecision = decisionValues.every((candidate) => candidate !== null);
  if (!hasDecision && decisionValues.some((candidate) => candidate !== null)) {
    throw new InvalidApprovalValueError('decision tuple is incomplete');
  }
  let decidedBy: Readonly<PolicySubject> | null = null;
  if (hasDecision) {
    assertApprovalMutationId(value.decisionId!);
    if (!APPROVAL_DECISIONS.includes(value.decision!)) {
      throw new InvalidApprovalValueError('decision is invalid');
    }
    assertApprovalReasonCode(value.decisionReasonCode!);
    decidedBy = normalizePolicySubject(value.decidedBy!);
    assertTimestamp('decidedAtMs', value.decidedAtMs!);
    if (
      value.decidedAtMs! < value.requestedAtMs ||
      value.decidedAtMs! >= value.expiresAtMs
    ) {
      throw new InvalidApprovalValueError('decision timestamp is invalid');
    }
  }

  const consumptionValues = [
    value.consumptionId,
    value.dispatchId,
    value.consumedBy,
    value.consumedAtMs,
  ];
  const hasConsumption = consumptionValues.every(
    (candidate) => candidate !== null,
  );
  if (
    !hasConsumption &&
    consumptionValues.some((candidate) => candidate !== null)
  ) {
    throw new InvalidApprovalValueError('consumption tuple is incomplete');
  }
  let consumedBy: Readonly<PolicySubject> | null = null;
  if (hasConsumption) {
    assertApprovalMutationId(value.consumptionId!);
    assertApprovalMutationId(value.dispatchId!);
    consumedBy = normalizePolicySubject(value.consumedBy!);
    assertTimestamp('consumedAtMs', value.consumedAtMs!);
    if (
      !hasDecision ||
      value.decision !== 'approved' ||
      value.consumedAtMs! < value.decidedAtMs! ||
      value.consumedAtMs! >= value.expiresAtMs
    ) {
      throw new InvalidApprovalValueError('consumption tuple is invalid');
    }
  }

  if (
    (value.state === 'pending' && (hasDecision || hasConsumption)) ||
    (value.state === 'approved' &&
      (!hasDecision || value.decision !== 'approved' || hasConsumption)) ||
    (value.state === 'rejected' &&
      (!hasDecision || value.decision !== 'rejected' || hasConsumption)) ||
    (value.state === 'consumed' && !hasConsumption)
  ) {
    throw new InvalidApprovalValueError('state tuple is inconsistent');
  }
  if (value.state === 'pending' && value.version !== 1) {
    throw new InvalidApprovalValueError('pending request version is invalid');
  }
  if (
    (value.state === 'approved' || value.state === 'rejected') &&
    value.version !== 2
  ) {
    throw new InvalidApprovalValueError('decided request version is invalid');
  }
  if (value.state === 'consumed' && value.version !== 3) {
    throw new InvalidApprovalValueError('consumed request version is invalid');
  }

  return Object.freeze({
    ...value,
    action,
    requestedBy,
    decidedBy,
    consumedBy,
  });
}

export function normalizeApprovedActionDispatchRecord(
  value: ApprovedActionDispatchRecord,
): Readonly<ApprovedActionDispatchRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovalValueError('dispatch must be an object');
  }
  assertExactKeys('dispatch', value, [
    'id',
    'approvalRequestId',
    'approvalRequestVersion',
    'projectId',
    'state',
    'action',
    'requestedBy',
    'consumedBy',
    'createdAtMs',
  ]);
  assertApprovalMutationId(value.id);
  assertApprovalRequestId(value.approvalRequestId);
  assertApprovalRequestVersion(value.approvalRequestVersion);
  if (value.approvalRequestVersion !== 3) {
    throw new InvalidApprovalValueError('dispatch approval version is invalid');
  }
  assertProjectPolicyProjectId(value.projectId);
  if (!APPROVED_ACTION_DISPATCH_STATES.includes(value.state)) {
    throw new InvalidApprovalValueError('dispatch state is invalid');
  }
  const action = normalizeApprovalActionBinding(value.action);
  const requestedBy = normalizePolicySubject(value.requestedBy);
  const consumedBy = normalizePolicySubject(value.consumedBy);
  assertTimestamp('dispatch createdAtMs', value.createdAtMs);
  return Object.freeze({
    ...value,
    action,
    requestedBy,
    consumedBy,
  });
}

export function approvalRequestEffectiveStatus(
  request: Readonly<ApprovalRequestRecord>,
  nowMs: number,
): ApprovalRequestEffectiveStatus {
  const normalized = normalizeApprovalRequestRecord(request);
  assertTimestamp('nowMs', nowMs);
  if (
    nowMs >= normalized.expiresAtMs &&
    (normalized.state === 'pending' || normalized.state === 'approved')
  ) {
    return 'expired';
  }
  return normalized.state;
}

export function sameApprovalAction(
  left: Readonly<ApprovalActionBinding>,
  right: Readonly<ApprovalActionBinding>,
): boolean {
  const normalizedLeft = normalizeApprovalActionBinding(left);
  const normalizedRight = normalizeApprovalActionBinding(right);
  return (
    normalizedLeft.permission === normalizedRight.permission &&
    normalizedLeft.actionType === normalizedRight.actionType &&
    normalizedLeft.actionRef === normalizedRight.actionRef &&
    normalizedLeft.actionDigest === normalizedRight.actionDigest &&
    normalizedLeft.previewDigest === normalizedRight.previewDigest
  );
}

export function sameApprovalSubject(
  left: Readonly<PolicySubject>,
  right: Readonly<PolicySubject>,
): boolean {
  return sameSubject(
    normalizePolicySubject(left),
    normalizePolicySubject(right),
  );
}
