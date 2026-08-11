import {
  ApprovalMutationConflictError,
  ApprovalPolicyFenceConflictError,
  ApprovalRequestExpiredError,
  ApprovalRequestStateConflictError,
  ApprovalRequestVersionConflictError,
  normalizeApprovedActionBinding,
  type ApprovedActionBinding,
} from '@qinglong/runtime-core/approved-action';
import {
  ApprovalDecisionAuthorizationError,
  ApprovalDecisionBindingConflictError,
  ApprovalDecisionTargetUnavailableError,
  ApprovalDecisionUnavailableError,
} from '@qinglong/runtime-core/approval-decision';
import {
  ApprovalInspectionAuthorizationError,
  ApprovalInspectionUnavailableError,
} from '@qinglong/runtime-core/approval-inspection';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import type { ClusterApprovalManagementService } from './approvalManagement';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRONG_ASSURANCES = new Set(['multi_factor', 'hardware']);

interface BaseRequest {
  readonly projectId: string;
  readonly approvalRequestId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly failureAuditEventId: string;
}

export type ClusterApprovalManagementCommand =
  | Readonly<{
      schemaVersion: 1;
      operation: 'approval.inspect';
      request: BaseRequest;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'approval.decide';
      request: BaseRequest & {
        readonly expectedVersion: 1;
        readonly expectedAction: Readonly<ApprovedActionBinding>;
        readonly decisionId: string;
        readonly decision: 'approved' | 'rejected';
        readonly reasonCode: string;
      };
    }>;

export type ClusterApprovalManagementTransportResult = Readonly<
  Record<string, unknown> & {
    readonly schemaVersion: 1;
    readonly operation: ClusterApprovalManagementCommand['operation'];
  }
>;

export interface ClusterApprovalManagementAuthentication {
  authenticate(): Promise<Readonly<SecurityPrincipal> | null>;
}

export interface ClusterApprovalManagementTransport {
  execute(
    command: unknown,
    authentication: ClusterApprovalManagementAuthentication,
  ): Promise<Readonly<ClusterApprovalManagementTransportResult>>;
}

export class ClusterApprovalManagementTransportConfigurationError extends TypeError {
  readonly code = 'CLUSTER_APPROVAL_TRANSPORT_CONFIGURATION_INVALID';
  constructor() {
    super('Cluster Approval transport configuration is invalid');
    this.name = 'ClusterApprovalManagementTransportConfigurationError';
  }
}

export class ClusterApprovalManagementTransportRequestError extends TypeError {
  readonly code = 'CLUSTER_APPROVAL_TRANSPORT_REQUEST_INVALID';
  constructor() {
    super('Cluster Approval transport request is invalid');
    this.name = 'ClusterApprovalManagementTransportRequestError';
  }
}

export class ClusterApprovalManagementTransportAuthenticationError extends Error {
  readonly code = 'CLUSTER_APPROVAL_TRANSPORT_AUTHENTICATION_REQUIRED';
  constructor() {
    super('Cluster Approval transport requires a strong User principal');
    this.name = 'ClusterApprovalManagementTransportAuthenticationError';
  }
}

export class ClusterApprovalManagementTransportAuthorizationError extends Error {
  readonly code = 'CLUSTER_APPROVAL_TRANSPORT_AUTHORIZATION_REJECTED';
  constructor() {
    super('Cluster Approval transport authorization was rejected');
    this.name = 'ClusterApprovalManagementTransportAuthorizationError';
  }
}

export class ClusterApprovalManagementTransportTargetUnavailableError extends Error {
  readonly code = 'CLUSTER_APPROVAL_TRANSPORT_TARGET_UNAVAILABLE';
  constructor() {
    super('Cluster Approval target is unavailable');
    this.name = 'ClusterApprovalManagementTransportTargetUnavailableError';
  }
}

export class ClusterApprovalManagementTransportConflictError extends Error {
  readonly code = 'CLUSTER_APPROVAL_TRANSPORT_CONFLICT';
  constructor() {
    super('Cluster Approval transport observed a conflict');
    this.name = 'ClusterApprovalManagementTransportConflictError';
  }
}

export class ClusterApprovalManagementTransportUnavailableError extends Error {
  readonly code = 'CLUSTER_APPROVAL_TRANSPORT_UNAVAILABLE';
  constructor() {
    super('Cluster Approval transport is unavailable');
    this.name = 'ClusterApprovalManagementTransportUnavailableError';
  }
}

function invalid(): never {
  throw new ClusterApprovalManagementTransportRequestError();
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const actual = Object.keys(value as object).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) invalid();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) invalid();
  return value;
}

export function normalizeClusterApprovalManagementCommand(
  value: unknown,
): Readonly<ClusterApprovalManagementCommand> {
  const envelope = exact(value, ['schemaVersion', 'operation', 'request']);
  if (
    envelope.schemaVersion !== 1 ||
    (envelope.operation !== 'approval.inspect' &&
      envelope.operation !== 'approval.decide')
  ) {
    invalid();
  }
  const operation = envelope.operation;
  const base = [
    'projectId',
    'approvalRequestId',
    'requestId',
    'auditEventId',
    'failureAuditEventId',
  ];
  const request = exact(
    envelope.request,
    operation === 'approval.inspect'
      ? base
      : [
          ...base,
          'expectedVersion',
          'expectedAction',
          'decisionId',
          'decision',
          'reasonCode',
        ],
  );
  const normalizedBase = {
    projectId: identifier(request.projectId),
    approvalRequestId: identifier(request.approvalRequestId),
    requestId: identifier(request.requestId),
    auditEventId: uuid(request.auditEventId),
    failureAuditEventId: uuid(request.failureAuditEventId),
  };
  if (normalizedBase.auditEventId === normalizedBase.failureAuditEventId) invalid();
  if (operation === 'approval.inspect') {
    return Object.freeze({
      schemaVersion: 1,
      operation,
      request: Object.freeze(normalizedBase),
    });
  }
  if (
    request.expectedVersion !== 1 ||
    (request.decision !== 'approved' && request.decision !== 'rejected') ||
    typeof request.reasonCode !== 'string' ||
    !REASON_PATTERN.test(request.reasonCode)
  ) {
    invalid();
  }
  let expectedAction: Readonly<ApprovedActionBinding>;
  try {
    expectedAction = normalizeApprovedActionBinding(
      request.expectedAction as ApprovedActionBinding,
    );
  } catch {
    invalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    operation,
    request: Object.freeze({
      ...normalizedBase,
      expectedVersion: 1,
      expectedAction,
      decisionId: identifier(request.decisionId),
      decision: request.decision,
      reasonCode: request.reasonCode,
    }),
  });
}

function authenticatedPrincipal(
  candidate: Readonly<SecurityPrincipal> | null,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(candidate as SecurityPrincipal, nowMs);
  } catch {
    throw new ClusterApprovalManagementTransportAuthenticationError();
  }
  if (
    principal.subject.type !== 'user' ||
    !STRONG_ASSURANCES.has(principal.assurance)
  ) {
    throw new ClusterApprovalManagementTransportAuthenticationError();
  }
  return principal;
}

function samePrincipal(
  left: Readonly<SecurityPrincipal>,
  right: Readonly<SecurityPrincipal>,
): boolean {
  return (
    left.subject.type === right.subject.type &&
    left.subject.id === right.subject.id &&
    left.authenticationId === right.authenticationId &&
    left.authenticatedAtMs === right.authenticatedAtMs &&
    left.expiresAtMs === right.expiresAtMs &&
    left.assurance === right.assurance
  );
}

function failureReason(error: unknown, authenticated: boolean): Readonly<{
  outcome: SecurityAuditRecord['outcome'];
  reason: string;
}> {
  if (error instanceof ClusterApprovalManagementTransportAuthenticationError) {
    return authenticated
      ? Object.freeze({
          outcome: 'denied',
          reason: 'identity_confirmation_rejected',
        })
      : Object.freeze({
          outcome: 'authentication_rejected',
          reason: 'identity_assertion_rejected',
        });
  }
  if (
    error instanceof ApprovalInspectionAuthorizationError ||
    error instanceof ApprovalDecisionAuthorizationError
  ) {
    return Object.freeze({ outcome: 'denied', reason: 'policy_rejected' });
  }
  if (error instanceof ApprovalDecisionTargetUnavailableError) {
    return Object.freeze({ outcome: 'denied', reason: 'approval_target_unavailable' });
  }
  if (error instanceof ApprovalDecisionBindingConflictError) {
    return Object.freeze({ outcome: 'denied', reason: 'approval_binding_conflict' });
  }
  if (
    error instanceof ApprovalRequestVersionConflictError ||
    error instanceof ApprovalRequestStateConflictError ||
    error instanceof ApprovalRequestExpiredError ||
    error instanceof ApprovalMutationConflictError ||
    error instanceof ApprovalPolicyFenceConflictError
  ) {
    return Object.freeze({ outcome: 'denied', reason: 'approval_state_or_fence_conflict' });
  }
  return Object.freeze({
    outcome: 'authorization_unavailable',
    reason: 'approval_authority_unavailable',
  });
}

function observedTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ClusterApprovalManagementTransportUnavailableError();
  }
  return value;
}

function mapped(error: unknown): Error {
  if (
    error instanceof ApprovalInspectionAuthorizationError ||
    error instanceof ApprovalDecisionAuthorizationError
  ) {
    return new ClusterApprovalManagementTransportAuthorizationError();
  }
  if (error instanceof ApprovalDecisionTargetUnavailableError) {
    return new ClusterApprovalManagementTransportTargetUnavailableError();
  }
  if (
    error instanceof ApprovalDecisionBindingConflictError ||
    error instanceof ApprovalRequestVersionConflictError ||
    error instanceof ApprovalRequestStateConflictError ||
    error instanceof ApprovalRequestExpiredError ||
    error instanceof ApprovalMutationConflictError ||
    error instanceof ApprovalPolicyFenceConflictError
  ) {
    return new ClusterApprovalManagementTransportConflictError();
  }
  if (
    error instanceof ApprovalInspectionUnavailableError ||
    error instanceof ApprovalDecisionUnavailableError
  ) {
    return new ClusterApprovalManagementTransportUnavailableError();
  }
  return error instanceof Error
    ? error
    : new ClusterApprovalManagementTransportUnavailableError();
}

export function createClusterApprovalManagementTransport(options: Readonly<{
  service: ClusterApprovalManagementService;
  now?: () => number;
}>): Readonly<ClusterApprovalManagementTransport> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'service' && key !== 'now') ||
    typeof options.service?.inspect !== 'function' ||
    typeof options.service?.decide !== 'function' ||
    typeof options.service?.recordFailure !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new ClusterApprovalManagementTransportConfigurationError();
  }
  const now = options.now ?? Date.now;
  return Object.freeze({
    async execute(
      commandValue: unknown,
      authentication: ClusterApprovalManagementAuthentication,
    ) {
      const command = normalizeClusterApprovalManagementCommand(commandValue);
      if (
        !authentication ||
        typeof authentication !== 'object' ||
        Array.isArray(authentication) ||
        Object.keys(authentication).length !== 1 ||
        typeof authentication.authenticate !== 'function'
      ) {
        throw new ClusterApprovalManagementTransportConfigurationError();
      }
      let principal: Readonly<SecurityPrincipal> | undefined;
      try {
        try {
          principal = authenticatedPrincipal(
            await authentication.authenticate(),
            observedTime(now),
          );
        } catch (error) {
          if (error instanceof ClusterApprovalManagementTransportAuthenticationError) {
            throw error;
          }
          throw new ClusterApprovalManagementTransportUnavailableError();
        }
        const confirmAuthorization = async (): Promise<void> => {
          let confirmed: Readonly<SecurityPrincipal>;
          try {
            confirmed = authenticatedPrincipal(
              await authentication.authenticate(),
              observedTime(now),
            );
          } catch {
            throw new ClusterApprovalManagementTransportAuthenticationError();
          }
          if (!samePrincipal(principal!, confirmed)) {
            throw new ClusterApprovalManagementTransportAuthenticationError();
          }
        };
        if (command.operation === 'approval.inspect') {
          const detail = await options.service.inspect(
            {
              projectId: command.request.projectId,
              approvalRequestId: command.request.approvalRequestId,
              auditEventId: command.request.auditEventId,
              requestId: command.request.requestId,
              principal,
            },
            confirmAuthorization,
          );
          if (!detail) {
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              status: 'absent' as const,
              approval: null,
            });
          }
          const request = detail.request;
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: 'found' as const,
            approval: Object.freeze({
              projectId: request.projectId,
              approvalRequestId: request.id,
              version: request.version,
              state: request.state,
              risk: request.risk,
              decisionMode: request.decisionMode,
              expectedAction: request.action,
              requestedBy: request.requestedBy,
              requestedAtMs: request.requestedAtMs,
              expiresAtMs: request.expiresAtMs,
              preview: detail.preview,
            }),
          });
        }
        const result = await options.service.decide(
          {
            projectId: command.request.projectId,
            approvalRequestId: command.request.approvalRequestId,
            expectedVersion: command.request.expectedVersion,
            expectedAction: command.request.expectedAction,
            decisionId: command.request.decisionId,
            decision: command.request.decision,
            reasonCode: command.request.reasonCode,
            auditEventId: command.request.auditEventId,
            requestId: command.request.requestId,
            principal,
          },
          confirmAuthorization,
        );
        return Object.freeze({
          schemaVersion: 1 as const,
          operation: command.operation,
          status: result.status,
          approval: Object.freeze({
            projectId: result.request.projectId,
            approvalRequestId: result.request.id,
            version: result.request.version,
            state: result.request.state,
            expectedAction: result.request.action,
            decisionId: result.request.decisionId,
            decision: result.request.decision,
            reasonCode: result.request.decisionReasonCode,
            decidedBy: result.request.decidedBy,
            decidedAtMs: result.request.decidedAtMs,
          }),
        });
      } catch (error) {
        if (!(error instanceof ClusterApprovalManagementTransportConfigurationError)) {
          const fact = failureReason(error, principal !== undefined);
          try {
            await options.service.recordFailure({
              eventId: command.request.failureAuditEventId,
              requestId: command.request.requestId,
              operationId: command.operation,
              projectId: command.request.projectId,
              subject: principal?.subject ?? null,
              authenticationId: principal?.authenticationId ?? null,
              outcome: fact.outcome,
              reasons: Object.freeze([fact.reason]),
              fence: null,
              occurredAtMs: observedTime(now),
            });
          } catch {
            throw new ClusterApprovalManagementTransportUnavailableError();
          }
        }
        throw mapped(error);
      }
    },
  });
}
