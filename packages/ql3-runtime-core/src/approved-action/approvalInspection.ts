import { normalizeApprovalRequestRecord } from './approvedAction';
import {
  normalizeApprovalDetailPreview,
  type ApprovalRequestDetail,
  type ApprovalRequestDetailSource,
} from './approvalDiscovery';
import { ProjectPolicyEngine } from '../security/project-policy/projectPolicy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
  type SecurityPrincipal,
} from '../security/security';
import type { SecurityAuditSink } from '../security/audit/securityAudit';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRONG_HUMAN_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

export interface ApprovalInspectionRequest {
  readonly projectId: string;
  readonly approvalRequestId: string;
  readonly auditEventId: string;
  readonly requestId: string;
  readonly principal: Readonly<SecurityPrincipal>;
}

export interface ApprovalInspectionService {
  inspect(
    request: ApprovalInspectionRequest,
  ): Promise<Readonly<ApprovalRequestDetail> | null>;
}

export interface ApprovalInspectionServiceOptions {
  readonly source: Pick<ApprovalRequestDetailSource, 'getApprovalRequestDetail'>;
  readonly policy: Pick<ProjectPolicyEngine, 'authorize'>;
  readonly audit: Pick<SecurityAuditSink, 'record'>;
  readonly confirmAuthorization?: () => void | Promise<void>;
  readonly now?: () => number;
}

export class ApprovalInspectionRequestError extends TypeError {
  readonly code = 'APPROVAL_INSPECTION_REQUEST_INVALID';

  constructor(message: string) {
    super(`Approval inspection request is invalid: ${message}`);
    this.name = 'ApprovalInspectionRequestError';
  }
}

export class ApprovalInspectionAuthorizationError extends Error {
  readonly code = 'APPROVAL_INSPECTION_AUTHORIZATION_REJECTED';

  constructor() {
    super('Approval inspection authorization was rejected');
    this.name = 'ApprovalInspectionAuthorizationError';
  }
}

export class ApprovalInspectionUnavailableError extends Error {
  readonly code = 'APPROVAL_INSPECTION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Approval inspection authority is unavailable', options);
    this.name = 'ApprovalInspectionUnavailableError';
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
    throw new ApprovalInspectionRequestError(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new ApprovalInspectionRequestError(`${label} is invalid`);
  }
  return value;
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

function observedTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApprovalInspectionUnavailableError();
  }
  return value;
}

function normalizedRequest(
  value: ApprovalInspectionRequest,
): Readonly<ApprovalInspectionRequest> {
  exactObject(
    value,
    [
      'projectId',
      'approvalRequestId',
      'auditEventId',
      'requestId',
      'principal',
    ],
    'request',
  );
  if (
    typeof value.auditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.auditEventId)
  ) {
    throw new ApprovalInspectionRequestError('auditEventId is invalid');
  }
  return Object.freeze({
    projectId: identifier(value.projectId, 'projectId'),
    approvalRequestId: identifier(
      value.approvalRequestId,
      'approvalRequestId',
    ),
    auditEventId: value.auditEventId,
    requestId: identifier(value.requestId, 'requestId'),
    principal: value.principal,
  });
}

export function createApprovalInspectionService(
  options: ApprovalInspectionServiceOptions,
): Readonly<ApprovalInspectionService> {
  exactObject(
    options,
    [
      'source',
      'policy',
      'audit',
      ...(options?.confirmAuthorization === undefined
        ? []
        : ['confirmAuthorization']),
      ...(options?.now === undefined ? [] : ['now']),
    ],
    'options',
  );
  if (
    typeof options.source?.getApprovalRequestDetail !== 'function' ||
    typeof options.policy?.authorize !== 'function' ||
    typeof options.audit?.record !== 'function' ||
    (options.confirmAuthorization !== undefined &&
      typeof options.confirmAuthorization !== 'function') ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new ApprovalInspectionRequestError('options are invalid');
  }
  const now = options.now ?? Date.now;
  return Object.freeze({
    async inspect(requestValue: ApprovalInspectionRequest) {
      const request = normalizedRequest(requestValue);
      const occurredAtMs = observedTime(now);
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(request.principal, occurredAtMs);
      } catch {
        throw new ApprovalInspectionAuthorizationError();
      }
      if (
        principal.subject.type !== 'user' ||
        !STRONG_HUMAN_ASSURANCES.has(principal.assurance)
      ) {
        throw new ApprovalInspectionAuthorizationError();
      }
      let approvalRead;
      let artifactRead;
      try {
        [approvalRead, artifactRead] = await Promise.all([
          options.policy.authorize(
            principal,
            request.projectId,
            'approval.read',
          ),
          options.policy.authorize(
            principal,
            request.projectId,
            'artifact.read',
          ),
        ]);
      } catch (error) {
        throw new ApprovalInspectionUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (
        approvalRead.effect !== 'allow' ||
        approvalRead.fence === null ||
        artifactRead.effect !== 'allow' ||
        artifactRead.fence === null ||
        !sameFence(approvalRead.fence, artifactRead.fence)
      ) {
        throw new ApprovalInspectionAuthorizationError();
      }
      await options.confirmAuthorization?.();
      let detail: Readonly<ApprovalRequestDetail> | null;
      try {
        const found = await options.source.getApprovalRequestDetail({
          projectId: request.projectId,
          requestId: request.approvalRequestId,
        });
        if (!found) {
          detail = null;
        } else {
          const approval = normalizeApprovalRequestRecord(found.request);
          if (
            approval.projectId !== request.projectId ||
            approval.id !== request.approvalRequestId
          ) {
            throw new ApprovalInspectionUnavailableError();
          }
          detail = Object.freeze({
            request: approval,
            preview: found.preview
              ? normalizeApprovalDetailPreview(found.preview)
              : null,
          });
        }
      } catch (error) {
        if (error instanceof ApprovalInspectionUnavailableError) throw error;
        throw new ApprovalInspectionUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      try {
        await options.audit.record({
          eventId: request.auditEventId,
          requestId: request.requestId,
          operationId: 'approval.inspect',
          projectId: request.projectId,
          subject: principal.subject,
          authenticationId: principal.authenticationId,
          outcome: 'allowed',
          reasons: Object.freeze(['human_approval_inspection']),
          fence: approvalRead.fence,
          occurredAtMs,
        });
      } catch (error) {
        throw new ApprovalInspectionUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      return detail;
    },
  });
}
