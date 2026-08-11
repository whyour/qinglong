import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';

import {
  InvalidModelProviderCredentialTestConnectionError,
  createModelProviderCredentialTestExecution,
  normalizeModelProviderCredentialTestAllowlist,
  normalizeModelProviderCredentialTestExecution,
  normalizeModelProviderCredentialTestPlan,
  normalizeModelProviderCredentialTestResult,
  resolveModelProviderCredentialTestEndpoint,
  type ModelProviderCredentialTestAllowlist,
  type ModelProviderCredentialTestExecution,
  type ModelProviderCredentialTestPlan,
  type ModelProviderCredentialTestResult,
} from '../modelProviderCredentialTestConnection';
import {
  ModelProviderCredentialTestExecutionConflictError,
  ModelProviderCredentialTestExecutionRejectedError,
  ModelProviderCredentialTestExecutionUnavailableError,
  type BeginModelProviderCredentialTestExecutionInput,
  type BeginModelProviderCredentialTestExecutionResult,
  type CompleteModelProviderCredentialTestExecutionResult,
  type ModelProviderCredentialTestExecutionRepository,
} from './contracts';
import {
  UUID_V4_PATTERN,
  exact,
  integer,
  rollback,
  sqlState,
  type Row,
} from './common';

function executionError(error: unknown): Error {
  if (
    error instanceof InvalidModelProviderCredentialTestConnectionError ||
    error instanceof ModelProviderCredentialTestExecutionRejectedError ||
    error instanceof ModelProviderCredentialTestExecutionConflictError ||
    error instanceof ModelProviderCredentialTestExecutionUnavailableError
  ) {
    return error;
  }
  if (['23503', '23505', '23514', '40001', '40P01'].includes(sqlState(error))) {
    return new ModelProviderCredentialTestExecutionConflictError();
  }
  return new ModelProviderCredentialTestExecutionUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

function normalizeStoredPlan(
  value: unknown,
): Readonly<ModelProviderCredentialTestPlan> {
  try {
    return normalizeModelProviderCredentialTestPlan(
      value as ModelProviderCredentialTestPlan,
    );
  } catch (error) {
    throw new ModelProviderCredentialTestExecutionUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function normalizeStoredExecution(
  value: unknown,
): Readonly<ModelProviderCredentialTestExecution> {
  try {
    return normalizeModelProviderCredentialTestExecution(
      value as ModelProviderCredentialTestExecution,
    );
  } catch (error) {
    throw new ModelProviderCredentialTestExecutionUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function normalizeStoredResult(
  value: unknown,
): Readonly<ModelProviderCredentialTestResult> {
  try {
    return normalizeModelProviderCredentialTestResult(
      value as ModelProviderCredentialTestResult,
    );
  } catch (error) {
    throw new ModelProviderCredentialTestExecutionUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}

async function loadTestPlan(
  client: PostgresClient,
  testId: string,
): Promise<
  Readonly<{
    plan: Readonly<ModelProviderCredentialTestPlan>;
    observedAtMs: number;
  }>
> {
  const result = await client.query<Row>(
    `WITH database_clock AS (
       SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                AS now_ms
     )
     SELECT plan.plan_json AS "planJson",
            database_clock.now_ms AS "observedAtMs"
       FROM "ql3_ai"."model_provider_credential_test_plans" AS plan
       CROSS JOIN database_clock
      WHERE plan.test_id = $1::uuid
      LIMIT 2`,
    [testId],
  );
  if (result.rows.length !== 1) {
    throw new ModelProviderCredentialTestExecutionRejectedError();
  }
  const plan = normalizeStoredPlan(result.rows[0]?.planJson);
  const observedAtMs = integer(result.rows[0]?.observedAtMs);
  if (plan.testId !== testId || observedAtMs >= plan.expiresAtMs) {
    throw new ModelProviderCredentialTestExecutionRejectedError();
  }
  return Object.freeze({ plan, observedAtMs });
}

function confirmExecutionAllowlist(
  plan: Readonly<ModelProviderCredentialTestPlan>,
  allowlistValue: ModelProviderCredentialTestAllowlist,
): void {
  let selected;
  try {
    const allowlist =
      normalizeModelProviderCredentialTestAllowlist(allowlistValue);
    selected = resolveModelProviderCredentialTestEndpoint(
      allowlist,
      plan.provider,
    );
  } catch {
    throw new ModelProviderCredentialTestExecutionRejectedError();
  }
  if (JSON.stringify(selected) !== JSON.stringify(plan.endpoint)) {
    throw new ModelProviderCredentialTestExecutionRejectedError();
  }
}

async function loadExecutionState(
  client: PostgresClient,
  testId: string,
): Promise<Readonly<{
  execution: Readonly<ModelProviderCredentialTestExecution>;
  result: Readonly<ModelProviderCredentialTestResult> | null;
}> | null> {
  const selected = await client.query<Row>(
    `SELECT execution.execution_json AS "executionJson",
            result.result_json AS "resultJson"
       FROM "ql3_ai"."model_provider_credential_test_executions" AS execution
       LEFT JOIN "ql3_ai"."model_provider_credential_test_results" AS result
         ON result.execution_id = execution.execution_id
      WHERE execution.test_id = $1::uuid
      LIMIT 2`,
    [testId],
  );
  if (selected.rows.length === 0) return null;
  if (selected.rows.length !== 1) {
    throw new ModelProviderCredentialTestExecutionConflictError();
  }
  const execution = normalizeStoredExecution(selected.rows[0]?.executionJson);
  const result =
    selected.rows[0]?.resultJson === null ||
    selected.rows[0]?.resultJson === undefined
      ? null
      : normalizeStoredResult(selected.rows[0]?.resultJson);
  if (
    execution.testId !== testId ||
    (result !== null &&
      (result.testId !== testId ||
        result.executionId !== execution.executionId ||
        result.planDigest !== execution.planDigest))
  ) {
    throw new ModelProviderCredentialTestExecutionConflictError();
  }
  return Object.freeze({ execution, result });
}

async function insertExecution(
  client: PostgresClient,
  execution: Readonly<ModelProviderCredentialTestExecution>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3_ai"."model_provider_credential_test_executions" (
       execution_id, test_id, plan_digest, started_at_ms,
       execution_digest, execution_json
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)`,
    [
      execution.executionId,
      execution.testId,
      execution.planDigest,
      execution.startedAtMs,
      execution.executionDigest,
      JSON.stringify(execution),
    ],
  );
}

async function insertResult(
  client: PostgresClient,
  result: Readonly<ModelProviderCredentialTestResult>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3_ai"."model_provider_credential_test_results" (
       execution_id, test_id, plan_digest, outcome, model_count,
       duration_ms, completed_at_ms, result_digest, result_json
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      result.executionId,
      result.testId,
      result.planDigest,
      result.outcome,
      result.modelCount,
      result.durationMs,
      result.completedAtMs,
      result.resultDigest,
      JSON.stringify(result),
    ],
  );
}

export class PostgresModelProviderCredentialTestExecutionRepository
  implements ModelProviderCredentialTestExecutionRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError(
        'PostgreSQL model provider credential test execution pool is invalid',
      );
    }
  }

  async beginExecution(
    value: BeginModelProviderCredentialTestExecutionInput,
  ): Promise<Readonly<BeginModelProviderCredentialTestExecutionResult>> {
    exact(value, ['allowlist', 'executionId', 'testId']);
    if (
      typeof value.executionId !== 'string' ||
      !UUID_V4_PATTERN.test(value.executionId) ||
      typeof value.testId !== 'string' ||
      !UUID_V4_PATTERN.test(value.testId)
    ) {
      throw new InvalidModelProviderCredentialTestConnectionError();
    }
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new ModelProviderCredentialTestExecutionUnavailableError({
        cause: error,
      });
    }
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          JSON.stringify([
            value.testId,
            'model-provider-credential-test-execution',
          ]),
        ],
      );
      const { plan, observedAtMs } = await loadTestPlan(client, value.testId);
      confirmExecutionAllowlist(plan, value.allowlist);
      const stored = await loadExecutionState(client, value.testId);
      if (stored) {
        if (
          stored.execution.executionId !== value.executionId ||
          stored.execution.planDigest !== plan.planDigest
        ) {
          throw new ModelProviderCredentialTestExecutionConflictError();
        }
        await client.query('COMMIT');
        return Object.freeze({
          status: 'existing' as const,
          plan,
          execution: stored.execution,
          result: stored.result,
        });
      }
      const execution = createModelProviderCredentialTestExecution({
        executionId: value.executionId,
        testId: value.testId,
        planDigest: plan.planDigest,
        startedAtMs: observedAtMs,
      });
      await insertExecution(client, execution);
      await client.query('COMMIT');
      return Object.freeze({
        status: 'created' as const,
        plan,
        execution,
        result: null,
      });
    } catch (error) {
      await rollback(client);
      throw executionError(error);
    } finally {
      client.release();
    }
  }

  async complete(
    value: ModelProviderCredentialTestResult,
  ): Promise<Readonly<CompleteModelProviderCredentialTestExecutionResult>> {
    const candidate = normalizeModelProviderCredentialTestResult(value);
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new ModelProviderCredentialTestExecutionUnavailableError({
        cause: error,
      });
    }
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          JSON.stringify([
            candidate.testId,
            'model-provider-credential-test-execution',
          ]),
        ],
      );
      const stored = await loadExecutionState(client, candidate.testId);
      if (
        !stored ||
        stored.execution.executionId !== candidate.executionId ||
        stored.execution.planDigest !== candidate.planDigest
      ) {
        throw new ModelProviderCredentialTestExecutionConflictError();
      }
      if (stored.result) {
        if (JSON.stringify(stored.result) !== JSON.stringify(candidate)) {
          throw new ModelProviderCredentialTestExecutionConflictError();
        }
        await client.query('COMMIT');
        return Object.freeze({
          status: 'existing' as const,
          result: stored.result,
        });
      }
      await insertResult(client, candidate);
      await client.query('COMMIT');
      return Object.freeze({ status: 'created' as const, result: candidate });
    } catch (error) {
      await rollback(client);
      throw executionError(error);
    } finally {
      client.release();
    }
  }
}
