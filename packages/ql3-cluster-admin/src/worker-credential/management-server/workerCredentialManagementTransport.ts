/** Authenticated Worker credential management transport boundary. */
import type { ApprovalRequestRecord } from '@qinglong/runtime-core/approved-action';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import type {
  CreateWorkerCredentialManagementPlanResult,
  WorkerCredentialManagementPlan,
} from '@qinglong/runtime-core/worker-credential-management-plan';
import type {
  ClusterWorkerCredentialManagementService,
  ProposeClusterWorkerCredentialResult,
} from './workerCredentialManagement';

const STRONG_CLUSTER_ASSURANCES = new Set(['multi_factor', 'hardware']);

export interface ClusterWorkerCredentialManagementAuthentication {
  authenticate(): Promise<Readonly<SecurityPrincipal> | null>;
}

export interface PlanClusterWorkerCredentialCommand {
  readonly schemaVersion: 1;
  readonly operation: 'worker-credential.plan';
  readonly request: {
    readonly actionRef: string;
    readonly authorityProjectId: string;
    readonly action: 'issue' | 'rotate';
    readonly deliveryId: string;
    readonly workerId: string;
    readonly credentialId: string;
    readonly previousCredentialId: string | null;
    readonly credentialNotBeforeAtMs: number;
    readonly credentialExpiresAtMs: number;
    readonly deploymentTargetDigest: string;
    readonly deploymentGeneration: string;
  };
}

export interface ProposeClusterWorkerCredentialCommand {
  readonly schemaVersion: 1;
  readonly operation: 'worker-credential.propose';
  readonly request: {
    readonly actionRef: string;
    readonly authorityProjectId: string;
    readonly approvalRequestId: string;
    readonly approvalAuditEventId: string;
  };
}

export interface DecideClusterWorkerCredentialCommand {
  readonly schemaVersion: 1;
  readonly operation: 'worker-credential.decide';
  readonly request: {
    readonly actionRef: string;
    readonly authorityProjectId: string;
    readonly approvalRequestId: string;
    readonly expectedVersion: number;
    readonly decisionId: string;
    readonly auditEventId: string;
    readonly decision: 'approved' | 'rejected';
    readonly reasonCode: string;
  };
}

export interface InspectClusterWorkerCredentialCommand {
  readonly schemaVersion: 1;
  readonly operation: 'worker-credential.inspect';
  readonly request: {
    readonly actionRef: string;
    readonly authorityProjectId: string;
    readonly approvalRequestId: string;
    readonly inspectionId: string;
  };
}

export type ClusterWorkerCredentialManagementCommand =
  | PlanClusterWorkerCredentialCommand
  | ProposeClusterWorkerCredentialCommand
  | DecideClusterWorkerCredentialCommand
  | InspectClusterWorkerCredentialCommand;

type PlanSummary = ReturnType<typeof planSummary>;
type ApprovalSummary = ReturnType<typeof approvalSummary>;

export type ClusterWorkerCredentialManagementTransportResult =
  | Readonly<{
      schemaVersion: 1;
      operation: 'worker-credential.plan';
      status: 'created' | 'existing';
      plan: PlanSummary;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'worker-credential.propose';
      approvalStatus: 'created' | 'existing';
      plan: PlanSummary;
      approval: ApprovalSummary;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'worker-credential.decide';
      status: 'decided' | 'existing';
      approval: ApprovalSummary;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'worker-credential.inspect';
      plan: PlanSummary | null;
      approval: ApprovalSummary | null;
      stale: boolean;
    }>;

export interface ClusterWorkerCredentialManagementTransport {
  execute(
    command: unknown,
    authentication: ClusterWorkerCredentialManagementAuthentication,
  ): Promise<Readonly<ClusterWorkerCredentialManagementTransportResult>>;
}

export interface ClusterWorkerCredentialManagementTransportOptions {
  readonly service: ClusterWorkerCredentialManagementService;
  readonly now?: () => number;
}

export class ClusterWorkerCredentialManagementTransportConfigurationError extends TypeError {
  readonly code = 'CLUSTER_WORKER_CREDENTIAL_TRANSPORT_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(
      `Cluster Worker credential transport configuration is invalid: ${message}`,
    );
    this.name = 'ClusterWorkerCredentialManagementTransportConfigurationError';
  }
}

export class ClusterWorkerCredentialManagementTransportRequestError extends TypeError {
  readonly code = 'CLUSTER_WORKER_CREDENTIAL_TRANSPORT_REQUEST_INVALID';

  constructor(message: string) {
    super(`Cluster Worker credential transport request is invalid: ${message}`);
    this.name = 'ClusterWorkerCredentialManagementTransportRequestError';
  }
}

export class ClusterWorkerCredentialManagementTransportAuthenticationError extends Error {
  readonly code = 'CLUSTER_WORKER_CREDENTIAL_TRANSPORT_AUTHENTICATION_REQUIRED';

  constructor() {
    super(
      'Cluster Worker credential transport requires a strong User principal',
    );
    this.name = 'ClusterWorkerCredentialManagementTransportAuthenticationError';
  }
}

export class ClusterWorkerCredentialManagementTransportUnavailableError extends Error {
  readonly code = 'CLUSTER_WORKER_CREDENTIAL_TRANSPORT_UNAVAILABLE';

  constructor(readonly cause?: unknown) {
    super('Cluster Worker credential transport is unavailable');
    this.name = 'ClusterWorkerCredentialManagementTransportUnavailableError';
  }
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterWorkerCredentialManagementTransportRequestError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ClusterWorkerCredentialManagementTransportRequestError(
      `${label} shape is invalid`,
    );
  }
}

export function normalizeClusterWorkerCredentialManagementCommand(
  value: unknown,
): Readonly<ClusterWorkerCredentialManagementCommand> {
  exactObject(value, ['schemaVersion', 'operation', 'request'], 'command');
  if (value.schemaVersion !== 1) {
    throw new ClusterWorkerCredentialManagementTransportRequestError(
      'schemaVersion is invalid',
    );
  }
  switch (value.operation) {
    case 'worker-credential.plan':
      exactObject(
        value.request,
        [
          'action',
          'actionRef',
          'authorityProjectId',
          'credentialExpiresAtMs',
          'credentialId',
          'credentialNotBeforeAtMs',
          'deliveryId',
          'deploymentGeneration',
          'deploymentTargetDigest',
          'previousCredentialId',
          'workerId',
        ],
        'plan request',
      );
      break;
    case 'worker-credential.propose':
      exactObject(
        value.request,
        [
          'actionRef',
          'authorityProjectId',
          'approvalRequestId',
          'approvalAuditEventId',
        ],
        'proposal request',
      );
      break;
    case 'worker-credential.decide':
      exactObject(
        value.request,
        [
          'actionRef',
          'authorityProjectId',
          'approvalRequestId',
          'expectedVersion',
          'decisionId',
          'auditEventId',
          'decision',
          'reasonCode',
        ],
        'decision request',
      );
      break;
    case 'worker-credential.inspect':
      exactObject(
        value.request,
        [
          'actionRef',
          'authorityProjectId',
          'approvalRequestId',
          'inspectionId',
        ],
        'inspection request',
      );
      break;
    default:
      throw new ClusterWorkerCredentialManagementTransportRequestError(
        'operation is not publicly available',
      );
  }
  return Object.freeze(
    value as unknown as ClusterWorkerCredentialManagementCommand,
  );
}

function planSummary(plan: Readonly<WorkerCredentialManagementPlan>) {
  return Object.freeze({
    actionRef: plan.actionRef,
    authorityProjectId: plan.authorityProjectId,
    action: plan.action,
    target: Object.freeze({ ...plan.target }),
    requestedBy: Object.freeze({ ...plan.requestedBy }),
    plannedAtMs: plan.plannedAtMs,
    expiresAtMs: plan.expiresAtMs,
    previewDigest: plan.previewDigest,
    planDigest: plan.planDigest,
  });
}

function approvalSummary(approval: Readonly<ApprovalRequestRecord>) {
  return Object.freeze({
    id: approval.id,
    projectId: approval.projectId,
    version: approval.version,
    state: approval.state,
    risk: approval.risk,
    decisionMode: approval.decisionMode,
    requestedBy: Object.freeze({ ...approval.requestedBy }),
    requestedAtMs: approval.requestedAtMs,
    expiresAtMs: approval.expiresAtMs,
    decision: approval.decision,
    decisionReasonCode: approval.decisionReasonCode,
    decidedBy: approval.decidedBy
      ? Object.freeze({ ...approval.decidedBy })
      : null,
    decidedAtMs: approval.decidedAtMs,
    dispatchId: approval.dispatchId,
    consumedAtMs: approval.consumedAtMs,
    actionType: approval.action.actionType,
    actionRef: approval.action.actionRef,
    actionDigest: approval.action.actionDigest,
    previewDigest: approval.action.previewDigest,
  });
}

export function createClusterWorkerCredentialManagementTransport(
  options: ClusterWorkerCredentialManagementTransportOptions,
): Readonly<ClusterWorkerCredentialManagementTransport> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'service' && key !== 'now') ||
    !options.service ||
    typeof options.service.plan !== 'function' ||
    typeof options.service.propose !== 'function' ||
    typeof options.service.decide !== 'function' ||
    typeof options.service.inspectAuthorized !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new ClusterWorkerCredentialManagementTransportConfigurationError(
      'options are invalid',
    );
  }
  const now = options.now ?? Date.now;

  return Object.freeze({
    async execute(
      commandValue: unknown,
      authentication: ClusterWorkerCredentialManagementAuthentication,
    ): Promise<Readonly<ClusterWorkerCredentialManagementTransportResult>> {
      const command =
        normalizeClusterWorkerCredentialManagementCommand(commandValue);
      if (
        !authentication ||
        typeof authentication !== 'object' ||
        Array.isArray(authentication) ||
        Object.keys(authentication).some((key) => key !== 'authenticate') ||
        typeof authentication.authenticate !== 'function'
      ) {
        throw new ClusterWorkerCredentialManagementTransportConfigurationError(
          'authentication authority is invalid',
        );
      }
      let candidate: Readonly<SecurityPrincipal> | null;
      try {
        candidate = await authentication.authenticate();
      } catch (error) {
        throw new ClusterWorkerCredentialManagementTransportUnavailableError(
          error,
        );
      }
      const observedAtMs = now();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
        throw new ClusterWorkerCredentialManagementTransportUnavailableError();
      }
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(
          candidate as SecurityPrincipal,
          observedAtMs,
        );
      } catch {
        throw new ClusterWorkerCredentialManagementTransportAuthenticationError();
      }
      if (
        principal.subject.type !== 'user' ||
        !STRONG_CLUSTER_ASSURANCES.has(principal.assurance)
      ) {
        throw new ClusterWorkerCredentialManagementTransportAuthenticationError();
      }

      switch (command.operation) {
        case 'worker-credential.plan': {
          const result: Readonly<CreateWorkerCredentialManagementPlanResult> =
            await options.service.plan({ ...command.request, principal });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            plan: planSummary(result.plan),
          });
        }
        case 'worker-credential.propose': {
          const result: Readonly<ProposeClusterWorkerCredentialResult> =
            await options.service.propose({ ...command.request, principal });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            approvalStatus: result.approvalStatus,
            plan: planSummary(result.plan),
            approval: approvalSummary(result.approvalRequest),
          });
        }
        case 'worker-credential.decide': {
          const result = await options.service.decide({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            approval: approvalSummary(result.request),
          });
        }
        case 'worker-credential.inspect': {
          const result = await options.service.inspectAuthorized({
            ...command.request,
            principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            plan: result.plan ? planSummary(result.plan) : null,
            approval: result.approvalRequest
              ? approvalSummary(result.approvalRequest)
              : null,
            stale: result.stale,
          });
        }
      }
    },
  });
}
