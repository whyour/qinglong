/** Approved Worker credential management execution boundary. */
import { createHash } from 'node:crypto';
import {
  PostgresApprovedActionExecutionRepository,
  PostgresApprovalRequestRepository,
  PostgresProjectPolicyRepository,
  PostgresWorkerCredentialAdministrationRepository,
  PostgresWorkerCredentialManagementPlanReader,
  assertPostgresWorkerCredentialExecutorSchemaReady,
  type PostgresSchemaReadinessReport,
} from '@qinglong/cluster-postgres/worker-credential-executor';
import type {
  OpenPostgresDatabase,
  PostgresDatabaseResource,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  normalizeApprovalRequestRecord,
  type ApprovedActionBinding,
  type ApprovedActionDispatchRecord,
} from '@qinglong/runtime-core/approved-action';
import type { ApprovedActionExecutionRecord } from '@qinglong/runtime-core/approved-action-execution';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import type {
  SecurityPolicyFence,
  SecurityPrincipal,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import {
  normalizeWorkerCredentialManagementPlan,
  type WorkerCredentialManagementPlan,
} from '@qinglong/runtime-core/worker-credential-management-plan';
import {
  createRecoverableWorkerCredentialIssuer,
  type RecoverableWorkerCredentialIssueResult,
} from './workerCredentialDelivery';
import type {
  WorkerCredentialKubernetesTokenRequestEvidence,
  WorkerCredentialKubernetesTokenRequestSession,
} from './workerCredentialKubernetesTokenRequest';
import {
  WorkerCredentialManagementConflictError,
  WorkerCredentialManagementRequestError,
  WorkerCredentialManagementUnavailableError,
} from './management-server/workerCredentialManagement';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const EXECUTOR_SUBJECT = Object.freeze({
  type: 'system' as const,
  id: 'cluster_worker_credential_executor',
});
const EXECUTOR_AUTHENTICATION_ID = 'cluster_worker_credential_executor_v1';
const EXECUTOR_PRINCIPAL_LIFETIME_MS = 15 * 60 * 1000;
const EXECUTION_LEASE_DURATION_MS = 10 * 60 * 1000;
const EXECUTION_OWNER = 'cluster_worker_credential_executor';
const EXECUTION_RESULT_CODE = 'worker_credential_published';

export interface RunClusterWorkerCredentialExecutionOptions {
  readonly openDatabase: OpenPostgresDatabase;
  readonly tokenRequestSession: WorkerCredentialKubernetesTokenRequestSession;
  readonly workerCredentialPepper: string;
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly consumptionId: string;
  readonly dispatchId: string;
  readonly auditEventId: string;
  readonly confirmAuthorization: () => void | Promise<void>;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface ClusterWorkerCredentialExecutionRun {
  readonly database: PostgresSchemaReadinessReport;
  readonly approval: Readonly<ApprovedActionDispatchRecord>;
  readonly execution: Readonly<ApprovedActionExecutionRecord>;
  readonly result: Readonly<RecoverableWorkerCredentialIssueResult>;
  readonly tokenRequest: Readonly<WorkerCredentialKubernetesTokenRequestEvidence> | null;
}

type Row = Record<string, unknown>;

function exactOptions(value: RunClusterWorkerCredentialExecutionOptions): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerCredentialManagementRequestError(
      'execution options must be an object',
    );
  }
  const allowed = new Set([
    'actionRef',
    'approvalRequestId',
    'auditEventId',
    'confirmAuthorization',
    'consumptionId',
    'dispatchId',
    'now',
    'openDatabase',
    'randomBytes',
    'tokenRequestSession',
    'workerCredentialPepper',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new WorkerCredentialManagementRequestError(
      'execution options shape is invalid',
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

function binding(
  plan: Readonly<WorkerCredentialManagementPlan>,
): Readonly<ApprovedActionBinding> {
  return Object.freeze({
    permission: 'worker.manage',
    actionType: `worker_credential.delivery.${plan.action}`,
    actionRef: plan.actionRef,
    actionDigest: plan.planDigest,
    previewDigest: plan.previewDigest,
  });
}

function audit(
  eventId: string,
  requestId: string,
  projectId: string,
  fence: Readonly<SecurityPolicyFence>,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  return Object.freeze({
    eventId,
    requestId,
    operationId: 'approval.consume',
    projectId,
    subject: EXECUTOR_SUBJECT,
    authenticationId: EXECUTOR_AUTHENTICATION_ID,
    outcome: 'allowed',
    reasons: Object.freeze(['worker_credential_review']),
    fence,
    occurredAtMs,
  });
}

function executorPrincipal(nowMs: number): Readonly<SecurityPrincipal> {
  return Object.freeze({
    subject: EXECUTOR_SUBJECT,
    authenticationId: EXECUTOR_AUTHENTICATION_ID,
    authenticatedAtMs: nowMs,
    expiresAtMs: nowMs + EXECUTOR_PRINCIPAL_LIFETIME_MS,
    assurance: 'service' as const,
  });
}

function executionResultDigest(
  plan: Readonly<WorkerCredentialManagementPlan>,
  result: Readonly<RecoverableWorkerCredentialIssueResult>,
): string {
  const delivery = result.delivery;
  if (
    !delivery ||
    (delivery.state !== 'published' &&
      delivery.state !== 'observed' &&
      delivery.state !== 'previous_revoked') ||
    delivery.deliveryId !== plan.target.deliveryId ||
    delivery.workerId !== plan.target.workerId ||
    delivery.credentialId !== plan.target.credentialId ||
    delivery.previousCredentialId !== plan.target.previousCredentialId ||
    delivery.deploymentTargetDigest !== plan.target.deploymentTargetDigest ||
    delivery.deploymentGeneration !== plan.target.deploymentGeneration ||
    typeof delivery.publicationDigest !== 'string'
  ) {
    throw new WorkerCredentialManagementConflictError(
      'credential delivery does not match approved execution',
    );
  }
  return createHash('sha256')
    .update('qinglong/worker-credential-execution-result@v1\0', 'utf8')
    .update(
      JSON.stringify({
        deliveryId: delivery.deliveryId,
        credentialId: delivery.credentialId,
        workerId: delivery.workerId,
        deploymentGeneration: delivery.deploymentGeneration,
        publicationDigest: delivery.publicationDigest,
      }),
      'utf8',
    )
    .digest('hex');
}

async function assertPredecessor(
  pool: PostgresPool,
  plan: Readonly<WorkerCredentialManagementPlan>,
  observedAtMs: number,
): Promise<void> {
  if (plan.action === 'issue') return;
  const result = await pool.query<Row>(
    `SELECT state, worker_id AS "workerId", expires_at_ms AS "expiresAtMs"
       FROM "ql3"."worker_credentials"
      WHERE credential_id = $1
      ORDER BY version DESC
      LIMIT 1`,
    [plan.target.previousCredentialId],
  );
  const row = result.rows[0];
  const expiresAtMs =
    typeof row?.expiresAtMs === 'number'
      ? row.expiresAtMs
      : typeof row?.expiresAtMs === 'string' && /^\d+$/.test(row.expiresAtMs)
      ? Number(row.expiresAtMs)
      : Number.NaN;
  if (
    result.rows.length !== 1 ||
    row?.state !== 'active' ||
    row.workerId !== plan.target.workerId ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= observedAtMs
  ) {
    throw new WorkerCredentialManagementConflictError(
      'rotation predecessor is not active for the target Worker',
    );
  }
}

async function closeDatabase(
  database: PostgresDatabaseResource | undefined,
  failure: unknown,
): Promise<void> {
  if (!database) {
    if (failure !== undefined) throw failure;
    return;
  }
  try {
    await database.close();
  } catch (closeError) {
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, closeError],
        'Worker credential execution failed and PostgreSQL did not close',
      );
    }
    throw closeError;
  }
  if (failure !== undefined) throw failure;
}

export async function runClusterWorkerCredentialExecution(
  options: RunClusterWorkerCredentialExecutionOptions,
): Promise<Readonly<ClusterWorkerCredentialExecutionRun>> {
  exactOptions(options);
  if (
    typeof options.openDatabase !== 'function' ||
    !options.tokenRequestSession ||
    typeof options.tokenRequestSession.withDelivery !== 'function' ||
    typeof options.confirmAuthorization !== 'function' ||
    typeof options.workerCredentialPepper !== 'string' ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.randomBytes !== undefined &&
      typeof options.randomBytes !== 'function')
  ) {
    throw new WorkerCredentialManagementRequestError(
      'execution dependency is invalid',
    );
  }
  const requestedActionRef = actionRef(options.actionRef);
  const approvalRequestId = identifier(
    options.approvalRequestId,
    'approvalRequestId',
  );
  const consumptionId = identifier(options.consumptionId, 'consumptionId');
  const dispatchId = identifier(options.dispatchId, 'dispatchId');
  const auditEventId = identifier(options.auditEventId, 'auditEventId');
  const now = options.now ?? Date.now;
  let database: PostgresDatabaseResource | undefined;
  let failure: unknown;
  let run: Readonly<ClusterWorkerCredentialExecutionRun> | undefined;
  try {
    await options.confirmAuthorization();
    database = await options.openDatabase();
    const evidence = await assertPostgresWorkerCredentialExecutorSchemaReady(
      database.pool,
    );
    const plans = new PostgresWorkerCredentialManagementPlanReader(
      database.pool,
    );
    const planValue = await plans.findByActionRef(requestedActionRef);
    if (!planValue) {
      throw new WorkerCredentialManagementConflictError('plan does not exist');
    }
    const plan = normalizeWorkerCredentialManagementPlan(planValue);
    const approvals = new PostgresApprovalRequestRepository(database.pool);
    const approvalValue = await approvals.findById(approvalRequestId);
    if (!approvalValue) {
      throw new WorkerCredentialManagementConflictError(
        'approval does not exist',
      );
    }
    let approval = normalizeApprovalRequestRecord(approvalValue);
    const approvedAction = binding(plan);
    if (
      approval.projectId !== plan.authorityProjectId ||
      approval.decisionMode !== 'separation_of_duty' ||
      !same(approval.action, approvedAction) ||
      !same(approval.requestedBy, plan.requestedBy)
    ) {
      throw new WorkerCredentialManagementConflictError(
        'approval does not match durable plan',
      );
    }
    let dispatch: Readonly<ApprovedActionDispatchRecord> | null = null;
    if (approval.version === 2 && approval.state === 'approved') {
      const policy = new ProjectPolicyEngine(
        new PostgresProjectPolicyRepository(database.pool),
      );
      const decision = await policy.decide({
        subject: plan.requestedBy,
        projectId: plan.authorityProjectId,
        permission: 'worker.manage',
      });
      if (
        (decision.effect !== 'allow' &&
          decision.effect !== 'require_approval') ||
        decision.fence === null
      ) {
        throw new WorkerCredentialManagementConflictError(
          'requester is no longer authorized',
        );
      }
      const consumedAtMs = currentTime(now);
      const consumed = await approvals.consume({
        requestId: approvalRequestId,
        expectedVersion: 2,
        consumptionId,
        dispatchId,
        action: approvedAction,
        requestedBy: plan.requestedBy,
        consumedBy: EXECUTOR_SUBJECT,
        consumedAtMs,
        authorizationFence: decision.fence,
        audit: audit(
          auditEventId,
          approvalRequestId,
          plan.authorityProjectId,
          decision.fence,
          consumedAtMs,
        ),
      });
      approval = consumed.request;
      dispatch = consumed.dispatch;
    } else if (approval.version === 3 && approval.state === 'consumed') {
      dispatch = await approvals.findDispatchById(dispatchId);
    }
    if (
      approval.version !== 3 ||
      approval.state !== 'consumed' ||
      approval.consumptionId !== consumptionId ||
      approval.dispatchId !== dispatchId ||
      !dispatch ||
      dispatch.id !== dispatchId ||
      !same(dispatch.action, approvedAction) ||
      !same(dispatch.requestedBy, plan.requestedBy) ||
      !same(dispatch.approvedBy, approval.decidedBy) ||
      !same(dispatch.consumedBy, EXECUTOR_SUBJECT)
    ) {
      throw new WorkerCredentialManagementConflictError(
        'approval consumption does not match execution',
      );
    }
    const authority = new PostgresWorkerCredentialAdministrationRepository(
      database.pool,
    );
    const executions = new PostgresApprovedActionExecutionRepository(
      database.pool,
    );
    let executionSnapshot = await executions.findExecutionByDispatchId(
      dispatchId,
    );
    if (!executionSnapshot || !same(executionSnapshot.dispatch, dispatch)) {
      throw new WorkerCredentialManagementConflictError(
        'durable execution baseline does not match dispatch',
      );
    }
    if (executionSnapshot.execution.status === 'succeeded') {
      const resolved = await authority.resolveDelivered(plan.target.deliveryId);
      const result = Object.freeze({
        status: 'existing' as const,
        delivery: resolved?.delivery ?? null,
      });
      const resultDigest = executionResultDigest(plan, result);
      if (
        executionSnapshot.execution.resultMutationId !==
          plan.target.deliveryId ||
        executionSnapshot.execution.resultCode !== EXECUTION_RESULT_CODE ||
        executionSnapshot.execution.resultDigest !== resultDigest
      ) {
        throw new WorkerCredentialManagementConflictError(
          'durable execution result does not match credential delivery',
        );
      }
      run = Object.freeze({
        database: evidence,
        approval: dispatch,
        execution: executionSnapshot.execution,
        result,
        tokenRequest: null,
      });
      await closeDatabase(database, undefined);
      return run;
    }
    const executionNowMs = currentTime(now);
    if (
      executionNowMs > plan.expiresAtMs ||
      executionNowMs >= dispatch.expiresAtMs ||
      executionNowMs >= plan.target.credentialExpiresAtMs
    ) {
      throw new WorkerCredentialManagementConflictError(
        'approved execution window expired',
      );
    }
    await assertPredecessor(database.pool, plan, executionNowMs);
    await options.confirmAuthorization();
    if (
      executionSnapshot.execution.status === 'pending' ||
      executionSnapshot.execution.status === 'retry_wait' ||
      (executionSnapshot.execution.status === 'leased' &&
        executionSnapshot.execution.leaseExpiresAtMs !== null &&
        executionSnapshot.execution.leaseExpiresAtMs <= executionNowMs)
    ) {
      const claimed = await executions.claimExecution({
        dispatchId,
        owner: EXECUTION_OWNER,
        leaseToken: consumptionId,
        nowMs: executionNowMs,
        leaseDurationMs: EXECUTION_LEASE_DURATION_MS,
      });
      if (claimed.status !== 'claimed') {
        throw new WorkerCredentialManagementConflictError(
          'approved execution could not be claimed',
        );
      }
      executionSnapshot = claimed.snapshot;
    }
    if (
      (executionSnapshot.execution.status !== 'leased' &&
        executionSnapshot.execution.status !== 'executing') ||
      executionSnapshot.execution.leaseOwner !== EXECUTION_OWNER ||
      executionSnapshot.execution.leaseToken !== consumptionId ||
      executionSnapshot.execution.leaseExpiresAtMs === null ||
      executionSnapshot.execution.leaseExpiresAtMs <= executionNowMs
    ) {
      throw new WorkerCredentialManagementConflictError(
        'approved execution lease does not match caller',
      );
    }
    if (executionSnapshot.execution.status === 'leased') {
      executionSnapshot = await executions.startExecution({
        dispatchId,
        approvalRequestId,
        actionDigest: approvedAction.actionDigest,
        owner: EXECUTION_OWNER,
        leaseToken: consumptionId,
        expectedVersion: executionSnapshot.execution.version,
        startedAtMs: executionNowMs,
      });
    }
    const sessionResult = await options.tokenRequestSession.withDelivery(
      async ({ delivery, evidence: tokenRequest }) => {
        const issuer = createRecoverableWorkerCredentialIssuer(
          authority,
          delivery,
          options.workerCredentialPepper,
          {
            now,
            ...(options.randomBytes
              ? { randomBytes: options.randomBytes }
              : {}),
          },
        );
        const result = await issuer.issue({
          mutationId: plan.target.deliveryId,
          requestId: approvalRequestId,
          expectedCurrentVersion: 0,
          credentialId: plan.target.credentialId,
          workerId: plan.target.workerId,
          principal: executorPrincipal(currentTime(now)),
          notBeforeAtMs: plan.target.credentialNotBeforeAtMs,
          expiresAtMs: plan.target.credentialExpiresAtMs,
          previousCredentialId: plan.target.previousCredentialId,
          deploymentTargetDigest: plan.target.deploymentTargetDigest,
          deploymentGeneration: plan.target.deploymentGeneration,
        });
        return Object.freeze({ result, tokenRequest });
      },
    );
    const completed = await executions.completeExecution({
      dispatchId,
      owner: EXECUTION_OWNER,
      leaseToken: consumptionId,
      expectedVersion: executionSnapshot.execution.version,
      resultMutationId: plan.target.deliveryId,
      outcome: 'succeeded',
      resultCode: EXECUTION_RESULT_CODE,
      resultDigest: executionResultDigest(plan, sessionResult.result),
      completedAtMs: currentTime(now),
    });
    run = Object.freeze({
      database: evidence,
      approval: dispatch,
      execution: completed.execution,
      result: sessionResult.result,
      tokenRequest: sessionResult.tokenRequest,
    });
  } catch (error) {
    failure = error;
  }
  await closeDatabase(database, failure);
  if (!run) {
    throw new WorkerCredentialManagementUnavailableError();
  }
  return run;
}
