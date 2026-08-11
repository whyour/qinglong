/** Worker credential management application service boundary. */
import {
  PostgresApprovalRequestRepository,
  PostgresProjectPolicyRepository,
  PostgresWorkerCredentialManagementPlanRepository,
} from '@qinglong/cluster-postgres/worker-credential-manager';
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  createApprovalRequest,
  normalizeApprovalRequestRecord,
  type ApprovalRequestRecord,
  type CreateApprovalRequestResult,
  type DecideApprovalRequestResult,
} from '@qinglong/runtime-core/approved-action';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
  type SecurityPrincipal,
  type SecuritySubject,
} from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import {
  InvalidWorkerCredentialManagementPlanError,
  MAX_WORKER_CREDENTIAL_MANAGEMENT_PLAN_LIFETIME_MS,
  WorkerCredentialManagementPlanConflictError,
  WorkerCredentialManagementPlanUnavailableError,
  createWorkerCredentialManagementPlan,
  normalizeWorkerCredentialManagementPlan,
  type CreateWorkerCredentialManagementPlanResult,
  type WorkerCredentialManagementAction,
  type WorkerCredentialManagementPlan,
} from '@qinglong/runtime-core/worker-credential-management-plan';

const DEFAULT_APPROVAL_LIFETIME_MS = 15 * 60 * 1000;
const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

export class WorkerCredentialManagementRequestError extends TypeError {
  readonly code = 'WORKER_CREDENTIAL_MANAGEMENT_REQUEST_INVALID';

  constructor(message: string) {
    super(`Worker credential management request is invalid: ${message}`);
    this.name = 'WorkerCredentialManagementRequestError';
  }
}

export class WorkerCredentialManagementAuthorizationError extends Error {
  readonly code = 'WORKER_CREDENTIAL_MANAGEMENT_FORBIDDEN';

  constructor() {
    super('Worker credential management is not authorized');
    this.name = 'WorkerCredentialManagementAuthorizationError';
  }
}

export class WorkerCredentialManagementConflictError extends Error {
  readonly code = 'WORKER_CREDENTIAL_MANAGEMENT_CONFLICT';

  constructor(message: string) {
    super(
      `Worker credential management conflicts with durable state: ${message}`,
    );
    this.name = 'WorkerCredentialManagementConflictError';
  }
}

export class WorkerCredentialManagementUnavailableError extends Error {
  readonly code = 'WORKER_CREDENTIAL_MANAGEMENT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Worker credential management is unavailable', options);
    this.name = 'WorkerCredentialManagementUnavailableError';
  }
}

export class WorkerCredentialManagementQuotaExceededError extends Error {
  readonly code = 'WORKER_CREDENTIAL_MANAGEMENT_QUOTA_EXCEEDED';

  constructor(readonly retryAfterMs: number) {
    super('Worker credential management quota is exceeded');
    this.name = 'WorkerCredentialManagementQuotaExceededError';
  }
}

export type WorkerCredentialManagementQuotaOperation =
  | 'worker-credential.plan'
  | 'worker-credential.propose'
  | 'worker-credential.decide'
  | 'worker-credential.inspect';

export interface WorkerCredentialManagementQuotaPort {
  consume(
    command: Readonly<{
      projectId: string;
      subject: Readonly<SecuritySubject>;
      operation: WorkerCredentialManagementQuotaOperation;
      idempotencyKey: string;
    }>,
  ): Promise<
    Readonly<{
      admitted: boolean;
      retryAfterMs: number | null;
    }>
  >;
}

export interface PlanClusterWorkerCredentialRequest {
  readonly actionRef: string;
  readonly authorityProjectId: string;
  readonly action: WorkerCredentialManagementAction;
  readonly deliveryId: string;
  readonly workerId: string;
  readonly credentialId: string;
  readonly previousCredentialId: string | null;
  readonly credentialNotBeforeAtMs: number;
  readonly credentialExpiresAtMs: number;
  readonly deploymentTargetDigest: string;
  readonly deploymentGeneration: string;
  readonly principal: SecurityPrincipal;
}

export interface ProposeClusterWorkerCredentialRequest {
  readonly actionRef: string;
  readonly authorityProjectId: string;
  readonly approvalRequestId: string;
  readonly approvalAuditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface ProposeClusterWorkerCredentialResult {
  readonly plan: Readonly<WorkerCredentialManagementPlan>;
  readonly approvalStatus: CreateApprovalRequestResult['status'];
  readonly approvalRequest: Readonly<ApprovalRequestRecord>;
}

export interface DecideClusterWorkerCredentialRequest {
  readonly actionRef: string;
  readonly authorityProjectId: string;
  readonly approvalRequestId: string;
  readonly expectedVersion: number;
  readonly decisionId: string;
  readonly auditEventId: string;
  readonly decision: 'approved' | 'rejected';
  readonly reasonCode: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectClusterWorkerCredentialRequest {
  readonly actionRef: string;
  readonly authorityProjectId: string;
  readonly approvalRequestId: string;
  readonly inspectionId: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectClusterWorkerCredentialResult {
  readonly plan: Readonly<WorkerCredentialManagementPlan> | null;
  readonly approvalRequest: Readonly<ApprovalRequestRecord> | null;
  readonly stale: boolean;
}

export interface ClusterWorkerCredentialManagementService {
  plan(
    request: PlanClusterWorkerCredentialRequest,
  ): Promise<Readonly<CreateWorkerCredentialManagementPlanResult>>;
  propose(
    request: ProposeClusterWorkerCredentialRequest,
  ): Promise<Readonly<ProposeClusterWorkerCredentialResult>>;
  decide(
    request: DecideClusterWorkerCredentialRequest,
  ): Promise<Readonly<DecideApprovalRequestResult>>;
  inspectAuthorized(
    request: InspectClusterWorkerCredentialRequest,
  ): Promise<Readonly<InspectClusterWorkerCredentialResult>>;
}

export interface ClusterWorkerCredentialManagementOptions {
  readonly pool: PostgresPool;
  readonly quota?: WorkerCredentialManagementQuotaPort;
  readonly now?: () => number;
  readonly planLifetimeMs?: number;
  readonly approvalLifetimeMs?: number;
}

function exact(value: unknown, keys: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerCredentialManagementRequestError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new WorkerCredentialManagementRequestError(
      `${label} shape is invalid`,
    );
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new WorkerCredentialManagementRequestError(`${label} is invalid`);
  }
  return value;
}

function actionRef(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    throw new WorkerCredentialManagementRequestError('actionRef is invalid');
  }
  return value;
}

function currentTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerCredentialManagementUnavailableError();
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

function binding(plan: Readonly<WorkerCredentialManagementPlan>) {
  return Object.freeze({
    permission: 'worker.manage' as const,
    actionType: `worker_credential.delivery.${plan.action}`,
    actionRef: plan.actionRef,
    actionDigest: plan.planDigest,
    previewDigest: plan.previewDigest,
  });
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
    reasons: Object.freeze(['worker_credential_review']),
    fence,
    occurredAtMs,
  });
}

export function createClusterWorkerCredentialManagementService(
  options: ClusterWorkerCredentialManagementOptions,
): Readonly<ClusterWorkerCredentialManagementService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        key !== 'approvalLifetimeMs' &&
        key !== 'now' &&
        key !== 'planLifetimeMs' &&
        key !== 'pool' &&
        key !== 'quota',
    )
  ) {
    throw new WorkerCredentialManagementRequestError(
      'options shape is invalid',
    );
  }
  if (!options.pool || typeof options.pool.query !== 'function') {
    throw new WorkerCredentialManagementRequestError('pool is invalid');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new WorkerCredentialManagementRequestError('now is invalid');
  }
  if (
    options.quota !== undefined &&
    (!options.quota || typeof options.quota.consume !== 'function')
  ) {
    throw new WorkerCredentialManagementRequestError('quota is invalid');
  }
  const planLifetimeMs =
    options.planLifetimeMs ?? MAX_WORKER_CREDENTIAL_MANAGEMENT_PLAN_LIFETIME_MS;
  const approvalLifetimeMs =
    options.approvalLifetimeMs ?? DEFAULT_APPROVAL_LIFETIME_MS;
  if (
    !Number.isSafeInteger(planLifetimeMs) ||
    planLifetimeMs < 1_000 ||
    planLifetimeMs > MAX_WORKER_CREDENTIAL_MANAGEMENT_PLAN_LIFETIME_MS ||
    !Number.isSafeInteger(approvalLifetimeMs) ||
    approvalLifetimeMs < 1_000 ||
    approvalLifetimeMs > DEFAULT_APPROVAL_LIFETIME_MS
  ) {
    throw new WorkerCredentialManagementRequestError('lifetime is invalid');
  }
  const now = options.now ?? Date.now;
  const plans = new PostgresWorkerCredentialManagementPlanRepository(
    options.pool,
  );
  const approvals = new PostgresApprovalRequestRepository(options.pool);
  const policy = new ProjectPolicyEngine(
    new PostgresProjectPolicyRepository(options.pool),
  );

  const consumeQuota = async (
    projectId: string,
    principal: Readonly<SecurityPrincipal>,
    operation: WorkerCredentialManagementQuotaOperation,
    idempotencyKey: string,
  ): Promise<void> => {
    if (!options.quota) return;
    try {
      const result = await options.quota.consume({
        projectId,
        subject: principal.subject,
        operation,
        idempotencyKey,
      });
      if (
        !result ||
        typeof result !== 'object' ||
        typeof result.admitted !== 'boolean' ||
        (result.retryAfterMs !== null &&
          (!Number.isSafeInteger(result.retryAfterMs) ||
            result.retryAfterMs < 1))
      ) {
        throw new Error('quota result is invalid');
      }
      if (!result.admitted) {
        if (result.retryAfterMs === null) {
          throw new Error('quota rejection has no retry bound');
        }
        throw new WorkerCredentialManagementQuotaExceededError(
          result.retryAfterMs,
        );
      }
    } catch (error) {
      if (error instanceof WorkerCredentialManagementQuotaExceededError) {
        throw error;
      }
      throw new WorkerCredentialManagementUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
  };

  const authorize = async (
    principalValue: SecurityPrincipal,
    projectId: string,
    permission: 'worker.manage' | 'approval.decide',
    observedAtMs: number,
  ): Promise<
    Readonly<{
      principal: Readonly<SecurityPrincipal>;
      fence: Readonly<SecurityPolicyFence>;
    }>
  > => {
    let principal: Readonly<SecurityPrincipal>;
    try {
      principal = normalizeSecurityPrincipal(principalValue, observedAtMs);
    } catch {
      throw new WorkerCredentialManagementAuthorizationError();
    }
    if (
      principal.subject.type !== 'user' ||
      !STRONG_USER_ASSURANCES.has(principal.assurance)
    ) {
      throw new WorkerCredentialManagementAuthorizationError();
    }
    let decision;
    try {
      decision = await policy.authorize(principal, projectId, permission);
    } catch (error) {
      throw new WorkerCredentialManagementUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (decision.effect !== 'allow' || decision.fence === null) {
      throw new WorkerCredentialManagementAuthorizationError();
    }
    return Object.freeze({ principal, fence: decision.fence });
  };

  const loadPlan = async (
    requestedActionRef: string,
  ): Promise<Readonly<WorkerCredentialManagementPlan>> => {
    let value;
    try {
      value = await plans.findByActionRef(actionRef(requestedActionRef));
    } catch (error) {
      throw new WorkerCredentialManagementUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (!value) {
      throw new WorkerCredentialManagementConflictError('plan does not exist');
    }
    return normalizeWorkerCredentialManagementPlan(value);
  };

  return Object.freeze({
    async plan(request: PlanClusterWorkerCredentialRequest) {
      exact(
        request,
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
          'principal',
          'workerId',
        ],
        'plan request',
      );
      const observedAtMs = currentTime(now);
      const authorization = await authorize(
        request.principal,
        identifier(request.authorityProjectId, 'authorityProjectId'),
        'worker.manage',
        observedAtMs,
      );
      await consumeQuota(
        request.authorityProjectId,
        authorization.principal,
        'worker-credential.plan',
        actionRef(request.actionRef),
      );
      try {
        const plan = createWorkerCredentialManagementPlan({
          actionRef: actionRef(request.actionRef),
          authorityProjectId: request.authorityProjectId,
          action: request.action,
          target: {
            deliveryId: request.deliveryId,
            workerId: request.workerId,
            credentialId: request.credentialId,
            previousCredentialId: request.previousCredentialId,
            credentialNotBeforeAtMs: request.credentialNotBeforeAtMs,
            credentialExpiresAtMs: request.credentialExpiresAtMs,
            deploymentTargetDigest: request.deploymentTargetDigest,
            deploymentGeneration: request.deploymentGeneration,
          },
          requestedBy: authorization.principal.subject,
          plannedAtMs: observedAtMs,
          expiresAtMs: observedAtMs + planLifetimeMs,
        });
        return await plans.create(plan);
      } catch (error) {
        if (error instanceof InvalidWorkerCredentialManagementPlanError) {
          throw new WorkerCredentialManagementRequestError('plan is invalid');
        }
        if (error instanceof WorkerCredentialManagementPlanConflictError) {
          throw new WorkerCredentialManagementConflictError(
            'plan identity is already bound',
          );
        }
        throw new WorkerCredentialManagementUnavailableError({
          cause:
            error instanceof WorkerCredentialManagementPlanUnavailableError
              ? error
              : error instanceof Error
              ? error
              : undefined,
        });
      }
    },

    async propose(request: ProposeClusterWorkerCredentialRequest) {
      exact(
        request,
        [
          'actionRef',
          'authorityProjectId',
          'approvalAuditEventId',
          'approvalRequestId',
          'principal',
        ],
        'proposal request',
      );
      const approvalRequestId = identifier(
        request.approvalRequestId,
        'approvalRequestId',
      );
      const approvalAuditEventId = identifier(
        request.approvalAuditEventId,
        'approvalAuditEventId',
      );
      const observedAtMs = currentTime(now);
      const authorityProjectId = identifier(
        request.authorityProjectId,
        'authorityProjectId',
      );
      const authorization = await authorize(
        request.principal,
        authorityProjectId,
        'worker.manage',
        observedAtMs,
      );
      await consumeQuota(
        authorityProjectId,
        authorization.principal,
        'worker-credential.propose',
        approvalRequestId,
      );
      const plan = await loadPlan(request.actionRef);
      if (plan.authorityProjectId !== authorityProjectId) {
        throw new WorkerCredentialManagementConflictError(
          'plan belongs to another authority Project',
        );
      }
      if (observedAtMs > plan.expiresAtMs) {
        throw new WorkerCredentialManagementConflictError('plan expired');
      }
      if (!sameSubject(plan.requestedBy, authorization.principal.subject)) {
        throw new WorkerCredentialManagementAuthorizationError();
      }
      const action = binding(plan);
      let existing;
      try {
        existing = await approvals.findById(approvalRequestId);
      } catch (error) {
        throw new WorkerCredentialManagementUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (existing) {
        const normalized = normalizeApprovalRequestRecord(existing);
        if (
          normalized.projectId !== plan.authorityProjectId ||
          normalized.decisionMode !== 'separation_of_duty' ||
          !sameSubject(normalized.requestedBy, plan.requestedBy) ||
          !same(normalized.action, action)
        ) {
          throw new WorkerCredentialManagementConflictError(
            'approval is bound to another plan',
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
        throw new WorkerCredentialManagementConflictError(
          'plan has no approval lifetime',
        );
      }
      const created = await approvals.create({
        request: createApprovalRequest({
          id: approvalRequestId,
          projectId: plan.authorityProjectId,
          action,
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
          plan.authorityProjectId,
          authorization.principal,
          'approval_required',
          authorization.fence,
          observedAtMs,
        ),
      });
      return Object.freeze({
        plan,
        approvalStatus: created.status,
        approvalRequest: created.request,
      });
    },

    async decide(request: DecideClusterWorkerCredentialRequest) {
      exact(
        request,
        [
          'actionRef',
          'authorityProjectId',
          'approvalRequestId',
          'auditEventId',
          'decision',
          'decisionId',
          'expectedVersion',
          'principal',
          'reasonCode',
        ],
        'decision request',
      );
      if (
        (request.decision !== 'approved' && request.decision !== 'rejected') ||
        typeof request.reasonCode !== 'string' ||
        !REASON_PATTERN.test(request.reasonCode) ||
        !Number.isSafeInteger(request.expectedVersion) ||
        request.expectedVersion < 1
      ) {
        throw new WorkerCredentialManagementRequestError(
          'decision tuple is invalid',
        );
      }
      const approvalRequestId = identifier(
        request.approvalRequestId,
        'approvalRequestId',
      );
      const observedAtMs = currentTime(now);
      const authorityProjectId = identifier(
        request.authorityProjectId,
        'authorityProjectId',
      );
      const authorization = await authorize(
        request.principal,
        authorityProjectId,
        'approval.decide',
        observedAtMs,
      );
      const decisionId = identifier(request.decisionId, 'decisionId');
      await consumeQuota(
        authorityProjectId,
        authorization.principal,
        'worker-credential.decide',
        decisionId,
      );
      const plan = await loadPlan(request.actionRef);
      if (plan.authorityProjectId !== authorityProjectId) {
        throw new WorkerCredentialManagementConflictError(
          'plan belongs to another authority Project',
        );
      }
      const current = await approvals.findById(approvalRequestId);
      if (!current) {
        throw new WorkerCredentialManagementConflictError(
          'approval does not exist',
        );
      }
      const approval = normalizeApprovalRequestRecord(current);
      if (
        approval.projectId !== plan.authorityProjectId ||
        !same(approval.action, binding(plan))
      ) {
        throw new WorkerCredentialManagementConflictError(
          'approval does not match plan',
        );
      }
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
          identifier(request.auditEventId, 'auditEventId'),
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

    async inspectAuthorized(request: InspectClusterWorkerCredentialRequest) {
      exact(
        request,
        [
          'actionRef',
          'authorityProjectId',
          'approvalRequestId',
          'inspectionId',
          'principal',
        ],
        'inspection request',
      );
      const inspectionId = identifier(request.inspectionId, 'inspectionId');
      const projectId = identifier(
        request.authorityProjectId,
        'authorityProjectId',
      );
      const observedAtMs = currentTime(now);
      let authorization;
      try {
        authorization = await authorize(
          request.principal,
          projectId,
          'worker.manage',
          observedAtMs,
        );
      } catch (error) {
        if (!(error instanceof WorkerCredentialManagementAuthorizationError)) {
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
        'worker-credential.inspect',
        inspectionId,
      );
      const [planValue, approvalValue] = await Promise.all([
        plans.findByActionRef(actionRef(request.actionRef)),
        approvals.findById(
          identifier(request.approvalRequestId, 'approvalRequestId'),
        ),
      ]);
      if (!planValue && !approvalValue) {
        throw new WorkerCredentialManagementConflictError(
          'management state does not exist',
        );
      }
      const plan = planValue
        ? normalizeWorkerCredentialManagementPlan(planValue)
        : null;
      const approval = approvalValue
        ? normalizeApprovalRequestRecord(approvalValue)
        : null;
      if (
        (plan && plan.authorityProjectId !== projectId) ||
        (approval && approval.projectId !== projectId)
      ) {
        throw new WorkerCredentialManagementConflictError(
          'management state belongs to another authority Project',
        );
      }
      return Object.freeze({
        plan,
        approvalRequest: approval,
        stale:
          plan === null ||
          approval === null ||
          approval.projectId !== plan.authorityProjectId ||
          !same(approval.action, binding(plan)) ||
          observedAtMs > plan.expiresAtMs,
      });
    },
  });
}
