import { createHash } from 'node:crypto';

import {
  normalizeProjectPermission,
  normalizeProjectPolicySubject,
  type ProjectPermission,
} from '../security/project-policy/projectPolicy';
import {
  SECURITY_AUTHENTICATION_ASSURANCES,
  type SecurityAuthenticationAssurance,
  type SecurityPolicyFence,
  type SecurityPrincipal,
  type SecuritySubject,
} from '../security/security';
import type { SecurityAuditRecord } from '../security/audit/securityAudit';

export const APPROVAL_REQUEST_SCHEMA =
  'qinglong/approval-request@v1' as const;
export const APPROVED_ACTION_DISPATCH_SCHEMA =
  'qinglong/approved-action-dispatch@v1' as const;

export const APPROVAL_RISKS = ['low', 'medium', 'high', 'critical'] as const;
export const APPROVAL_DECISION_MODES = [
  'human_confirmation',
  'separation_of_duty',
] as const;
export const APPROVAL_REQUEST_STATES = [
  'pending',
  'approved',
  'rejected',
  'consumed',
] as const;
export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const;

export type ApprovalRisk = (typeof APPROVAL_RISKS)[number];
export type ApprovalDecisionMode = (typeof APPROVAL_DECISION_MODES)[number];
export type ApprovalRequestState = (typeof APPROVAL_REQUEST_STATES)[number];
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
export type ApprovalRequestEffectiveStatus = ApprovalRequestState | 'expired';

export interface ApprovedActionBinding {
  readonly permission: ProjectPermission;
  readonly actionType: string;
  readonly actionRef: string;
  readonly actionDigest: string;
  readonly previewDigest: string;
}

export interface ApprovalRequestRecord {
  readonly schema: typeof APPROVAL_REQUEST_SCHEMA;
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly state: ApprovalRequestState;
  readonly action: Readonly<ApprovedActionBinding>;
  readonly risk: ApprovalRisk;
  readonly decisionMode: ApprovalDecisionMode;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  readonly requestFence: Readonly<SecurityPolicyFence>;
  readonly decisionId: string | null;
  readonly decision: ApprovalDecision | null;
  readonly decisionReasonCode: string | null;
  readonly decidedBy: Readonly<SecuritySubject> | null;
  readonly decisionAuthenticationId: string | null;
  readonly decisionAssurance: SecurityAuthenticationAssurance | null;
  readonly decidedAtMs: number | null;
  readonly decisionFence: Readonly<SecurityPolicyFence> | null;
  readonly consumptionId: string | null;
  readonly dispatchId: string | null;
  readonly consumedBy: Readonly<SecuritySubject> | null;
  readonly consumedAtMs: number | null;
  readonly consumptionFence: Readonly<SecurityPolicyFence> | null;
}

export interface ApprovedActionDispatchRecord {
  readonly schema: typeof APPROVED_ACTION_DISPATCH_SCHEMA;
  readonly id: string;
  readonly approvalRequestId: string;
  readonly approvalRequestVersion: 3;
  readonly projectId: string;
  readonly action: Readonly<ApprovedActionBinding>;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly consumedBy: Readonly<SecuritySubject>;
  readonly approvedBy: Readonly<SecuritySubject>;
  readonly approvalAuthenticationId: string;
  readonly approvalAssurance: SecurityAuthenticationAssurance;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  readonly approvalFence: Readonly<SecurityPolicyFence>;
  readonly createdAtMs: number;
}

export interface CreateApprovalRequestInput {
  readonly id: string;
  readonly projectId: string;
  readonly action: ApprovedActionBinding;
  readonly risk: ApprovalRisk;
  readonly decisionMode: ApprovalDecisionMode;
  readonly requestedBy: SecuritySubject;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  readonly requestFence: SecurityPolicyFence;
}

export interface DecideApprovalRequestCommand {
  readonly expectedVersion: number;
  readonly decisionId: string;
  readonly decision: ApprovalDecision;
  readonly reasonCode: string;
  readonly principal: SecurityPrincipal;
  readonly decidedAtMs: number;
  readonly authorizationFence: SecurityPolicyFence;
}

export interface ConsumeApprovalRequestCommand {
  readonly expectedVersion: number;
  readonly consumptionId: string;
  readonly dispatchId: string;
  readonly action: ApprovedActionBinding;
  readonly requestedBy: SecuritySubject;
  readonly consumedBy: SecuritySubject;
  readonly consumedAtMs: number;
  readonly authorizationFence: SecurityPolicyFence;
}

export interface ConsumeApprovalRequestResult {
  readonly request: Readonly<ApprovalRequestRecord>;
  readonly dispatch: Readonly<ApprovedActionDispatchRecord>;
}

export interface CreateApprovalRequestCommand {
  readonly request: ApprovalRequestRecord;
  readonly audit: SecurityAuditRecord;
}

export interface CreateApprovalRequestResult {
  readonly status: 'created' | 'existing';
  readonly request: Readonly<ApprovalRequestRecord>;
}

export interface DecideDurableApprovalRequestCommand
  extends DecideApprovalRequestCommand {
  readonly requestId: string;
  readonly audit: SecurityAuditRecord;
}

export interface DecideApprovalRequestResult {
  readonly status: 'decided' | 'existing';
  readonly request: Readonly<ApprovalRequestRecord>;
}

export interface ConsumeDurableApprovalRequestCommand
  extends ConsumeApprovalRequestCommand {
  readonly requestId: string;
  readonly audit: SecurityAuditRecord;
}

export interface ConsumeDurableApprovalRequestResult
  extends ConsumeApprovalRequestResult {
  readonly status: 'consumed' | 'existing';
}

export interface ApprovalRequestRepository {
  findById(id: string): Promise<Readonly<ApprovalRequestRecord> | null>;
  findDispatchById(
    id: string,
  ): Promise<Readonly<ApprovedActionDispatchRecord> | null>;
  create(
    command: CreateApprovalRequestCommand,
  ): Promise<CreateApprovalRequestResult>;
  decide(
    command: DecideDurableApprovalRequestCommand,
  ): Promise<DecideApprovalRequestResult>;
  consume(
    command: ConsumeDurableApprovalRequestCommand,
  ): Promise<ConsumeDurableApprovalRequestResult>;
}

export const MAX_APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MAX_APPROVAL_REQUEST_VERSION = 2_147_483_647;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const AUTHENTICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STRONG_HUMAN_ASSURANCES = new Set<SecurityAuthenticationAssurance>([
  'multi_factor',
  'hardware',
  'local_console',
]);

export class InvalidApprovedActionValueError extends TypeError {
  constructor(message: string) {
    super(`Approved Action contract is invalid: ${message}`);
    this.name = 'InvalidApprovedActionValueError';
  }
}

export class ApprovalRequestVersionConflictError extends Error {
  readonly code = 'APPROVAL_REQUEST_VERSION_CONFLICT';
  constructor() {
    super('Approval request version changed');
    this.name = 'ApprovalRequestVersionConflictError';
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

export class ApprovalMutationConflictError extends Error {
  readonly code = 'APPROVAL_MUTATION_CONFLICT';
  constructor() {
    super('Approval mutation conflicts with its previous request');
    this.name = 'ApprovalMutationConflictError';
  }
}

export class ApprovalHumanDecisionRequiredError extends Error {
  readonly code = 'APPROVAL_HUMAN_DECISION_REQUIRED';
  constructor() {
    super('Approval decision requires a strongly authenticated user');
    this.name = 'ApprovalHumanDecisionRequiredError';
  }
}

export class ApprovalSeparationOfDutyError extends Error {
  readonly code = 'APPROVAL_SEPARATION_OF_DUTY_REQUIRED';
  constructor() {
    super('Approval requester cannot decide a separated-duty request');
    this.name = 'ApprovalSeparationOfDutyError';
  }
}

export class ApprovalPolicyFenceConflictError extends Error {
  readonly code = 'APPROVAL_POLICY_FENCE_CONFLICT';
  constructor() {
    super('Approval policy snapshot changed before the mutation committed');
    this.name = 'ApprovalPolicyFenceConflictError';
  }
}

export class ApprovalRequestNotFoundError extends Error {
  readonly code = 'APPROVAL_REQUEST_NOT_FOUND';
  constructor() {
    super('Approval request does not exist');
    this.name = 'ApprovalRequestNotFoundError';
  }
}

export class ApprovalUnavailableError extends Error {
  readonly code = 'APPROVAL_UNAVAILABLE';
  constructor(options?: ErrorOptions) {
    super('Approval authority is unavailable', options);
    this.name = 'ApprovalUnavailableError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidApprovedActionValueError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidApprovedActionValueError(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidApprovedActionValueError(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidApprovedActionValueError(`${label} is invalid`);
  }
  return value as number;
}

function version(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_APPROVAL_REQUEST_VERSION
  ) {
    throw new InvalidApprovedActionValueError(`${label} is invalid`);
  }
  return value as number;
}

function nullable<T>(
  value: T | null,
  normalize: (candidate: T) => T,
): T | null {
  return value === null ? null : normalize(value);
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function sameFence(
  left: Readonly<SecurityPolicyFence>,
  right: Readonly<SecurityPolicyFence>,
): boolean {
  return (
    left.projectVersion === right.projectVersion &&
    left.bindingVersion === right.bindingVersion
  );
}

export function normalizeApprovedActionFence(
  value: SecurityPolicyFence,
): Readonly<SecurityPolicyFence> {
  const fence = record(value, 'policy fence');
  exactKeys(fence, ['projectVersion', 'bindingVersion'], 'policy fence');
  const projectVersion = version(
    value.projectVersion,
    'policy project version',
  );
  const bindingVersion =
    value.bindingVersion === null
      ? null
      : version(value.bindingVersion, 'policy binding version');
  return Object.freeze({ projectVersion, bindingVersion });
}

export function normalizeApprovedActionBinding(
  value: ApprovedActionBinding,
): Readonly<ApprovedActionBinding> {
  const binding = record(value, 'action binding');
  exactKeys(
    binding,
    [
      'permission',
      'actionType',
      'actionRef',
      'actionDigest',
      'previewDigest',
    ],
    'action binding',
  );
  const permission = normalizeProjectPermission(value.permission);
  const actionType = identifier(value.actionType, 'action type');
  if (
    typeof value.actionRef !== 'string' ||
    !ACTION_REF_PATTERN.test(value.actionRef)
  ) {
    throw new InvalidApprovedActionValueError('action reference is invalid');
  }
  if (
    typeof value.actionDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.actionDigest) ||
    typeof value.previewDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.previewDigest)
  ) {
    throw new InvalidApprovedActionValueError('action digest is invalid');
  }
  return Object.freeze({
    permission,
    actionType,
    actionRef: value.actionRef,
    actionDigest: value.actionDigest,
    previewDigest: value.previewDigest,
  });
}

function normalizeDecisionPrincipal(
  value: Readonly<SecurityPrincipal>,
  decidedAtMs: number,
): Readonly<SecurityPrincipal> {
  const principal = record(value, 'decision principal');
  exactKeys(
    principal,
    [
      'subject',
      'authenticationId',
      'authenticatedAtMs',
      'expiresAtMs',
      'assurance',
    ],
    'decision principal',
  );
  const subject = normalizeProjectPolicySubject(value.subject);
  if (
    subject.type !== 'user' ||
    !AUTHENTICATION_ID_PATTERN.test(value.authenticationId) ||
    !Number.isSafeInteger(value.authenticatedAtMs) ||
    value.authenticatedAtMs < 0 ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= decidedAtMs ||
    value.authenticatedAtMs > decidedAtMs ||
    !SECURITY_AUTHENTICATION_ASSURANCES.includes(value.assurance) ||
    !STRONG_HUMAN_ASSURANCES.has(value.assurance)
  ) {
    throw new ApprovalHumanDecisionRequiredError();
  }
  return Object.freeze({
    subject,
    authenticationId: value.authenticationId,
    authenticatedAtMs: value.authenticatedAtMs,
    expiresAtMs: value.expiresAtMs,
    assurance: value.assurance,
  });
}

function normalizeReason(value: unknown): string {
  if (typeof value !== 'string' || !REASON_PATTERN.test(value)) {
    throw new InvalidApprovedActionValueError('decision reason is invalid');
  }
  return value;
}

function sameAction(
  left: Readonly<ApprovedActionBinding>,
  right: Readonly<ApprovedActionBinding>,
): boolean {
  return (
    left.permission === right.permission &&
    left.actionType === right.actionType &&
    left.actionRef === right.actionRef &&
    left.actionDigest === right.actionDigest &&
    left.previewDigest === right.previewDigest
  );
}

function createDispatch(
  request: Readonly<ApprovalRequestRecord>,
): Readonly<ApprovedActionDispatchRecord> {
  if (
    request.state !== 'consumed' ||
    request.version !== 3 ||
    request.dispatchId === null ||
    request.consumedBy === null ||
    request.consumedAtMs === null ||
    request.decidedBy === null ||
    request.decisionAuthenticationId === null ||
    request.decisionAssurance === null ||
    request.decidedAtMs === null ||
    request.consumptionFence === null
  ) {
    throw new ApprovalRequestStateConflictError();
  }
  return Object.freeze({
    schema: APPROVED_ACTION_DISPATCH_SCHEMA,
    id: request.dispatchId,
    approvalRequestId: request.id,
    approvalRequestVersion: 3,
    projectId: request.projectId,
    action: request.action,
    requestedBy: request.requestedBy,
    consumedBy: request.consumedBy,
    approvedBy: request.decidedBy,
    approvalAuthenticationId: request.decisionAuthenticationId,
    approvalAssurance: request.decisionAssurance,
    approvedAtMs: request.decidedAtMs,
    expiresAtMs: request.expiresAtMs,
    approvalFence: request.consumptionFence,
    createdAtMs: request.consumedAtMs,
  });
}

export function createApprovalRequest(
  input: CreateApprovalRequestInput,
): Readonly<ApprovalRequestRecord> {
  const value = record(input, 'approval request input');
  exactKeys(
    value,
    [
      'id',
      'projectId',
      'action',
      'risk',
      'decisionMode',
      'requestedBy',
      'requestedAtMs',
      'expiresAtMs',
      'requestFence',
    ],
    'approval request input',
  );
  const requestedAtMs = timestamp(input.requestedAtMs, 'request time');
  const expiresAtMs = timestamp(input.expiresAtMs, 'expiry time');
  if (
    expiresAtMs <= requestedAtMs ||
    expiresAtMs - requestedAtMs > MAX_APPROVAL_LIFETIME_MS
  ) {
    throw new InvalidApprovedActionValueError(
      'approval lifetime is invalid',
    );
  }
  if (!APPROVAL_RISKS.includes(input.risk)) {
    throw new InvalidApprovedActionValueError('approval risk is invalid');
  }
  if (!APPROVAL_DECISION_MODES.includes(input.decisionMode)) {
    throw new InvalidApprovedActionValueError(
      'approval decision mode is invalid',
    );
  }
  return Object.freeze({
    schema: APPROVAL_REQUEST_SCHEMA,
    id: identifier(input.id, 'request id'),
    projectId: identifier(input.projectId, 'project id'),
    version: 1,
    state: 'pending',
    action: normalizeApprovedActionBinding(input.action),
    risk: input.risk,
    decisionMode: input.decisionMode,
    requestedBy: normalizeProjectPolicySubject(input.requestedBy),
    requestedAtMs,
    expiresAtMs,
    requestFence: normalizeApprovedActionFence(input.requestFence),
    decisionId: null,
    decision: null,
    decisionReasonCode: null,
    decidedBy: null,
    decisionAuthenticationId: null,
    decisionAssurance: null,
    decidedAtMs: null,
    decisionFence: null,
    consumptionId: null,
    dispatchId: null,
    consumedBy: null,
    consumedAtMs: null,
    consumptionFence: null,
  });
}

export function normalizeApprovalRequestRecord(
  value: ApprovalRequestRecord,
): Readonly<ApprovalRequestRecord> {
  const request = record(value, 'approval request');
  exactKeys(
    request,
    [
      'schema',
      'id',
      'projectId',
      'version',
      'state',
      'action',
      'risk',
      'decisionMode',
      'requestedBy',
      'requestedAtMs',
      'expiresAtMs',
      'requestFence',
      'decisionId',
      'decision',
      'decisionReasonCode',
      'decidedBy',
      'decisionAuthenticationId',
      'decisionAssurance',
      'decidedAtMs',
      'decisionFence',
      'consumptionId',
      'dispatchId',
      'consumedBy',
      'consumedAtMs',
      'consumptionFence',
    ],
    'approval request',
  );
  if (value.schema !== APPROVAL_REQUEST_SCHEMA) {
    throw new InvalidApprovedActionValueError(
      'approval request schema is invalid',
    );
  }
  const id = identifier(value.id, 'request id');
  const projectId = identifier(value.projectId, 'project id');
  const requestVersion = version(value.version, 'request version');
  if (!APPROVAL_REQUEST_STATES.includes(value.state)) {
    throw new InvalidApprovedActionValueError(
      'approval request state is invalid',
    );
  }
  if (!APPROVAL_RISKS.includes(value.risk)) {
    throw new InvalidApprovedActionValueError('approval risk is invalid');
  }
  if (!APPROVAL_DECISION_MODES.includes(value.decisionMode)) {
    throw new InvalidApprovedActionValueError(
      'approval decision mode is invalid',
    );
  }
  const requestedAtMs = timestamp(value.requestedAtMs, 'request time');
  const expiresAtMs = timestamp(value.expiresAtMs, 'expiry time');
  if (
    expiresAtMs <= requestedAtMs ||
    expiresAtMs - requestedAtMs > MAX_APPROVAL_LIFETIME_MS
  ) {
    throw new InvalidApprovedActionValueError(
      'approval lifetime is invalid',
    );
  }

  const decisionTuple = [
    value.decisionId,
    value.decision,
    value.decisionReasonCode,
    value.decidedBy,
    value.decisionAuthenticationId,
    value.decisionAssurance,
    value.decidedAtMs,
    value.decisionFence,
  ];
  const hasDecision = decisionTuple.every((candidate) => candidate !== null);
  if (!hasDecision && decisionTuple.some((candidate) => candidate !== null)) {
    throw new InvalidApprovedActionValueError('decision tuple is incomplete');
  }
  const consumptionTuple = [
    value.consumptionId,
    value.dispatchId,
    value.consumedBy,
    value.consumedAtMs,
    value.consumptionFence,
  ];
  const hasConsumption = consumptionTuple.every(
    (candidate) => candidate !== null,
  );
  if (
    !hasConsumption &&
    consumptionTuple.some((candidate) => candidate !== null)
  ) {
    throw new InvalidApprovedActionValueError(
      'consumption tuple is incomplete',
    );
  }

  const decidedAtMs =
    value.decidedAtMs === null
      ? null
      : timestamp(value.decidedAtMs, 'decision time');
  const consumedAtMs =
    value.consumedAtMs === null
      ? null
      : timestamp(value.consumedAtMs, 'consumption time');
  if (
    (value.state === 'pending' &&
      (requestVersion !== 1 || hasDecision || hasConsumption)) ||
    (value.state === 'approved' &&
      (requestVersion !== 2 ||
        !hasDecision ||
        value.decision !== 'approved' ||
        hasConsumption)) ||
    (value.state === 'rejected' &&
      (requestVersion !== 2 ||
        !hasDecision ||
        value.decision !== 'rejected' ||
        hasConsumption)) ||
    (value.state === 'consumed' &&
      (requestVersion !== 3 ||
        !hasDecision ||
        value.decision !== 'approved' ||
        !hasConsumption))
  ) {
    throw new InvalidApprovedActionValueError(
      'approval request state tuple is invalid',
    );
  }
  if (
    (decidedAtMs !== null &&
      (decidedAtMs < requestedAtMs || decidedAtMs >= expiresAtMs)) ||
    (consumedAtMs !== null &&
      (decidedAtMs === null ||
        consumedAtMs < decidedAtMs ||
        consumedAtMs >= expiresAtMs))
  ) {
    throw new InvalidApprovedActionValueError(
      'approval request timestamps are invalid',
    );
  }

  const decidedBy = nullable(value.decidedBy, (candidate) =>
    normalizeProjectPolicySubject(candidate),
  );
  if (decidedBy !== null && decidedBy.type !== 'user') {
    throw new InvalidApprovedActionValueError(
      'approval decision subject is invalid',
    );
  }
  if (
    value.decisionAssurance !== null &&
    (!SECURITY_AUTHENTICATION_ASSURANCES.includes(
      value.decisionAssurance,
    ) ||
      !STRONG_HUMAN_ASSURANCES.has(value.decisionAssurance))
  ) {
    throw new InvalidApprovedActionValueError(
      'approval decision assurance is invalid',
    );
  }
  if (
    value.decisionAuthenticationId !== null &&
    !AUTHENTICATION_ID_PATTERN.test(value.decisionAuthenticationId)
  ) {
    throw new InvalidApprovedActionValueError(
      'approval authentication id is invalid',
    );
  }
  if (
    hasDecision &&
    value.decisionMode === 'separation_of_duty' &&
    sameSubject(
      normalizeProjectPolicySubject(value.requestedBy),
      decidedBy!,
    )
  ) {
    throw new InvalidApprovedActionValueError(
      'approval separation of duty is invalid',
    );
  }
  const consumedBy = nullable(value.consumedBy, (candidate) =>
    normalizeProjectPolicySubject(candidate),
  );
  if (
    consumedBy !== null &&
    consumedBy.type !== 'system' &&
    consumedBy.type !== 'worker'
  ) {
    throw new InvalidApprovedActionValueError(
      'approval consumer is invalid',
    );
  }

  return Object.freeze({
    schema: APPROVAL_REQUEST_SCHEMA,
    id,
    projectId,
    version: requestVersion,
    state: value.state,
    action: normalizeApprovedActionBinding(value.action),
    risk: value.risk,
    decisionMode: value.decisionMode,
    requestedBy: normalizeProjectPolicySubject(value.requestedBy),
    requestedAtMs,
    expiresAtMs,
    requestFence: normalizeApprovedActionFence(value.requestFence),
    decisionId:
      value.decisionId === null
        ? null
        : identifier(value.decisionId, 'decision id'),
    decision:
      value.decision === null
        ? null
        : APPROVAL_DECISIONS.includes(value.decision)
          ? value.decision
          : (() => {
              throw new InvalidApprovedActionValueError(
                'approval decision is invalid',
              );
            })(),
    decisionReasonCode:
      value.decisionReasonCode === null
        ? null
        : normalizeReason(value.decisionReasonCode),
    decidedBy,
    decisionAuthenticationId: value.decisionAuthenticationId,
    decisionAssurance: value.decisionAssurance,
    decidedAtMs,
    decisionFence:
      value.decisionFence === null
        ? null
        : normalizeApprovedActionFence(value.decisionFence),
    consumptionId:
      value.consumptionId === null
        ? null
        : identifier(value.consumptionId, 'consumption id'),
    dispatchId:
      value.dispatchId === null
        ? null
        : identifier(value.dispatchId, 'dispatch id'),
    consumedBy,
    consumedAtMs,
    consumptionFence:
      value.consumptionFence === null
        ? null
        : normalizeApprovedActionFence(value.consumptionFence),
  });
}

export function decideApprovalRequest(
  currentValue: ApprovalRequestRecord,
  command: DecideApprovalRequestCommand,
): Readonly<ApprovalRequestRecord> {
  const current = normalizeApprovalRequestRecord(currentValue);
  const value = record(command, 'approval decision command');
  exactKeys(
    value,
    [
      'expectedVersion',
      'decisionId',
      'decision',
      'reasonCode',
      'principal',
      'decidedAtMs',
      'authorizationFence',
    ],
    'approval decision command',
  );
  const expectedVersion = version(
    command.expectedVersion,
    'expected request version',
  );
  const decisionId = identifier(command.decisionId, 'decision id');
  if (!APPROVAL_DECISIONS.includes(command.decision)) {
    throw new InvalidApprovedActionValueError('approval decision is invalid');
  }
  const reasonCode = normalizeReason(command.reasonCode);
  const decidedAtMs = timestamp(command.decidedAtMs, 'decision time');
  const principal = normalizeDecisionPrincipal(command.principal, decidedAtMs);
  const authorizationFence = normalizeApprovedActionFence(
    command.authorizationFence,
  );

  if (current.decisionId === decisionId) {
    if (
      current.version !== 2 ||
      expectedVersion !== 1 ||
      current.decision !== command.decision ||
      current.decisionReasonCode !== reasonCode ||
      current.decidedBy === null ||
      !sameSubject(current.decidedBy, principal.subject) ||
      current.decisionAuthenticationId !== principal.authenticationId ||
      current.decisionAssurance !== principal.assurance ||
      current.decidedAtMs !== decidedAtMs ||
      current.decisionFence === null ||
      !sameFence(current.decisionFence, authorizationFence)
    ) {
      throw new ApprovalMutationConflictError();
    }
    return current;
  }
  if (decidedAtMs >= current.expiresAtMs) {
    throw new ApprovalRequestExpiredError();
  }
  if (current.version !== expectedVersion) {
    throw new ApprovalRequestVersionConflictError();
  }
  if (current.state !== 'pending' || expectedVersion !== 1) {
    throw new ApprovalRequestStateConflictError();
  }
  if (
    current.decisionMode === 'separation_of_duty' &&
    sameSubject(current.requestedBy, principal.subject)
  ) {
    throw new ApprovalSeparationOfDutyError();
  }
  return normalizeApprovalRequestRecord({
    ...current,
    version: 2,
    state: command.decision,
    decisionId,
    decision: command.decision,
    decisionReasonCode: reasonCode,
    decidedBy: principal.subject,
    decisionAuthenticationId: principal.authenticationId,
    decisionAssurance: principal.assurance,
    decidedAtMs,
    decisionFence: authorizationFence,
  });
}

export function consumeApprovalRequest(
  currentValue: ApprovalRequestRecord,
  command: ConsumeApprovalRequestCommand,
): Readonly<ConsumeApprovalRequestResult> {
  const current = normalizeApprovalRequestRecord(currentValue);
  const value = record(command, 'approval consumption command');
  exactKeys(
    value,
    [
      'expectedVersion',
      'consumptionId',
      'dispatchId',
      'action',
      'requestedBy',
      'consumedBy',
      'consumedAtMs',
      'authorizationFence',
    ],
    'approval consumption command',
  );
  const expectedVersion = version(
    command.expectedVersion,
    'expected request version',
  );
  const consumptionId = identifier(command.consumptionId, 'consumption id');
  const dispatchId = identifier(command.dispatchId, 'dispatch id');
  const action = normalizeApprovedActionBinding(command.action);
  const requestedBy = normalizeProjectPolicySubject(command.requestedBy);
  const consumedBy = normalizeProjectPolicySubject(command.consumedBy);
  if (consumedBy.type !== 'system' && consumedBy.type !== 'worker') {
    throw new InvalidApprovedActionValueError(
      'approval consumer is invalid',
    );
  }
  const consumedAtMs = timestamp(command.consumedAtMs, 'consumption time');
  const authorizationFence = normalizeApprovedActionFence(
    command.authorizationFence,
  );

  if (current.consumptionId === consumptionId) {
    if (
      current.version !== 3 ||
      expectedVersion !== 2 ||
      current.dispatchId !== dispatchId ||
      !sameAction(current.action, action) ||
      !sameSubject(current.requestedBy, requestedBy) ||
      current.consumedBy === null ||
      !sameSubject(current.consumedBy, consumedBy) ||
      current.consumedAtMs !== consumedAtMs ||
      current.consumptionFence === null ||
      !sameFence(current.consumptionFence, authorizationFence)
    ) {
      throw new ApprovalMutationConflictError();
    }
    return Object.freeze({
      request: current,
      dispatch: createDispatch(current),
    });
  }
  if (consumedAtMs >= current.expiresAtMs) {
    throw new ApprovalRequestExpiredError();
  }
  if (current.version !== expectedVersion) {
    throw new ApprovalRequestVersionConflictError();
  }
  if (
    current.state !== 'approved' ||
    current.decision !== 'approved' ||
    expectedVersion !== 2
  ) {
    throw new ApprovalRequestStateConflictError();
  }
  if (
    !sameAction(current.action, action) ||
    !sameSubject(current.requestedBy, requestedBy)
  ) {
    throw new ApprovalMutationConflictError();
  }
  const consumed = normalizeApprovalRequestRecord({
    ...current,
    version: 3,
    state: 'consumed',
    consumptionId,
    dispatchId,
    consumedBy,
    consumedAtMs,
    consumptionFence: authorizationFence,
  });
  return Object.freeze({
    request: consumed,
    dispatch: createDispatch(consumed),
  });
}

export function normalizeApprovedActionDispatchRecord(
  value: ApprovedActionDispatchRecord,
): Readonly<ApprovedActionDispatchRecord> {
  const dispatch = record(value, 'approved action dispatch');
  exactKeys(
    dispatch,
    [
      'schema',
      'id',
      'approvalRequestId',
      'approvalRequestVersion',
      'projectId',
      'action',
      'requestedBy',
      'consumedBy',
      'approvedBy',
      'approvalAuthenticationId',
      'approvalAssurance',
      'approvedAtMs',
      'expiresAtMs',
      'approvalFence',
      'createdAtMs',
    ],
    'approved action dispatch',
  );
  if (
    value.schema !== APPROVED_ACTION_DISPATCH_SCHEMA ||
    value.approvalRequestVersion !== 3
  ) {
    throw new InvalidApprovedActionValueError(
      'approved action dispatch schema is invalid',
    );
  }
  const requestedBy = normalizeProjectPolicySubject(value.requestedBy);
  const consumedBy = normalizeProjectPolicySubject(value.consumedBy);
  const approvedBy = normalizeProjectPolicySubject(value.approvedBy);
  if (
    (consumedBy.type !== 'system' && consumedBy.type !== 'worker') ||
    approvedBy.type !== 'user' ||
    !AUTHENTICATION_ID_PATTERN.test(value.approvalAuthenticationId) ||
    !SECURITY_AUTHENTICATION_ASSURANCES.includes(value.approvalAssurance) ||
    !STRONG_HUMAN_ASSURANCES.has(value.approvalAssurance)
  ) {
    throw new InvalidApprovedActionValueError(
      'approved action dispatch authority is invalid',
    );
  }
  const approvedAtMs = timestamp(value.approvedAtMs, 'approval time');
  const createdAtMs = timestamp(value.createdAtMs, 'dispatch creation time');
  const expiresAtMs = timestamp(value.expiresAtMs, 'approval expiry time');
  if (
    createdAtMs < approvedAtMs ||
    createdAtMs >= expiresAtMs ||
    approvedAtMs >= expiresAtMs
  ) {
    throw new InvalidApprovedActionValueError(
      'approved action dispatch lifetime is invalid',
    );
  }
  return Object.freeze({
    schema: APPROVED_ACTION_DISPATCH_SCHEMA,
    id: identifier(value.id, 'dispatch id'),
    approvalRequestId: identifier(
      value.approvalRequestId,
      'approval request id',
    ),
    approvalRequestVersion: 3,
    projectId: identifier(value.projectId, 'project id'),
    action: normalizeApprovedActionBinding(value.action),
    requestedBy,
    consumedBy,
    approvedBy,
    approvalAuthenticationId: value.approvalAuthenticationId,
    approvalAssurance: value.approvalAssurance,
    approvedAtMs,
    expiresAtMs,
    approvalFence: normalizeApprovedActionFence(value.approvalFence),
    createdAtMs,
  });
}

export function approvalRequestEffectiveStatus(
  value: ApprovalRequestRecord,
  nowMs: number,
): ApprovalRequestEffectiveStatus {
  const request = normalizeApprovalRequestRecord(value);
  const observedAtMs = timestamp(nowMs, 'observation time');
  return request.state === 'pending' && observedAtMs >= request.expiresAtMs
    ? 'expired'
    : request.state;
}

function contractDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(value))
    .digest('hex');
}

export function approvalRequestDigest(value: ApprovalRequestRecord): string {
  return contractDigest(
    'qinglong/approval-request-digest@v1',
    normalizeApprovalRequestRecord(value),
  );
}

export function approvedActionDispatchDigest(
  value: ApprovedActionDispatchRecord,
): string {
  return contractDigest(
    'qinglong/approved-action-dispatch-digest@v1',
    normalizeApprovedActionDispatchRecord(value),
  );
}
