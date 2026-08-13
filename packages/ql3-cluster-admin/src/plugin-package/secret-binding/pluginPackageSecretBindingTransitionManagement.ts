import {
  PostgresApprovalRequestRepository,
  PostgresPluginPackageSecretBindingTransitionApprovalPlanRepository,
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
  PluginPackageManagementQuotaExceededError,
  PluginPackageManagementRequestError,
  PluginPackageManagementUnavailableError,
  type PluginPackageManagementQuotaOperation,
  type PluginPackageManagementQuotaPort,
} from '@qinglong/runtime-core/plugin-package-management';
import { createPluginPackageResourceGenerationFromReferences } from '@qinglong/runtime-core/plugin-package-resource-generation';
import {
  createPluginPackageSecretBindingTarget,
  type PluginPackageSecretBindingAssignment,
} from '@qinglong/runtime-core/plugin-package-secret-binding';
import { createPluginPackageSecretBindingTransitionPlan } from '@qinglong/runtime-core/plugin-package-secret-binding-transition-plan';
import {
  MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_LIFETIME_MS,
  PluginPackageSecretBindingTransitionApprovalPlanConflictError,
  PluginPackageSecretBindingTransitionApprovalPlanUnavailableError,
  createPluginPackageSecretBindingTransitionApprovalPlan,
  normalizePluginPackageSecretBindingTransitionApprovalPlan,
  pluginPackageSecretBindingTransitionApprovedAction,
  type CreatePluginPackageSecretBindingTransitionApprovalPlanResult,
  type PluginPackageSecretBindingTransitionApprovalPlan,
} from '@qinglong/runtime-core/plugin-package-secret-binding-transition-approval-plan';
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

export interface PlanClusterPluginPackageSecretBindingTransitionRequest {
  readonly actionRef: string;
  readonly projectId: string;
  readonly packageName: string;
  readonly assignments: readonly Readonly<PluginPackageSecretBindingAssignment>[];
  readonly principal: SecurityPrincipal;
}

export interface ProposeClusterPluginPackageSecretBindingTransitionRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly approvalAuditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface DecideClusterPluginPackageSecretBindingTransitionRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly expectedVersion: number;
  readonly decisionId: string;
  readonly auditEventId: string;
  readonly decision: 'approved' | 'rejected';
  readonly reasonCode: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectClusterPluginPackageSecretBindingTransitionRequest {
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly inspectionId: string;
  readonly principal: SecurityPrincipal;
}

export interface ClusterPluginPackageSecretBindingTransitionManagementService {
  plan(
    request: PlanClusterPluginPackageSecretBindingTransitionRequest,
  ): Promise<
    Readonly<CreatePluginPackageSecretBindingTransitionApprovalPlanResult>
  >;
  propose(
    request: ProposeClusterPluginPackageSecretBindingTransitionRequest,
  ): Promise<
    Readonly<{
      plan: Readonly<PluginPackageSecretBindingTransitionApprovalPlan>;
      approvalStatus: CreateApprovalRequestResult['status'];
      approvalRequest: Readonly<ApprovalRequestRecord>;
    }>
  >;
  decide(
    request: DecideClusterPluginPackageSecretBindingTransitionRequest,
  ): Promise<Readonly<DecideApprovalRequestResult>>;
  inspectAuthorized(
    request: InspectClusterPluginPackageSecretBindingTransitionRequest,
  ): Promise<
    Readonly<{
      plan: Readonly<PluginPackageSecretBindingTransitionApprovalPlan> | null;
      approvalRequest: Readonly<ApprovalRequestRecord> | null;
      stale: boolean;
    }>
  >;
}

export interface ClusterPluginPackageSecretBindingTransitionManagementOptions {
  readonly pool: PostgresPool;
  readonly now?: () => number;
  readonly planLifetimeMs?: number;
  readonly approvalLifetimeMs?: number;
  readonly quota?: PluginPackageManagementQuotaPort;
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
  plan: Readonly<PluginPackageSecretBindingTransitionApprovalPlan>,
): boolean {
  const expected = plan.transitionPlan.nextBindingPlan?.entries ?? [];
  if (!Array.isArray(assignments) || assignments.length !== expected.length) {
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
  return expected.every(
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
    reasons: Object.freeze(['package_secret_binding_transition_review']),
    fence,
    occurredAtMs,
  });
}

export function createClusterPluginPackageSecretBindingTransitionManagementService(
  options: ClusterPluginPackageSecretBindingTransitionManagementOptions,
): Readonly<ClusterPluginPackageSecretBindingTransitionManagementService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        !['pool', 'now', 'planLifetimeMs', 'approvalLifetimeMs', 'quota'].includes(
          key,
        ),
    ) ||
    !options.pool ||
    typeof options.pool.query !== 'function' ||
    typeof options.pool.connect !== 'function'
  ) {
    throw new TypeError('Secret binding transition management options are invalid');
  }
  const planLifetimeMs =
    options.planLifetimeMs ??
    MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_LIFETIME_MS;
  const approvalLifetimeMs =
    options.approvalLifetimeMs ?? DEFAULT_APPROVAL_LIFETIME_MS;
  for (const value of [planLifetimeMs, approvalLifetimeMs]) {
    if (
      !Number.isSafeInteger(value) ||
      value < 1_000 ||
      value >
        MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_APPROVAL_PLAN_LIFETIME_MS
    ) {
      throw new TypeError('Secret binding transition lifetime is invalid');
    }
  }
  const now = options.now ?? Date.now;
  const plans =
    new PostgresPluginPackageSecretBindingTransitionApprovalPlanRepository(
      options.pool,
    );
  const approvals = new PostgresApprovalRequestRepository(options.pool);
  const policy = new ProjectPolicyEngine(
    new PostgresProjectPolicyRepository(options.pool),
  );

  const consumeQuota = async (
    projectId: string,
    principal: Readonly<SecurityPrincipal>,
    operation: PluginPackageManagementQuotaOperation,
    idempotencyKey: string,
  ): Promise<void> => {
    if (!options.quota) return;
    try {
      await options.quota.consume({
        projectId,
        subject: principal.subject,
        operation,
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof PluginPackageManagementQuotaExceededError) throw error;
      throw new PluginPackageManagementUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
  };

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

  const loadPlan = async (requestedActionRef: string) => {
    try {
      const value = await plans.findByActionRef(actionRef(requestedActionRef));
      if (!value) {
        throw new PluginPackageManagementConflictError(
          'Secret binding transition plan does not exist',
        );
      }
      return normalizePluginPackageSecretBindingTransitionApprovalPlan(value);
    } catch (error) {
      if (error instanceof PluginPackageManagementConflictError) throw error;
      throw new PluginPackageManagementUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
  };

  return Object.freeze({
    async plan(
      request: PlanClusterPluginPackageSecretBindingTransitionRequest,
    ) {
      exact(
        request,
        ['actionRef', 'assignments', 'packageName', 'principal', 'projectId'],
        'Secret transition plan request',
      );
      const projectId = identifier(request.projectId, 'projectId');
      if (
        typeof request.packageName !== 'string' ||
        !PACKAGE_NAME_PATTERN.test(request.packageName) ||
        !Array.isArray(request.assignments)
      ) {
        throw new PluginPackageManagementRequestError(
          'Secret transition target is invalid',
        );
      }
      const authorization = await authorize(
        request.principal,
        projectId,
        'secret.manage',
        currentTime(now),
      );
      const requestedActionRef = actionRef(request.actionRef);
      await consumeQuota(
        projectId,
        authorization.principal,
        'plugin-package.propose',
        requestedActionRef,
      );
      let existing;
      try {
        existing = await plans.findByActionRef(requestedActionRef);
      } catch (error) {
        throw new PluginPackageManagementUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (existing) {
        const normalized =
          normalizePluginPackageSecretBindingTransitionApprovalPlan(existing);
        if (
          normalized.transitionPlan.nextTarget.projectId !== projectId ||
          normalized.transitionPlan.nextTarget.packageName !==
            request.packageName ||
          !sameSubject(normalized.requestedBy, authorization.principal.subject) ||
          normalized.expiresAtMs - normalized.plannedAtMs !== planLifetimeMs ||
          !assignmentsMatch(request.assignments, normalized)
        ) {
          throw new PluginPackageManagementConflictError(
            'Secret transition actionRef is bound to another request',
          );
        }
        return Object.freeze({ status: 'existing' as const, plan: normalized });
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
          'reviewed staged Package transition does not exist',
        );
      }
      const generation = (value: typeof snapshot.next) =>
        createPluginPackageResourceGenerationFromReferences({
          installationId: value.record.installationId,
          projectId: value.record.projectId,
          packageName: value.record.packageName,
          lockDigest: value.record.lockDigest,
          generation: value.record.targetGeneration,
          previousActiveLockDigest: value.record.previousActiveLockDigest,
          contentDigest: value.lock.source.contentDigest,
          resources: value.lock.resources,
        });
      try {
        const previousTarget = createPluginPackageSecretBindingTarget(
          generation(snapshot.previous),
          snapshot.previous.proposal.actionInput.manifest,
        );
        const transitionPlan = createPluginPackageSecretBindingTransitionPlan({
          previousTarget,
          previousBinding: snapshot.previous.binding,
          previousAttemptGeneration: snapshot.previousAttemptGeneration,
          nextGeneration: generation(snapshot.next),
          nextManifest: snapshot.next.proposal.actionInput.manifest,
          assignments: request.assignments,
          plannedAtMs: snapshot.observedAtMs,
        });
        return await plans.create(
          createPluginPackageSecretBindingTransitionApprovalPlan({
            actionRef: requestedActionRef,
            transitionPlan,
            requestedBy: authorization.principal.subject,
            plannedAtMs: snapshot.observedAtMs,
            expiresAtMs: snapshot.observedAtMs + planLifetimeMs,
          }),
        );
      } catch (error) {
        if (
          error instanceof
          PluginPackageSecretBindingTransitionApprovalPlanConflictError
        ) {
          throw new PluginPackageManagementConflictError(
            'Secret transition actionRef or generation is already bound',
          );
        }
        if (
          error instanceof
          PluginPackageSecretBindingTransitionApprovalPlanUnavailableError
        ) {
          throw new PluginPackageManagementUnavailableError({ cause: error });
        }
        if (error instanceof TypeError) {
          throw new PluginPackageManagementRequestError(
            'Secret transition assignments are invalid',
          );
        }
        throw error;
      }
    },

    async propose(
      request: ProposeClusterPluginPackageSecretBindingTransitionRequest,
    ) {
      exact(
        request,
        ['actionRef', 'approvalAuditEventId', 'approvalRequestId', 'principal'],
        'Secret transition proposal request',
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
          'Secret transition plan expired',
        );
      }
      const authorization = await authorize(
        request.principal,
        plan.transitionPlan.nextTarget.projectId,
        'secret.manage',
        observedAtMs,
      );
      await consumeQuota(
        plan.transitionPlan.nextTarget.projectId,
        authorization.principal,
        'plugin-package.propose',
        approvalRequestId,
      );
      if (!sameSubject(plan.requestedBy, authorization.principal.subject)) {
        throw new PluginPackageManagementAuthorizationError();
      }
      const binding = pluginPackageSecretBindingTransitionApprovedAction(plan);
      const existing = await approvals.findById(approvalRequestId);
      if (existing) {
        const normalized = normalizeApprovalRequestRecord(existing);
        if (
          normalized.projectId !== plan.transitionPlan.nextTarget.projectId ||
          normalized.decisionMode !== 'separation_of_duty' ||
          !sameSubject(normalized.requestedBy, plan.requestedBy) ||
          !same(normalized.action, binding)
        ) {
          throw new PluginPackageManagementConflictError(
            'Approval request is bound to another Secret transition',
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
          'Secret transition plan has no approval lifetime',
        );
      }
      const result = await approvals.create({
        request: createApprovalRequest({
          id: approvalRequestId,
          projectId: plan.transitionPlan.nextTarget.projectId,
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
          plan.transitionPlan.nextTarget.projectId,
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

    async decide(
      request: DecideClusterPluginPackageSecretBindingTransitionRequest,
    ) {
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
        'Secret transition decision request',
      );
      if (
        (request.decision !== 'approved' && request.decision !== 'rejected') ||
        typeof request.reasonCode !== 'string' ||
        !REASON_PATTERN.test(request.reasonCode) ||
        !Number.isSafeInteger(request.expectedVersion) ||
        request.expectedVersion < 1
      ) {
        throw new PluginPackageManagementRequestError(
          'Secret transition decision tuple is invalid',
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
        !same(
          approval.action,
          pluginPackageSecretBindingTransitionApprovedAction(plan),
        )
      ) {
        throw new PluginPackageManagementConflictError(
          'Approval request does not match Secret transition plan',
        );
      }
      const observedAtMs = currentTime(now);
      const authorization = await authorize(
        request.principal,
        approval.projectId,
        'approval.decide',
        observedAtMs,
      );
      await consumeQuota(
        approval.projectId,
        authorization.principal,
        'plugin-package.decide',
        decisionId,
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
      request: InspectClusterPluginPackageSecretBindingTransitionRequest,
    ) {
      exact(
        request,
        ['actionRef', 'approvalRequestId', 'inspectionId', 'principal'],
        'Secret transition inspection request',
      );
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
          'Secret transition review state does not exist',
        );
      }
      const plan = planValue
        ? normalizePluginPackageSecretBindingTransitionApprovalPlan(planValue)
        : null;
      const approval = approvalValue
        ? normalizeApprovalRequestRecord(approvalValue)
        : null;
      const projectId =
        plan?.transitionPlan.nextTarget.projectId ?? approval?.projectId;
      if (!projectId) throw new PluginPackageManagementUnavailableError();
      const observedAtMs = currentTime(now);
      let authorization;
      try {
        authorization = await authorize(
          request.principal,
          projectId,
          'secret.manage',
          observedAtMs,
        );
      } catch (error) {
        if (!(error instanceof PluginPackageManagementAuthorizationError)) {
          throw error;
        }
        authorization = await authorize(
          request.principal,
          projectId,
          'approval.decide',
          observedAtMs,
        );
      }
      await consumeQuota(
        projectId,
        authorization.principal,
        'plugin-package.inspect',
        identifier(request.inspectionId, 'inspectionId'),
      );
      return Object.freeze({
        plan,
        approvalRequest: approval,
        stale:
          plan === null ||
          approval === null ||
          !same(
            approval.action,
            pluginPackageSecretBindingTransitionApprovedAction(plan),
          ) ||
          observedAtMs > plan.expiresAtMs,
      });
    },
  });
}
