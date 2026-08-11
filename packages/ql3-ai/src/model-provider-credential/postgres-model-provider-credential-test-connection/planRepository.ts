import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

import {
  InvalidModelProviderCredentialTestConnectionError,
  normalizeModelProviderCredentialTestPlan,
  type ModelProviderCredentialTestPlan,
} from '../modelProviderCredentialTestConnection';
import {
  MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_OPERATION_ID,
  ModelProviderCredentialTestPlanAuthorizationFenceConflictError,
  ModelProviderCredentialTestPlanConflictError,
  ModelProviderCredentialTestPlanQuotaExceededError,
  ModelProviderCredentialTestPlanUnavailableError,
  type AuthorizedModelProviderCredentialTestPlan,
  type CreateModelProviderCredentialTestPlanResult,
  type ModelProviderCredentialTestPlanRepository,
  type PostgresModelProviderCredentialTestPlanOptions,
} from './contracts';
import {
  UUID_V4_PATTERN,
  exact,
  integer,
  options,
  rollback,
  sqlState,
  text,
  type Row,
} from './common';

function normalizeAuthorized(
  value: AuthorizedModelProviderCredentialTestPlan,
): Readonly<AuthorizedModelProviderCredentialTestPlan> {
  exact(value, ['audit', 'plan']);
  try {
    const plan = normalizeModelProviderCredentialTestPlan(value.plan);
    const audit = normalizeSecurityAuditRecord(value.audit);
    if (
      audit.eventId !== plan.testId ||
      audit.requestId !== plan.requestId ||
      audit.operationId !== MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_OPERATION_ID ||
      audit.projectId !== plan.projectId ||
      audit.outcome !== 'allowed' ||
      audit.subject?.type !== 'user' ||
      audit.subject.id !== plan.requestedBy.id ||
      audit.authenticationId === null ||
      audit.fence?.projectVersion !== plan.fence.projectVersion ||
      audit.fence.bindingVersion !== plan.fence.bindingVersion
    ) {
      throw new InvalidModelProviderCredentialTestConnectionError();
    }
    return Object.freeze({ plan, audit });
  } catch (error) {
    if (error instanceof InvalidModelProviderCredentialTestConnectionError) {
      throw error;
    }
    throw new InvalidModelProviderCredentialTestConnectionError();
  }
}

function normalizeAuditRow(row: Row): Readonly<SecurityAuditRecord> {
  if (!Array.isArray(row.reasons)) {
    throw new ModelProviderCredentialTestPlanUnavailableError();
  }
  try {
    return normalizeSecurityAuditRecord({
      eventId: text(row.eventId, UUID_V4_PATTERN),
      requestId: text(row.requestId),
      operationId: text(row.operationId),
      projectId: text(row.projectId),
      subject: {
        type: text(row.subjectType) as 'user',
        id: text(row.subjectId),
      },
      authenticationId: text(row.authenticationId),
      outcome: text(row.outcome) as SecurityAuditRecord['outcome'],
      reasons: row.reasons as string[],
      fence: {
        projectVersion: integer(row.projectVersion, 1),
        bindingVersion: integer(row.bindingVersion, 1),
      },
      occurredAtMs: integer(row.occurredAtMs),
    });
  } catch (error) {
    if (error instanceof ModelProviderCredentialTestPlanUnavailableError) {
      throw error;
    }
    throw new ModelProviderCredentialTestPlanUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function semanticAuditEqual(
  left: Readonly<SecurityAuditRecord>,
  right: Readonly<SecurityAuditRecord>,
): boolean {
  const { occurredAtMs: _leftTime, ...leftSemantic } = left;
  const { occurredAtMs: _rightTime, ...rightSemantic } = right;
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
}

function samePlan(
  left: Readonly<ModelProviderCredentialTestPlan>,
  right: Readonly<ModelProviderCredentialTestPlan>,
): boolean {
  const {
    planDigest: _leftPlanDigest,
    plannedAtMs: leftPlannedAtMs,
    expiresAtMs: leftExpiresAtMs,
    ...leftIdentity
  } = left;
  const {
    planDigest: _rightPlanDigest,
    plannedAtMs: rightPlannedAtMs,
    expiresAtMs: rightExpiresAtMs,
    ...rightIdentity
  } = right;
  return (
    leftExpiresAtMs - leftPlannedAtMs === rightExpiresAtMs - rightPlannedAtMs &&
    JSON.stringify(leftIdentity) === JSON.stringify(rightIdentity)
  );
}

function mapError(error: unknown): Error {
  if (
    error instanceof InvalidModelProviderCredentialTestConnectionError ||
    error instanceof
      ModelProviderCredentialTestPlanAuthorizationFenceConflictError ||
    error instanceof ModelProviderCredentialTestPlanConflictError ||
    error instanceof ModelProviderCredentialTestPlanQuotaExceededError ||
    error instanceof ModelProviderCredentialTestPlanUnavailableError
  ) {
    return error;
  }
  if (['23503', '23505', '23514', '40001', '40P01'].includes(sqlState(error))) {
    return new ModelProviderCredentialTestPlanConflictError();
  }
  return new ModelProviderCredentialTestPlanUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

async function confirmFence(
  client: PostgresClient,
  value: Readonly<AuthorizedModelProviderCredentialTestPlan>,
): Promise<void> {
  const project = await client.query<Row>(
    `SELECT status, version FROM "ql3"."projects" WHERE id = $1`,
    [value.plan.projectId],
  );
  const binding = await client.query<Row>(
    `SELECT version, state
       FROM "ql3"."project_role_bindings"
      WHERE project_id = $1 AND subject_type = 'user' AND subject_id = $2
      ORDER BY version DESC
      LIMIT 1`,
    [value.plan.projectId, value.plan.requestedBy.id],
  );
  if (
    project.rows.length !== 1 ||
    project.rows[0]?.status !== 'active' ||
    integer(project.rows[0]?.version, 1) !== value.plan.fence.projectVersion ||
    binding.rows.length !== 1 ||
    binding.rows[0]?.state !== 'active' ||
    integer(binding.rows[0]?.version, 1) !== value.plan.fence.bindingVersion
  ) {
    throw new ModelProviderCredentialTestPlanAuthorizationFenceConflictError();
  }
}

async function plansByIdentity(
  client: PostgresClient,
  plan: Readonly<ModelProviderCredentialTestPlan>,
): Promise<readonly Readonly<ModelProviderCredentialTestPlan>[]> {
  const result = await client.query<Row>(
    `SELECT plan_json AS "planJson"
       FROM "ql3_ai"."model_provider_credential_test_plans"
      WHERE test_id = $1::uuid
         OR (project_id = $2 AND request_id = $3)
      LIMIT 3`,
    [plan.testId, plan.projectId, plan.requestId],
  );
  try {
    return Object.freeze(
      result.rows.map((row) =>
        normalizeModelProviderCredentialTestPlan(
          row.planJson as ModelProviderCredentialTestPlan,
        ),
      ),
    );
  } catch (error) {
    throw new ModelProviderCredentialTestPlanUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}

async function auditById(
  client: PostgresClient,
  eventId: string,
): Promise<Readonly<SecurityAuditRecord> | null> {
  const result = await client.query<Row>(
    `SELECT event_id AS "eventId", request_id AS "requestId",
            operation_id AS "operationId", project_id AS "projectId",
            subject_type AS "subjectType", subject_id AS "subjectId",
            authentication_id AS "authenticationId", outcome, reasons,
            project_version AS "projectVersion",
            binding_version AS "bindingVersion",
            occurred_at_ms AS "occurredAtMs"
       FROM "ql3"."security_audit_events"
      WHERE event_id = $1::uuid
      LIMIT 2`,
    [eventId],
  );
  if (result.rows.length > 1) {
    throw new ModelProviderCredentialTestPlanConflictError();
  }
  return result.rows[0] ? normalizeAuditRow(result.rows[0]) : null;
}

async function quotaHasReceipt(
  client: PostgresClient,
  plan: Readonly<ModelProviderCredentialTestPlan>,
): Promise<boolean> {
  const result = await client.query<Row>(
    `SELECT receipt_ids ? $3::text AS "hasReceipt"
       FROM "ql3_ai"."model_provider_credential_test_quota_buckets"
      WHERE project_id = $1 AND subject_id = $2`,
    [plan.projectId, plan.requestedBy.id, plan.testId],
  );
  return result.rows.length === 1 && result.rows[0]?.hasReceipt === true;
}

async function consumeQuota(
  client: PostgresClient,
  plan: Readonly<ModelProviderCredentialTestPlan>,
  quotaWindowMs: number,
  quotaLimit: number,
): Promise<void> {
  let result = await client.query<Row>(
    `WITH database_clock AS (
       SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                AS now_ms
     )
     INSERT INTO "ql3_ai"."model_provider_credential_test_quota_buckets" (
       project_id, subject_id, window_started_at_ms, consumed_count,
       receipt_ids, updated_at_ms
     )
     SELECT $1, $2, (now_ms / $4::bigint) * $4::bigint, 1,
            jsonb_build_array($3::text), now_ms
       FROM database_clock
     ON CONFLICT (project_id, subject_id)
     DO UPDATE SET
       window_started_at_ms = CASE
         WHEN model_provider_credential_test_quota_buckets.window_started_at_ms
                + $4::bigint <= EXCLUDED.updated_at_ms
         THEN (EXCLUDED.updated_at_ms / $4::bigint) * $4::bigint
         ELSE model_provider_credential_test_quota_buckets.window_started_at_ms
       END,
       consumed_count = CASE
         WHEN model_provider_credential_test_quota_buckets.window_started_at_ms
                + $4::bigint <= EXCLUDED.updated_at_ms THEN 1
         WHEN model_provider_credential_test_quota_buckets.receipt_ids ? $3::text
         THEN model_provider_credential_test_quota_buckets.consumed_count
         ELSE model_provider_credential_test_quota_buckets.consumed_count + 1
       END,
       receipt_ids = CASE
         WHEN model_provider_credential_test_quota_buckets.window_started_at_ms
                + $4::bigint <= EXCLUDED.updated_at_ms
         THEN jsonb_build_array($3::text)
         WHEN model_provider_credential_test_quota_buckets.receipt_ids ? $3::text
         THEN model_provider_credential_test_quota_buckets.receipt_ids
         ELSE model_provider_credential_test_quota_buckets.receipt_ids ||
              jsonb_build_array($3::text)
       END,
       updated_at_ms = EXCLUDED.updated_at_ms
     WHERE model_provider_credential_test_quota_buckets.window_started_at_ms
             + $4::bigint <= EXCLUDED.updated_at_ms
        OR model_provider_credential_test_quota_buckets.receipt_ids ? $3::text
        OR model_provider_credential_test_quota_buckets.consumed_count < $5
     RETURNING consumed_count AS "consumedCount",
               window_started_at_ms + $4::bigint AS "resetAtMs",
               updated_at_ms AS "observedAtMs"`,
    [
      plan.projectId,
      plan.requestedBy.id,
      plan.testId,
      quotaWindowMs,
      quotaLimit,
    ],
  );
  if (result.rows.length === 0) {
    result = await client.query<Row>(
      `WITH database_clock AS (
         SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                  AS now_ms
       )
       SELECT consumed_count AS "consumedCount",
              window_started_at_ms + $3::bigint AS "resetAtMs",
              database_clock.now_ms AS "observedAtMs"
         FROM "ql3_ai"."model_provider_credential_test_quota_buckets"
         CROSS JOIN database_clock
        WHERE project_id = $1 AND subject_id = $2
        LIMIT 2`,
      [plan.projectId, plan.requestedBy.id, quotaWindowMs],
    );
    if (result.rows.length !== 1) {
      throw new ModelProviderCredentialTestPlanUnavailableError();
    }
    const retryAfterMs = Math.max(
      1,
      integer(result.rows[0]?.resetAtMs) -
        integer(result.rows[0]?.observedAtMs),
    );
    throw new ModelProviderCredentialTestPlanQuotaExceededError(retryAfterMs);
  }
  if (
    result.rows.length !== 1 ||
    integer(result.rows[0]?.consumedCount, 1) > quotaLimit
  ) {
    throw new ModelProviderCredentialTestPlanUnavailableError();
  }
}

async function insertPlan(
  client: PostgresClient,
  plan: Readonly<ModelProviderCredentialTestPlan>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3_ai"."model_provider_credential_test_plans" (
       test_id, request_id, project_id, provider, adapter, base_url,
       endpoint_revision, endpoint_config_digest, deadline_ms,
       max_response_bytes, max_models, max_cost_microusd, retry_limit,
       requested_by_type, requested_by_id, project_version, binding_version,
       planned_at_ms, expires_at_ms, plan_digest, plan_json
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb
     )`,
    [
      plan.testId,
      plan.requestId,
      plan.projectId,
      plan.provider,
      plan.endpoint.adapter,
      plan.endpoint.baseUrl,
      plan.endpoint.revision,
      plan.endpoint.configDigest,
      plan.endpoint.deadlineMs,
      plan.endpoint.maxResponseBytes,
      plan.endpoint.maxModels,
      plan.endpoint.maxCostMicrousd,
      plan.endpoint.retryLimit,
      plan.requestedBy.type,
      plan.requestedBy.id,
      plan.fence.projectVersion,
      plan.fence.bindingVersion,
      plan.plannedAtMs,
      plan.expiresAtMs,
      plan.planDigest,
      JSON.stringify(plan),
    ],
  );
}

async function insertAudit(
  client: PostgresClient,
  audit: Readonly<SecurityAuditRecord>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3"."security_audit_events" (
       event_id, request_id, operation_id, project_id, subject_type,
       subject_id, authentication_id, outcome, reasons, project_version,
       binding_version, occurred_at_ms
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
    [
      audit.eventId,
      audit.requestId,
      audit.operationId,
      audit.projectId,
      audit.subject?.type ?? null,
      audit.subject?.id ?? null,
      audit.authenticationId,
      audit.outcome,
      JSON.stringify(audit.reasons),
      audit.fence?.projectVersion ?? null,
      audit.fence?.bindingVersion ?? null,
      audit.occurredAtMs,
    ],
  );
}

export class PostgresModelProviderCredentialTestPlanRepository
  implements ModelProviderCredentialTestPlanRepository
{
  readonly #quotaWindowMs: number;
  readonly #quotaLimit: number;

  constructor(
    private readonly pool: PostgresPool,
    optionValue?: PostgresModelProviderCredentialTestPlanOptions,
  ) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError(
        'PostgreSQL model provider credential test plan pool is invalid',
      );
    }
    const reviewed = options(optionValue);
    this.#quotaWindowMs = reviewed.quotaWindowMs;
    this.#quotaLimit = reviewed.quotaLimit;
  }

  async createAuthorized(
    value: AuthorizedModelProviderCredentialTestPlan,
  ): Promise<Readonly<CreateModelProviderCredentialTestPlanResult>> {
    const authorized = normalizeAuthorized(value);
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new ModelProviderCredentialTestPlanUnavailableError({
        cause: error,
      });
    }
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          JSON.stringify([
            authorized.plan.projectId,
            'model-provider-credential-test-plan',
            authorized.plan.requestedBy.id,
          ]),
        ],
      );
      await confirmFence(client, authorized);
      const storedPlans = await plansByIdentity(client, authorized.plan);
      const storedAudit = await auditById(client, authorized.audit.eventId);
      if (storedPlans.length > 0 || storedAudit) {
        if (
          storedPlans.length !== 1 ||
          !samePlan(storedPlans[0]!, authorized.plan) ||
          !storedAudit ||
          !semanticAuditEqual(storedAudit, authorized.audit) ||
          !(await quotaHasReceipt(client, authorized.plan))
        ) {
          throw new ModelProviderCredentialTestPlanConflictError();
        }
        await client.query('COMMIT');
        return Object.freeze({
          status: 'existing' as const,
          plan: storedPlans[0]!,
        });
      }
      await consumeQuota(
        client,
        authorized.plan,
        this.#quotaWindowMs,
        this.#quotaLimit,
      );
      await insertPlan(client, authorized.plan);
      await insertAudit(client, authorized.audit);
      await client.query('COMMIT');
      return Object.freeze({
        status: 'created' as const,
        plan: authorized.plan,
      });
    } catch (error) {
      await rollback(client);
      throw mapError(error);
    } finally {
      client.release();
    }
  }
}
