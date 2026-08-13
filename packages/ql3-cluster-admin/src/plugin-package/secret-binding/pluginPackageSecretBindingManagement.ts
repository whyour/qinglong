// Cluster Plugin Package Secret binding management boundary.
import {
  PostgresApprovalRequestRepository,
  PostgresPluginPackageSecretBindingApprovalPlanRepository,
  PostgresProjectPolicyRepository,
} from '@qinglong/cluster-postgres/package-manager';
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  createApprovalRequest,
  normalizeApprovalRequestRecord,
  type ApprovalRequestRecord,
  type CreateApprovalRequestResult,
  type DecideApprovalRequestResult,
} from '@qinglong/runtime-core/approved-action';
import {
  PluginPackageManagementAuthorizationError,
  PluginPackageManagementConflictError,
  PluginPackageManagementRequestError,
  PluginPackageManagementUnavailableError,
} from '@qinglong/runtime-core/plugin-package-management';
import { createPluginPackageResourceGenerationFromReferences } from '@qinglong/runtime-core/plugin-package-resource-generation';
import type { PluginPackageSecretBindingAssignment } from '@qinglong/runtime-core/plugin-package-secret-binding';
import {
  MAX_PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_LIFETIME_MS,
  PluginPackageSecretBindingApprovalPlanConflictError,
  PluginPackageSecretBindingApprovalPlanUnavailableError,
  createPluginPackageSecretBindingApprovalPlan,
  normalizePluginPackageSecretBindingApprovalPlan,
  pluginPackageSecretBindingApprovedAction,
  type CreatePluginPackageSecretBindingApprovalPlanResult,
  type PluginPackageSecretBindingApprovalPlan,
} from '@qinglong/runtime-core/plugin-package-secret-binding-approval-plan';
import { createPluginPackageSecretBindingPlan } from '@qinglong/runtime-core/plugin-package-secret-binding-plan';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
  type SecurityPrincipal,
  type SecuritySubject,
} from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

const DEFAULT_APPROVAL_LIFETIME_MS = 15 * 60 * 1000;
const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export interface PlanClusterPluginPackageSecretBindingRequest {
  readonly actionRef: string;
  readonly projectId: string;
  readonly packageName: string;
  readonly assignments: readonly Readonly<PluginPackageSecretBindingAssignment>[];
  readonly principal: SecurityPrincipal;
}

export interface ProposeClusterPluginPackageSecretBindingRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly approvalAuditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface ProposeClusterPluginPackageSecretBindingResult {
  readonly plan: Readonly<PluginPackageSecretBindingApprovalPlan>;
  readonly approvalStatus: CreateApprovalRequestResult['status'];
  readonly approvalRequest: Readonly<ApprovalRequestRecord>;
}

export interface DecideClusterPluginPackageSecretBindingRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly expectedVersion: number;
  readonly decisionId: string;
  readonly auditEventId: string;
  readonly decision: 'approved' | 'rejected';
  readonly reasonCode: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectClusterPluginPackageSecretBindingRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly inspectionId: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectClusterPluginPackageSecretBindingResult {
  readonly plan: Readonly<PluginPackageSecretBindingApprovalPlan> | null;
  readonly approvalRequest: Readonly<ApprovalRequestRecord> | null;
  readonly stale: boolean;
}

export interface ClusterPluginPackageSecretBindingManagementService {
  plan(
    request: PlanClusterPluginPackageSecretBindingRequest,
  ): Promise<Readonly<CreatePluginPackageSecretBindingApprovalPlanResult>>;
  propose(
    request: ProposeClusterPluginPackageSecretBindingRequest,
  ): Promise<Readonly<ProposeClusterPluginPackageSecretBindingResult>>;
  decide(
    request: DecideClusterPluginPackageSecretBindingRequest,
  ): Promise<Readonly<DecideApprovalRequestResult>>;
  inspectAuthorized(
    request: InspectClusterPluginPackageSecretBindingRequest,
  ): Promise<Readonly<InspectClusterPluginPackageSecretBindingResult>>;
}

export interface ClusterPluginPackageSecretBindingManagementOptions {
  readonly pool: PostgresPool;
  readonly now?: () => number;
  readonly planLifetimeMs?: number;
  readonly approvalLifetimeMs?: number;
}

function exact(value: unknown, keys: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginPackageManagementRequestError(`${label} is invalid`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new PluginPackageManagementRequestError(`${label} shape is invalid`);
  }
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

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function assignmentsMatch(
  assignments: readonly Readonly<PluginPackageSecretBindingAssignment>[],
  plan: Readonly<PluginPackageSecretBindingApprovalPlan>,
): boolean {
  if (
    !Array.isArray(assignments) ||
    assignments.length !== plan.bindingPlan.entries.length
  ) {
    return false;
  }
  const mapped = new Map<string, string | null>();
  for (const value of assignments) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== 'name\0secretRef' ||
      typeof value.name !== 'string' ||
      (value.secretRef !== null && typeof value.secretRef !== 'string') ||
      mapped.has(value.name)
    ) {
      return false;
    }
    mapped.set(value.name, value.secretRef);
  }
  return plan.bindingPlan.entries.every(
    (entry) => mapped.get(entry.name) === entry.secretRef,
  );
}

function audit(
  eventId: string,
  requestId: string,
  operationId: 'approval.request' | 'approval.decide',
  projectId: string,
  principal: Readonly<SecurityPrincipal>,
  outcome: 'allowed' | 'approval_required',
  fence: Readonly<SecurityPolicyFence>,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  return Object.freeze({
    eventId,
    requestId,
    operationId,
    projectId,
    subject: principal.subject,
    authenticationId: principal.authenticationId,
    outcome,
    reasons: Object.freeze(['package_secret_binding_review']),
    fence,
    occurredAtMs,
  });
}

export function createClusterPluginPackageSecretBindingManagementService(
  options: ClusterPluginPackageSecretBindingManagementOptions,
): Readonly<ClusterPluginPackageSecretBindingManagementService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        key !== 'pool' &&
        key !== 'now' &&
        key !== 'planLifetimeMs' &&
        key !== 'approvalLifetimeMs',
    ) ||
    !options.pool ||
    typeof options.pool.query !== 'function' ||
    typeof options.pool.connect !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new TypeError(
      'cluster Plugin Package Secret binding management options are invalid',
    );
  }
  const planLifetimeMs =
    options.planLifetimeMs ??
    MAX_PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_LIFETIME_MS;
  const approvalLifetimeMs =
    options.approvalLifetimeMs ?? DEFAULT_APPROVAL_LIFETIME_MS;
  for (const [value, label] of [
    [planLifetimeMs, 'plan'],
    [approvalLifetimeMs, 'approval'],
  ] as const) {
    if (
      !Number.isSafeInteger(value) ||
      value < 1_000 ||
      value > MAX_PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_LIFETIME_MS
    ) {
      throw new TypeError(
        `cluster Plugin Package Secret binding ${label} lifetime is invalid`,
      );
    }
  }
  const now = options.now ?? Date.now;
  const plans = new PostgresPluginPackageSecretBindingApprovalPlanRepository(
    options.pool,
  );
  const approvals = new PostgresApprovalRequestRepository(options.pool);
  const policy = new ProjectPolicyEngine(
    new PostgresProjectPolicyRepository(options.pool),
  );

  const authorize = async (
    principalValue: SecurityPrincipal,
    projectId: string,
    permission: 'secret.manage' | 'approval.decide',
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
  ): Promise<Readonly<PluginPackageSecretBindingApprovalPlan>> => {
    let value;
    try {
      value = await plans.findByActionRef(actionRef(requestedActionRef));
    } catch (error) {
      throw new PluginPackageManagementUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (!value) {
      throw new PluginPackageManagementConflictError(
        'Secret binding plan does not exist',
      );
    }
    return normalizePluginPackageSecretBindingApprovalPlan(value);
  };

  return Object.freeze({
    async plan(request: PlanClusterPluginPackageSecretBindingRequest) {
      exact(
        request,
        ['actionRef', 'assignments', 'packageName', 'principal', 'projectId'],
        'Secret binding plan request',
      );
      const projectId = identifier(request.projectId, 'projectId');
      if (
        typeof request.packageName !== 'string' ||
        !PACKAGE_NAME_PATTERN.test(request.packageName)
      ) {
        throw new PluginPackageManagementRequestError('packageName is invalid');
      }
      if (!Array.isArray(request.assignments)) {
        throw new PluginPackageManagementRequestError('assignments are invalid');
      }
      const authorization = await authorize(
        request.principal,
        projectId,
        'secret.manage',
        currentTime(now),
      );
      const requestedActionRef = actionRef(request.actionRef);
      let existingValue;
      try {
        existingValue = await plans.findByActionRef(requestedActionRef);
      } catch (error) {
        throw new PluginPackageManagementUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (existingValue) {
        const existing = normalizePluginPackageSecretBindingApprovalPlan(
          existingValue,
        );
        if (
          existing.bindingPlan.target.projectId !== projectId ||
          existing.bindingPlan.target.packageName !== request.packageName ||
          !sameSubject(existing.requestedBy, authorization.principal.subject) ||
          existing.expiresAtMs - existing.bindingPlan.plannedAtMs !==
            planLifetimeMs ||
          !assignmentsMatch(request.assignments, existing)
        ) {
          throw new PluginPackageManagementConflictError(
            'Secret binding actionRef is bound to another request',
          );
        }
        return Object.freeze({ status: 'existing' as const, plan: existing });
      }
      let snapshot;
      try {
        snapshot = await plans.loadPlanningSnapshot(
          projectId,
          request.packageName,
        );
      } catch (error) {
        throw new PluginPackageManagementUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (!snapshot) {
        throw new PluginPackageManagementConflictError(
          'current active unbound Package generation does not exist',
        );
      }
      const generation = createPluginPackageResourceGenerationFromReferences({
        installationId: snapshot.record.installationId,
        projectId: snapshot.record.projectId,
        packageName: snapshot.record.packageName,
        lockDigest: snapshot.record.lockDigest,
        generation: snapshot.record.targetGeneration,
        previousActiveLockDigest: snapshot.record.previousActiveLockDigest,
        contentDigest: snapshot.lock.source.contentDigest,
        resources: snapshot.lock.resources,
      });
      let plan;
      try {
        const bindingPlan = createPluginPackageSecretBindingPlan({
          generation,
          manifest: snapshot.proposal.actionInput.manifest,
          assignments: request.assignments,
          plannedAtMs: snapshot.observedAtMs,
        });
        plan = createPluginPackageSecretBindingApprovalPlan({
          actionRef: requestedActionRef,
          bindingPlan,
          requestedBy: authorization.principal.subject,
          expiresAtMs: snapshot.observedAtMs + planLifetimeMs,
        });
        return await plans.create(plan);
      } catch (error) {
        if (error instanceof PluginPackageSecretBindingApprovalPlanConflictError) {
          throw new PluginPackageManagementConflictError(
            'Secret binding actionRef or generation is already bound',
          );
        }
        if (error instanceof PluginPackageSecretBindingApprovalPlanUnavailableError) {
          throw new PluginPackageManagementUnavailableError({ cause: error });
        }
        if (error instanceof TypeError) {
          throw new PluginPackageManagementRequestError(
            'Secret binding assignments are invalid',
          );
        }
        throw error;
      }
    },

    async propose(request: ProposeClusterPluginPackageSecretBindingRequest) {
      exact(
        request,
        ['actionRef', 'approvalAuditEventId', 'approvalRequestId', 'principal'],
        'Secret binding proposal request',
      );
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
          'Secret binding plan expired',
        );
      }
      const authorization = await authorize(
        request.principal,
        plan.bindingPlan.target.projectId,
        'secret.manage',
        observedAtMs,
      );
      if (!sameSubject(plan.requestedBy, authorization.principal.subject)) {
        throw new PluginPackageManagementAuthorizationError();
      }
      const binding = pluginPackageSecretBindingApprovedAction(plan);
      const existing = await approvals.findById(approvalRequestId);
      if (existing) {
        const normalized = normalizeApprovalRequestRecord(existing);
        if (
          normalized.projectId !== plan.bindingPlan.target.projectId ||
          normalized.decisionMode !== 'separation_of_duty' ||
          !sameSubject(normalized.requestedBy, plan.requestedBy) ||
          !same(normalized.action, binding)
        ) {
          throw new PluginPackageManagementConflictError(
            'Approval request is bound to another Secret binding plan',
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
          'Secret binding plan has no approval lifetime',
        );
      }
      const result = await approvals.create({
        request: createApprovalRequest({
          id: approvalRequestId,
          projectId: plan.bindingPlan.target.projectId,
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
          plan.bindingPlan.target.projectId,
          authorization.principal,
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

    async decide(request: DecideClusterPluginPackageSecretBindingRequest) {
      exact(
        request,
        [
          'actionRef',
          'approvalRequestId',
          'auditEventId',
          'decision',
          'decisionId',
          'expectedVersion',
          'principal',
          'reasonCode',
        ],
        'Secret binding decision request',
      );
      if (
        (request.decision !== 'approved' && request.decision !== 'rejected') ||
        typeof request.reasonCode !== 'string' ||
        !REASON_PATTERN.test(request.reasonCode) ||
        !Number.isSafeInteger(request.expectedVersion) ||
        request.expectedVersion < 1
      ) {
        throw new PluginPackageManagementRequestError(
          'Secret binding decision tuple is invalid',
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
      if (!same(approval.action, pluginPackageSecretBindingApprovedAction(plan))) {
        throw new PluginPackageManagementConflictError(
          'Approval request does not match Secret binding plan',
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
        return Object.freeze({ status: 'existing' as const, request: approval });
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
          authorization.principal,
          'allowed',
          authorization.fence,
          observedAtMs,
        ),
      });
    },

    async inspectAuthorized(
      request: InspectClusterPluginPackageSecretBindingRequest,
    ) {
      exact(
        request,
        ['actionRef', 'approvalRequestId', 'inspectionId', 'principal'],
        'Secret binding inspection request',
      );
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
          'Secret binding review state does not exist',
        );
      }
      const plan = planValue
        ? normalizePluginPackageSecretBindingApprovalPlan(planValue)
        : null;
      const approval = approvalValue
        ? normalizeApprovalRequestRecord(approvalValue)
        : null;
      const projectId =
        plan?.bindingPlan.target.projectId ?? approval?.projectId;
      if (!projectId) throw new PluginPackageManagementUnavailableError();
      const observedAtMs = currentTime(now);
      try {
        await authorize(request.principal, projectId, 'secret.manage', observedAtMs);
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
          !same(approval.action, pluginPackageSecretBindingApprovedAction(plan)) ||
          observedAtMs > plan.expiresAtMs,
      });
    },
  });
}
