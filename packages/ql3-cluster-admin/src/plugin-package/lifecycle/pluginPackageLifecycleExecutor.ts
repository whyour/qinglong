// Cluster Plugin Package lifecycle boundary; keep execution authority explicit.
import {
  PostgresPluginPackageLifecyclePlanRepository,
  PostgresPluginPackageLifecycleRepository,
  assertPostgresPackageExecutorSchemaReady,
  type PostgresSchemaReadinessReport,
} from '@qinglong/cluster-postgres/package-executor';
import { PostgresApprovalRequestRepository } from '@qinglong/cluster-postgres/approved-action';
import { PostgresProjectPolicyRepository } from '@qinglong/cluster-postgres/project-policy';
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
import {
  createPluginPackageLifecycleEvent,
  pluginPackageLifecycleActionDigest,
  PluginPackageLifecycleConflictError,
  type PluginPackageLifecycleAction,
  type PluginPackageLifecycleReceipt,
} from '@qinglong/runtime-core/plugin-package-lifecycle';
import {
  MAX_PLUGIN_PACKAGE_LIFECYCLE_PLAN_LIFETIME_MS,
  PluginPackageLifecyclePlanConflictError,
  createPluginPackageLifecyclePlan,
  normalizePluginPackageLifecyclePlan,
  type PluginPackageLifecyclePlan,
} from '@qinglong/runtime-core/plugin-package-lifecycle-plan';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLUSTER_LIFECYCLE_CONSUMER = Object.freeze({
  subject: Object.freeze({
    type: 'system' as const,
    id: 'cluster_plugin_package_lifecycle_executor',
  }),
  authenticationId: 'cluster_plugin_package_lifecycle_executor_v1',
});

export interface RunClusterPluginPackageLifecyclePlanOptions {
  readonly openDatabase: OpenPostgresDatabase;
  readonly actionRef: string;
  readonly action: PluginPackageLifecycleAction;
  readonly projectId: string;
  readonly packageName: string;
  readonly requestedBy: SecuritySubject;
  readonly confirmAuthorization: () => void | Promise<void>;
  readonly lifetimeMs?: number;
}

export interface ClusterPluginPackageLifecyclePlanRun {
  readonly database: PostgresSchemaReadinessReport;
  readonly status: 'created' | 'existing';
  readonly plan: Readonly<PluginPackageLifecyclePlan>;
}

export interface RunClusterPluginPackageLifecycleExecutionOptions {
  readonly openDatabase: OpenPostgresDatabase;
  readonly actionRef: string;
  readonly approvalRequestId: string;
  readonly consumptionId: string;
  readonly dispatchId: string;
  readonly auditEventId: string;
  readonly confirmAuthorization: () => void | Promise<void>;
}

export interface ClusterPluginPackageLifecycleExecutionRun {
  readonly database: PostgresSchemaReadinessReport;
  readonly status: 'created' | 'existing';
  readonly receipt: Readonly<PluginPackageLifecycleReceipt>;
}

type Row = Record<string, unknown>;

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function actionRef(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    throw new TypeError('actionRef is invalid');
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function databaseNowMs(pool: PostgresPool): Promise<number> {
  const result = await pool.query<Row>(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       AS "nowMs"`,
  );
  const value = result.rows[0]?.nowMs;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (
    result.rows.length !== 1 ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    throw new Error('PostgreSQL lifecycle clock is unavailable');
  }
  return parsed;
}

function binding(
  plan: Readonly<PluginPackageLifecyclePlan>,
): Readonly<ApprovedActionBinding> {
  return Object.freeze({
    permission: 'package.manage',
    actionType: `plugin_package.lifecycle.${plan.impact.action}`,
    actionRef: plan.actionRef,
    actionDigest: pluginPackageLifecycleActionDigest(plan.impact),
    previewDigest: plan.impact.impactDigest,
  });
}

function audit(
  eventId: string,
  approvalRequestId: string,
  projectId: string,
  fence: Readonly<SecurityPolicyFence>,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  return Object.freeze({
    eventId,
    requestId: approvalRequestId,
    operationId: 'approval.consume',
    projectId,
    subject: CLUSTER_LIFECYCLE_CONSUMER.subject,
    authenticationId: CLUSTER_LIFECYCLE_CONSUMER.authenticationId,
    outcome: 'allowed',
    reasons: Object.freeze(['package_lifecycle_review']),
    fence,
    occurredAtMs,
  });
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
        'Cluster Plugin Package lifecycle failed and PostgreSQL did not close',
      );
    }
    throw closeError;
  }
  if (failure !== undefined) throw failure;
}

export async function runClusterPluginPackageLifecyclePlan(
  options: RunClusterPluginPackageLifecyclePlanOptions,
): Promise<Readonly<ClusterPluginPackageLifecyclePlanRun>> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.openDatabase !== 'function' ||
    typeof options.confirmAuthorization !== 'function' ||
    typeof options.projectId !== 'string' ||
    !PROJECT_ID_PATTERN.test(options.projectId) ||
    typeof options.packageName !== 'string' ||
    !PACKAGE_NAME_PATTERN.test(options.packageName)
  ) {
    throw new TypeError(
      'Cluster Plugin Package lifecycle plan options are invalid',
    );
  }
  const requestedActionRef = actionRef(options.actionRef);
  const lifetimeMs =
    options.lifetimeMs ?? MAX_PLUGIN_PACKAGE_LIFECYCLE_PLAN_LIFETIME_MS;
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1_000 ||
    lifetimeMs > MAX_PLUGIN_PACKAGE_LIFECYCLE_PLAN_LIFETIME_MS
  ) {
    throw new TypeError(
      'Cluster Plugin Package lifecycle plan lifetime is invalid',
    );
  }
  let database: PostgresDatabaseResource | undefined;
  let failure: unknown;
  let result: Readonly<ClusterPluginPackageLifecyclePlanRun> | undefined;
  try {
    await options.confirmAuthorization();
    database = await options.openDatabase();
    const evidence = await assertPostgresPackageExecutorSchemaReady(
      database.pool,
    );
    const lifecycles = new PostgresPluginPackageLifecycleRepository(
      database.pool,
    );
    const plans = new PostgresPluginPackageLifecyclePlanRepository(
      database.pool,
    );
    const existingValue = await plans.findByActionRef(requestedActionRef);
    if (existingValue) {
      const existing = normalizePluginPackageLifecyclePlan(existingValue);
      if (
        existing.impact.action !== options.action ||
        existing.impact.target.projectId !== options.projectId ||
        existing.impact.target.packageName !== options.packageName ||
        !same(existing.requestedBy, options.requestedBy) ||
        existing.expiresAtMs - existing.plannedAtMs !== lifetimeMs
      ) {
        throw new PluginPackageLifecyclePlanConflictError(
          'actionRef is bound to another lifecycle request',
        );
      }
      await options.confirmAuthorization();
      result = Object.freeze({
        database: evidence,
        status: 'existing' as const,
        plan: existing,
      });
    } else {
      const impact = await lifecycles.plan(
        options.action,
        options.projectId,
        options.packageName,
      );
      const plannedAtMs = await databaseNowMs(database.pool);
      const plan = createPluginPackageLifecyclePlan({
        actionRef: requestedActionRef,
        impact,
        requestedBy: options.requestedBy,
        plannedAtMs,
        expiresAtMs: plannedAtMs + lifetimeMs,
      });
      await options.confirmAuthorization();
      const created = await plans.create(plan);
      result = Object.freeze({
        database: evidence,
        status: created.status,
        plan: created.plan,
      });
    }
  } catch (error) {
    failure = error;
  }
  await closeDatabase(database, failure);
  if (!result) {
    throw new Error('Cluster Plugin Package lifecycle plan produced no result');
  }
  return result;
}

export async function runClusterPluginPackageLifecycleExecution(
  options: RunClusterPluginPackageLifecycleExecutionOptions,
): Promise<Readonly<ClusterPluginPackageLifecycleExecutionRun>> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.openDatabase !== 'function' ||
    typeof options.confirmAuthorization !== 'function'
  ) {
    throw new TypeError(
      'Cluster Plugin Package lifecycle execution options are invalid',
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
  let database: PostgresDatabaseResource | undefined;
  let failure: unknown;
  let result: Readonly<ClusterPluginPackageLifecycleExecutionRun> | undefined;
  try {
    await options.confirmAuthorization();
    database = await options.openDatabase();
    const evidence = await assertPostgresPackageExecutorSchemaReady(
      database.pool,
    );
    const plans = new PostgresPluginPackageLifecyclePlanRepository(
      database.pool,
    );
    const planValue = await plans.findByActionRef(requestedActionRef);
    if (!planValue) {
      throw new PluginPackageLifecycleConflictError(
        'durable lifecycle plan is absent',
      );
    }
    const plan = normalizePluginPackageLifecyclePlan(planValue);
    const approvals = new PostgresApprovalRequestRepository(database.pool);
    let approvalValue = await approvals.findById(approvalRequestId);
    if (!approvalValue) {
      throw new PluginPackageLifecycleConflictError(
        'lifecycle approval is absent',
      );
    }
    let approval = normalizeApprovalRequestRecord(approvalValue);
    const approvedAction = binding(plan);
    if (
      approval.projectId !== plan.impact.target.projectId ||
      approval.decisionMode !== 'separation_of_duty' ||
      !same(approval.action, approvedAction) ||
      !same(approval.requestedBy, plan.requestedBy)
    ) {
      throw new PluginPackageLifecycleConflictError(
        'lifecycle approval does not match durable plan',
      );
    }
    let dispatch: Readonly<ApprovedActionDispatchRecord> | null = null;
    if (approval.version === 2 && approval.state === 'approved') {
      const policy = new ProjectPolicyEngine(
        new PostgresProjectPolicyRepository(database.pool),
      );
      const decision = await policy.decide({
        subject: plan.requestedBy,
        projectId: plan.impact.target.projectId,
        permission: 'package.manage',
      });
      if (
        (decision.effect !== 'allow' &&
          decision.effect !== 'require_approval') ||
        decision.fence === null
      ) {
        throw new PluginPackageLifecycleConflictError(
          'lifecycle requester is no longer authorized',
        );
      }
      const consumedAtMs = await databaseNowMs(database.pool);
      const consumed = await approvals.consume({
        requestId: approvalRequestId,
        expectedVersion: 2,
        consumptionId,
        dispatchId,
        action: approvedAction,
        requestedBy: plan.requestedBy,
        consumedBy: CLUSTER_LIFECYCLE_CONSUMER.subject,
        consumedAtMs,
        authorizationFence: decision.fence,
        audit: audit(
          auditEventId,
          approvalRequestId,
          plan.impact.target.projectId,
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
      !same(dispatch.action, approvedAction) ||
      !same(dispatch.requestedBy, plan.requestedBy) ||
      !same(dispatch.approvedBy, approval.decidedBy) ||
      !same(dispatch.consumedBy, CLUSTER_LIFECYCLE_CONSUMER.subject)
    ) {
      throw new PluginPackageLifecycleConflictError(
        'lifecycle dispatch does not match durable approval',
      );
    }
    const lifecycles = new PostgresPluginPackageLifecycleRepository(
      database.pool,
    );
    const event = createPluginPackageLifecycleEvent({
      dispatchId: dispatch.id,
      impact: plan.impact,
      requestedBy: dispatch.requestedBy,
      approvedBy: dispatch.approvedBy,
      authorizationMode: 'separation_of_duty',
      occurredAtMs: dispatch.createdAtMs,
    });
    const existingReceipt = await lifecycles.findByEventDigest(
      event.eventDigest,
    );
    if (existingReceipt) {
      await options.confirmAuthorization();
      result = Object.freeze({
        database: evidence,
        status: 'existing' as const,
        receipt: existingReceipt,
      });
    } else {
      const currentImpact = await lifecycles.plan(
        plan.impact.action,
        plan.impact.target.projectId,
        plan.impact.target.packageName,
      );
      if (!same(currentImpact, plan.impact)) {
        throw new PluginPackageLifecycleConflictError(
          'approved lifecycle impact is stale',
        );
      }
      const transitioned = await lifecycles.transition(
        event,
        options.confirmAuthorization,
      );
      result = Object.freeze({
        database: evidence,
        status: transitioned.status,
        receipt: transitioned.receipt,
      });
    }
  } catch (error) {
    failure = error;
  }
  await closeDatabase(database, failure);
  if (!result) {
    throw new Error(
      'Cluster Plugin Package lifecycle execution produced no result',
    );
  }
  return result;
}
