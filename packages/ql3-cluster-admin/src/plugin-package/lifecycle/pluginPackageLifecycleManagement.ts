// Cluster Plugin Package lifecycle boundary; keep approval management authority explicit.
import { PostgresApprovalRequestRepository } from '@qinglong/cluster-postgres/approved-action';
import { PostgresPluginPackageLifecyclePlanReader } from '@qinglong/cluster-postgres/package-manager';
import { PostgresProjectPolicyRepository } from '@qinglong/cluster-postgres/project-policy';
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  createApprovalRequest,
  normalizeApprovalRequestRecord,
  type ApprovalRequestRecord,
  type CreateApprovalRequestResult,
  type DecideApprovalRequestResult,
} from '@qinglong/runtime-core/approved-action';
import { pluginPackageLifecycleActionDigest } from '@qinglong/runtime-core/plugin-package-lifecycle';
import {
  normalizePluginPackageLifecyclePlan,
  type PluginPackageLifecyclePlan,
} from '@qinglong/runtime-core/plugin-package-lifecycle-plan';
import {
  PluginPackageManagementAuthorizationError,
  PluginPackageManagementConflictError,
  PluginPackageManagementRequestError,
  PluginPackageManagementUnavailableError,
} from '@qinglong/runtime-core/plugin-package-management';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
  type SecurityPrincipal,
  type SecuritySubject,
} from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

const DEFAULT_APPROVAL_LIFETIME_MS = 15 * 60 * 1000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export interface ClusterPluginPackageLifecycleManagementOptions {
  readonly pool: PostgresPool;
  readonly now?: () => number;
  readonly approvalLifetimeMs?: number;
}

export interface ProposeClusterPluginPackageLifecycleRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly approvalAuditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface ProposeClusterPluginPackageLifecycleResult {
  readonly plan: Readonly<PluginPackageLifecyclePlan>;
  readonly approvalStatus: CreateApprovalRequestResult['status'];
  readonly approvalRequest: Readonly<ApprovalRequestRecord>;
}

export interface DecideClusterPluginPackageLifecycleRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly expectedVersion: number;
  readonly decisionId: string;
  readonly auditEventId: string;
  readonly decision: 'approved' | 'rejected';
  readonly reasonCode: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectClusterPluginPackageLifecycleRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly inspectionId: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectClusterPluginPackageLifecycleResult {
  readonly plan: Readonly<PluginPackageLifecyclePlan> | null;
  readonly approvalRequest: Readonly<ApprovalRequestRecord> | null;
  readonly stale: boolean;
}

export interface ClusterPluginPackageLifecycleManagementService {
  propose(
    request: ProposeClusterPluginPackageLifecycleRequest,
  ): Promise<Readonly<ProposeClusterPluginPackageLifecycleResult>>;
  decide(
    request: DecideClusterPluginPackageLifecycleRequest,
  ): Promise<Readonly<DecideApprovalRequestResult>>;
  inspectAuthorized(
    request: InspectClusterPluginPackageLifecycleRequest,
  ): Promise<Readonly<InspectClusterPluginPackageLifecycleResult>>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new PluginPackageManagementRequestError(`${label} is invalid`);
  }
  return value;
}

function actionRef(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    throw new PluginPackageManagementRequestError('actionRef is invalid');
  }
  return value;
}

function currentTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PluginPackageManagementUnavailableError();
  }
  return value;
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function action(plan: Readonly<PluginPackageLifecyclePlan>) {
  return Object.freeze({
    permission: 'package.manage' as const,
    actionType: `plugin_package.lifecycle.${plan.impact.action}`,
    actionRef: plan.actionRef,
    actionDigest: pluginPackageLifecycleActionDigest(plan.impact),
    previewDigest: plan.impact.impactDigest,
  });
}

function audit(
  eventId: string,
  requestId: string,
  operationId: 'approval.request' | 'approval.decide',
  projectId: string,
  subject: Readonly<SecuritySubject>,
  authenticationId: string,
  outcome: 'allowed' | 'approval_required',
  fence: Readonly<SecurityPolicyFence>,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  return Object.freeze({
    eventId,
    requestId,
    operationId,
    projectId,
    subject,
    authenticationId,
    outcome,
    reasons: Object.freeze(['package_lifecycle_review']),
    fence,
    occurredAtMs,
  });
}

export function createClusterPluginPackageLifecycleManagementService(
  options: ClusterPluginPackageLifecycleManagementOptions,
): Readonly<ClusterPluginPackageLifecycleManagementService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        key !== 'pool' &&
        key !== 'now' &&
        key !== 'approvalLifetimeMs',
    ) ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new TypeError(
      'Cluster Plugin Package lifecycle management options are invalid',
    );
  }
  const approvalLifetimeMs =
    options.approvalLifetimeMs ?? DEFAULT_APPROVAL_LIFETIME_MS;
  if (
    !Number.isSafeInteger(approvalLifetimeMs) ||
    approvalLifetimeMs < 1_000 ||
    approvalLifetimeMs > DEFAULT_APPROVAL_LIFETIME_MS
  ) {
    throw new TypeError(
      'Cluster Plugin Package lifecycle approval lifetime is invalid',
    );
  }
  const now = options.now ?? Date.now;
  const plans = new PostgresPluginPackageLifecyclePlanReader(options.pool);
  const approvals = new PostgresApprovalRequestRepository(options.pool);
  const policy = new ProjectPolicyEngine(
    new PostgresProjectPolicyRepository(options.pool),
  );

  const authorize = async (
    principalValue: SecurityPrincipal,
    projectId: string,
    permission: 'package.manage' | 'approval.decide',
    observedAtMs: number,
  ): Promise<
    Readonly<{
      principal: Readonly<SecurityPrincipal>;
      fence: Readonly<SecurityPolicyFence>;
    }>
  > => {
    let principal;
    try {
      principal = normalizeSecurityPrincipal(principalValue, observedAtMs);
    } catch {
      throw new PluginPackageManagementAuthorizationError();
    }
    if (
      principal.subject.type !== 'user' ||
      (principal.assurance !== 'multi_factor' &&
        principal.assurance !== 'hardware')
    ) {
      throw new PluginPackageManagementAuthorizationError();
    }
    let decision;
    try {
      decision = await policy.authorize(principal, projectId, permission);
    } catch (error) {
      throw new PluginPackageManagementUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (decision.effect !== 'allow' || decision.fence === null) {
      throw new PluginPackageManagementAuthorizationError();
    }
    return Object.freeze({ principal, fence: decision.fence });
  };

  const loadPlan = async (
    requestedActionRef: string,
  ): Promise<Readonly<PluginPackageLifecyclePlan>> => {
    let plan;
    try {
      plan = await plans.findByActionRef(actionRef(requestedActionRef));
    } catch (error) {
      throw new PluginPackageManagementUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (!plan) {
      throw new PluginPackageManagementConflictError(
        'Plugin Package lifecycle plan does not exist',
      );
    }
    return normalizePluginPackageLifecyclePlan(plan);
  };

  return Object.freeze({
    async propose(request: ProposeClusterPluginPackageLifecycleRequest) {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        Object.keys(request).sort().join('\0') !==
          [
            'actionRef',
            'approvalAuditEventId',
            'approvalRequestId',
            'principal',
          ]
            .sort()
            .join('\0')
      ) {
        throw new PluginPackageManagementRequestError(
          'lifecycle proposal request is invalid',
        );
      }
      const approvalRequestId = identifier(
        request.approvalRequestId,
        'approvalRequestId',
      );
      const approvalAuditEventId = identifier(
        request.approvalAuditEventId,
        'approvalAuditEventId',
      );
      const plan = await loadPlan(request.actionRef);
      const observedAtMs = currentTime(now);
      if (observedAtMs > plan.expiresAtMs) {
        throw new PluginPackageManagementConflictError(
          'Plugin Package lifecycle plan expired',
        );
      }
      const authorization = await authorize(
        request.principal,
        plan.impact.target.projectId,
        'package.manage',
        observedAtMs,
      );
      if (!sameSubject(plan.requestedBy, authorization.principal.subject)) {
        throw new PluginPackageManagementAuthorizationError();
      }
      const binding = action(plan);
      const existing = await approvals.findById(approvalRequestId);
      if (existing) {
        const normalized = normalizeApprovalRequestRecord(existing);
        if (
          normalized.projectId !== plan.impact.target.projectId ||
          normalized.decisionMode !== 'separation_of_duty' ||
          !sameSubject(normalized.requestedBy, plan.requestedBy) ||
          JSON.stringify(normalized.action) !== JSON.stringify(binding)
        ) {
          throw new PluginPackageManagementConflictError(
            'Approval request is bound to another lifecycle plan',
          );
        }
        return Object.freeze({
          plan,
          approvalStatus: 'existing' as const,
          approvalRequest: normalized,
        });
      }
      const expiresAtMs = Math.min(
        observedAtMs + approvalLifetimeMs,
        plan.expiresAtMs,
      );
      if (expiresAtMs <= observedAtMs) {
        throw new PluginPackageManagementConflictError(
          'Plugin Package lifecycle plan has no approval lifetime',
        );
      }
      const result = await approvals.create({
        request: createApprovalRequest({
          id: approvalRequestId,
          projectId: plan.impact.target.projectId,
          action: binding,
          risk: 'high',
          decisionMode: 'separation_of_duty',
          requestedBy: authorization.principal.subject,
          requestedAtMs: observedAtMs,
          expiresAtMs,
          requestFence: authorization.fence,
        }),
        audit: audit(
          approvalAuditEventId,
          approvalRequestId,
          'approval.request',
          plan.impact.target.projectId,
          authorization.principal.subject,
          authorization.principal.authenticationId,
          'approval_required',
          authorization.fence,
          observedAtMs,
        ),
      });
      return Object.freeze({
        plan,
        approvalStatus: result.status,
        approvalRequest: result.request,
      });
    },

    async decide(request: DecideClusterPluginPackageLifecycleRequest) {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        Object.keys(request).sort().join('\0') !==
          [
            'actionRef',
            'approvalRequestId',
            'auditEventId',
            'decision',
            'decisionId',
            'expectedVersion',
            'principal',
            'reasonCode',
          ]
            .sort()
            .join('\0') ||
        (request.decision !== 'approved' &&
          request.decision !== 'rejected') ||
        typeof request.reasonCode !== 'string' ||
        !REASON_PATTERN.test(request.reasonCode) ||
        !Number.isSafeInteger(request.expectedVersion) ||
        request.expectedVersion < 1
      ) {
        throw new PluginPackageManagementRequestError(
          'lifecycle decision request is invalid',
        );
      }
      const plan = await loadPlan(request.actionRef);
      const approvalRequestId = identifier(
        request.approvalRequestId,
        'approvalRequestId',
      );
      const decisionId = identifier(request.decisionId, 'decisionId');
      const auditEventId = identifier(request.auditEventId, 'auditEventId');
      const current = await approvals.findById(approvalRequestId);
      if (!current) {
        throw new PluginPackageManagementConflictError(
          'Approval request does not exist',
        );
      }
      const approval = normalizeApprovalRequestRecord(current);
      if (
        approval.action.actionRef !== plan.actionRef ||
        JSON.stringify(approval.action) !== JSON.stringify(action(plan))
      ) {
        throw new PluginPackageManagementConflictError(
          'Approval request does not match lifecycle plan',
        );
      }
      const observedAtMs = currentTime(now);
      const authorization = await authorize(
        request.principal,
        approval.projectId,
        'approval.decide',
        observedAtMs,
      );
      if (
        approval.decisionId === decisionId &&
        approval.decision === request.decision &&
        approval.decisionReasonCode === request.reasonCode &&
        approval.decidedBy &&
        sameSubject(approval.decidedBy, authorization.principal.subject)
      ) {
        return Object.freeze({
          status: 'existing' as const,
          request: approval,
        });
      }
      return approvals.decide({
        requestId: approvalRequestId,
        expectedVersion: request.expectedVersion,
        decisionId,
        decision: request.decision,
        reasonCode: request.reasonCode,
        principal: authorization.principal,
        decidedAtMs: observedAtMs,
        authorizationFence: authorization.fence,
        audit: audit(
          auditEventId,
          approvalRequestId,
          'approval.decide',
          approval.projectId,
          authorization.principal.subject,
          authorization.principal.authenticationId,
          'allowed',
          authorization.fence,
          observedAtMs,
        ),
      });
    },

    async inspectAuthorized(
      request: InspectClusterPluginPackageLifecycleRequest,
    ) {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        Object.keys(request).sort().join('\0') !==
          [
            'actionRef',
            'approvalRequestId',
            'inspectionId',
            'principal',
          ]
            .sort()
            .join('\0')
      ) {
        throw new PluginPackageManagementRequestError(
          'lifecycle inspection request is invalid',
        );
      }
      identifier(request.inspectionId, 'inspectionId');
      const requestedActionRef = actionRef(request.actionRef);
      const approvalRequestId = identifier(
        request.approvalRequestId,
        'approvalRequestId',
      );
      const [planValue, approvalValue] = await Promise.all([
        plans.findByActionRef(requestedActionRef),
        approvals.findById(approvalRequestId),
      ]);
      if (!planValue && !approvalValue) {
        throw new PluginPackageManagementConflictError(
          'Plugin Package lifecycle state does not exist',
        );
      }
      const plan = planValue
        ? normalizePluginPackageLifecyclePlan(planValue)
        : null;
      const approval = approvalValue
        ? normalizeApprovalRequestRecord(approvalValue)
        : null;
      const projectId = plan?.impact.target.projectId ?? approval?.projectId;
      if (!projectId) {
        throw new PluginPackageManagementUnavailableError();
      }
      const observedAtMs = currentTime(now);
      try {
        await authorize(
          request.principal,
          projectId,
          'package.manage',
          observedAtMs,
        );
      } catch (error) {
        if (!(error instanceof PluginPackageManagementAuthorizationError)) {
          throw error;
        }
        await authorize(
          request.principal,
          projectId,
          'approval.decide',
          observedAtMs,
        );
      }
      return Object.freeze({
        plan,
        approvalRequest: approval,
        stale:
          plan === null ||
          approval === null ||
          approval.action.actionRef !== plan.actionRef ||
          JSON.stringify(approval.action) !== JSON.stringify(action(plan)) ||
          observedAtMs > plan.expiresAtMs,
      });
    },
  });
}
