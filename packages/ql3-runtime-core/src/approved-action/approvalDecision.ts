import {
  ApprovalUnavailableError,
  normalizeApprovedActionBinding,
  normalizeApprovalRequestRecord,
  type ApprovalDecision,
  type ApprovalRequestRecord,
  type ApprovalRequestRepository,
  type ApprovedActionBinding,
  type DecideApprovalRequestResult,
} from './approvedAction';
import { ProjectPolicyEngine } from '../security/project-policy/projectPolicy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
  type SecurityPrincipal,
} from '../security/security';
import type { SecurityAuditRecord } from '../security/audit/securityAudit';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRONG_HUMAN_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

export interface ApprovalDecisionRequest {
  readonly projectId: string;
  readonly approvalRequestId: string;
  readonly expectedVersion: number;
  readonly expectedAction: Readonly<ApprovedActionBinding>;
  readonly decisionId: string;
  readonly decision: ApprovalDecision;
  readonly reasonCode: string;
  readonly auditEventId: string;
  readonly requestId: string;
  readonly principal: Readonly<SecurityPrincipal>;
}

export interface ApprovalDecisionService {
  decide(
    request: ApprovalDecisionRequest,
  ): Promise<Readonly<DecideApprovalRequestResult>>;
}

export interface ApprovalDecisionServiceOptions {
  readonly approvals: Pick<
    ApprovalRequestRepository,
    'findById' | 'decide'
  >;
  readonly policy: Pick<ProjectPolicyEngine, 'authorize'>;
  readonly confirmAuthorization?: () => void | Promise<void>;
  readonly now?: () => number;
}

export class ApprovalDecisionRequestError extends TypeError {
  readonly code = 'APPROVAL_DECISION_REQUEST_INVALID';

  constructor(message: string) {
    super(`Approval decision request is invalid: ${message}`);
    this.name = 'ApprovalDecisionRequestError';
  }
}

export class ApprovalDecisionAuthorizationError extends Error {
  readonly code = 'APPROVAL_DECISION_AUTHORIZATION_REJECTED';

  constructor() {
    super('Approval decision authorization was rejected');
    this.name = 'ApprovalDecisionAuthorizationError';
  }
}

export class ApprovalDecisionTargetUnavailableError extends Error {
  readonly code = 'APPROVAL_DECISION_TARGET_UNAVAILABLE';

  constructor() {
    super('Approval decision target is unavailable');
    this.name = 'ApprovalDecisionTargetUnavailableError';
  }
}

export class ApprovalDecisionBindingConflictError extends Error {
  readonly code = 'APPROVAL_DECISION_BINDING_CONFLICT';

  constructor() {
    super('Approval decision does not match the reviewed action binding');
    this.name = 'ApprovalDecisionBindingConflictError';
  }
}

export class ApprovalDecisionUnavailableError extends Error {
  readonly code = 'APPROVAL_DECISION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Approval decision authority is unavailable', options);
    this.name = 'ApprovalDecisionUnavailableError';
  }
}

function exactObject(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')
  ) {
    throw new ApprovalDecisionRequestError(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new ApprovalDecisionRequestError(`${label} is invalid`);
  }
  return value;
}

function action(
  value: Readonly<ApprovedActionBinding>,
): Readonly<ApprovedActionBinding> {
  try {
    return normalizeApprovedActionBinding(value);
  } catch {
    throw new ApprovalDecisionRequestError('expected action is invalid');
  }
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

function sameSubject(
  left: Readonly<SecurityPrincipal>['subject'],
  right: Readonly<SecurityPrincipal>['subject'],
): boolean {
  return left.type === right.type && left.id === right.id;
}

function observedTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApprovalDecisionUnavailableError();
  }
  return value;
}

function audit(
  request: Readonly<ApprovalDecisionRequest>,
  principal: Readonly<SecurityPrincipal>,
  fence: Readonly<SecurityPolicyFence>,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  return Object.freeze({
    eventId: request.auditEventId,
    requestId: request.requestId,
    operationId: 'approval.decide',
    projectId: request.projectId,
    subject: principal.subject,
    authenticationId: principal.authenticationId,
    outcome: 'allowed',
    reasons: Object.freeze(['human_approval_decision']),
    fence,
    occurredAtMs,
  });
}

function normalizeRequest(
  value: ApprovalDecisionRequest,
): Readonly<ApprovalDecisionRequest> {
  exactObject(
    value,
    [
      'projectId',
      'approvalRequestId',
      'expectedVersion',
      'expectedAction',
      'decisionId',
      'decision',
      'reasonCode',
      'auditEventId',
      'requestId',
      'principal',
    ],
    'request',
  );
  const projectId = identifier(value.projectId, 'projectId');
  const approvalRequestId = identifier(
    value.approvalRequestId,
    'approvalRequestId',
  );
  const requestId = identifier(value.requestId, 'requestId');
  const decisionId = identifier(value.decisionId, 'decisionId');
  if (value.expectedVersion !== 1) {
    throw new ApprovalDecisionRequestError('expectedVersion must be 1');
  }
  if (value.decision !== 'approved' && value.decision !== 'rejected') {
    throw new ApprovalDecisionRequestError('decision is invalid');
  }
  if (
    typeof value.reasonCode !== 'string' ||
    !REASON_PATTERN.test(value.reasonCode)
  ) {
    throw new ApprovalDecisionRequestError('reasonCode is invalid');
  }
  if (
    typeof value.auditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.auditEventId)
  ) {
    throw new ApprovalDecisionRequestError('auditEventId is invalid');
  }
  return Object.freeze({
    projectId,
    approvalRequestId,
    expectedVersion: 1,
    expectedAction: action(value.expectedAction),
    decisionId,
    decision: value.decision,
    reasonCode: value.reasonCode,
    auditEventId: value.auditEventId,
    requestId,
    principal: value.principal,
  });
}

export function createApprovalDecisionService(
  candidateOptions: ApprovalDecisionServiceOptions,
): Readonly<ApprovalDecisionService> {
  exactObject(
    candidateOptions,
    [
      'approvals',
      'policy',
      ...(candidateOptions?.confirmAuthorization === undefined
        ? []
        : ['confirmAuthorization']),
      ...(candidateOptions?.now === undefined ? [] : ['now']),
    ],
    'options',
  );
  if (
    typeof candidateOptions.approvals?.findById !== 'function' ||
    typeof candidateOptions.approvals?.decide !== 'function' ||
    typeof candidateOptions.policy?.authorize !== 'function' ||
    (candidateOptions.confirmAuthorization !== undefined &&
      typeof candidateOptions.confirmAuthorization !== 'function') ||
    (candidateOptions.now !== undefined && typeof candidateOptions.now !== 'function')
  ) {
    throw new ApprovalDecisionRequestError('options are invalid');
  }
  const now = candidateOptions.now ?? Date.now;
  return Object.freeze({
    async decide(requestValue: ApprovalDecisionRequest) {
      const request = normalizeRequest(requestValue);
      const decidedAtMs = observedTime(now);
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(request.principal, decidedAtMs);
      } catch {
        throw new ApprovalDecisionAuthorizationError();
      }
      if (
        principal.subject.type !== 'user' ||
        !STRONG_HUMAN_ASSURANCES.has(principal.assurance)
      ) {
        throw new ApprovalDecisionAuthorizationError();
      }
      let authorization;
      try {
        authorization = await candidateOptions.policy.authorize(
          principal,
          request.projectId,
          'approval.decide',
        );
      } catch (error) {
        throw new ApprovalDecisionUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (authorization.effect !== 'allow' || authorization.fence === null) {
        throw new ApprovalDecisionAuthorizationError();
      }
      let current: Readonly<ApprovalRequestRecord> | null;
      try {
        const found = await candidateOptions.approvals.findById(
          request.approvalRequestId,
        );
        current = found ? normalizeApprovalRequestRecord(found) : null;
      } catch (error) {
        throw new ApprovalDecisionUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (!current || current.projectId !== request.projectId) {
        throw new ApprovalDecisionTargetUnavailableError();
      }
      if (!sameAction(current.action, request.expectedAction)) {
        throw new ApprovalDecisionBindingConflictError();
      }
      if (
        current.version === 2 &&
        current.decisionId === request.decisionId &&
        current.decision === request.decision &&
        current.decisionReasonCode === request.reasonCode &&
        current.decidedBy !== null &&
        sameSubject(current.decidedBy, principal.subject)
      ) {
        await candidateOptions.confirmAuthorization?.();
        return Object.freeze({ status: 'existing' as const, request: current });
      }
      await candidateOptions.confirmAuthorization?.();
      try {
        return await candidateOptions.approvals.decide({
          requestId: request.approvalRequestId,
          expectedVersion: request.expectedVersion,
          decisionId: request.decisionId,
          decision: request.decision,
          reasonCode: request.reasonCode,
          principal,
          decidedAtMs,
          authorizationFence: authorization.fence,
          audit: audit(request, principal, authorization.fence, decidedAtMs),
        });
      } catch (error) {
        if (error instanceof ApprovalUnavailableError) {
          throw new ApprovalDecisionUnavailableError({ cause: error });
        }
        throw error;
      }
    },
  });
}
