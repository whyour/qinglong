import type {
  PostgresClient,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  normalizeApprovedActionDispatchRecord,
  type ApprovedActionDispatchRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  ApprovedActionExecutionFenceConflictError,
  ApprovedActionExecutionStateConflictError,
  ApprovedActionExecutionUnavailableError,
  approvedActionExecutionEffectiveStatus,
  claimApprovedActionExecution,
  completeApprovedActionExecution,
  createApprovedActionExecution,
  normalizeApprovedActionExecutionCursor,
  normalizeApprovedActionExecutionRecord,
  normalizeApprovedActionExecutionSnapshot,
  releaseApprovedActionExecutionBeforeStart,
  renewApprovedActionExecution,
  startApprovedActionExecution,
  type ApprovedActionExecutionRecord,
  type ApprovedActionExecutionRepository,
  type ApprovedActionExecutionSnapshot,
  type ClaimApprovedActionExecutionCommand,
  type ClaimApprovedActionExecutionResult,
  type CompleteApprovedActionExecutionCommand,
  type ListDueApprovedActionExecutionsQuery,
  type ListDueApprovedActionExecutionsResult,
  type ReleaseApprovedActionExecutionBeforeStartCommand,
  type RenewApprovedActionExecutionCommand,
  type StartApprovedActionExecutionCommand,
} from '@qinglong/runtime-core/approved-action-execution';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

function unavailable(): ApprovedActionExecutionUnavailableError {
  return new ApprovedActionExecutionUnavailableError();
}

function parseExecution(row: Row): Readonly<ApprovedActionExecutionRecord> {
  try {
    const execution = normalizeApprovedActionExecutionRecord(
      postgresRequiredJsonObject(
        row.executionJson,
        unavailable,
      ) as unknown as ApprovedActionExecutionRecord,
    );
    if (
      execution.executionDigest !==
      postgresRequiredString(row.executionDigest, unavailable)
    ) {
      throw unavailable();
    }
    return execution;
  } catch (error) {
    if (error instanceof ApprovedActionExecutionUnavailableError) throw error;
    throw unavailable();
  }
}

function parseDispatch(row: Row): Readonly<ApprovedActionDispatchRecord> {
  try {
    return normalizeApprovedActionDispatchRecord(
      postgresRequiredJsonObject(
        row.dispatchJson,
        unavailable,
      ) as unknown as ApprovedActionDispatchRecord,
    );
  } catch {
    throw unavailable();
  }
}

function mappedError(error: unknown): Error {
  if (
    error instanceof ApprovedActionExecutionFenceConflictError ||
    error instanceof ApprovedActionExecutionStateConflictError ||
    error instanceof ApprovedActionExecutionUnavailableError ||
    (error instanceof Error &&
      error.name.startsWith('ApprovedActionExecution'))
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new ApprovedActionExecutionStateConflictError();
  }
  return new ApprovedActionExecutionUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

function executionValues(
  execution: Readonly<ApprovedActionExecutionRecord>,
): readonly (string | number | null)[] {
  return [
    execution.dispatchId,
    execution.dispatchDigest,
    execution.projectId,
    execution.status,
    execution.version,
    execution.attemptCount,
    execution.maxAttempts,
    execution.eligibleAtMs,
    execution.nextAttemptAtMs,
    execution.leaseOwner,
    execution.leaseToken,
    execution.leaseExpiresAtMs,
    execution.startedAtMs,
    execution.resultMutationId,
    execution.resultCode,
    execution.resultDigest,
    execution.completedAtMs,
    execution.createdAtMs,
    execution.updatedAtMs,
    JSON.stringify(execution),
    execution.executionDigest,
  ];
}

export async function insertPostgresApprovedActionExecutionBaseline(
  client: PostgresClient,
  dispatchValue: ApprovedActionDispatchRecord,
): Promise<Readonly<ApprovedActionExecutionRecord>> {
  const execution = createApprovedActionExecution(dispatchValue);
  const result = await client.query(
    `INSERT INTO "ql3"."approved_action_executions" (
       dispatch_id, dispatch_digest, project_id, status, version,
       attempt_count, max_attempts, eligible_at_ms, next_attempt_at_ms,
       lease_owner, lease_token, lease_expires_at_ms, started_at_ms,
       result_mutation_id, result_code, result_digest, completed_at_ms,
       created_at_ms, updated_at_ms, execution_json, execution_digest
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20::jsonb, $21
     )`,
    executionValues(execution),
  );
  if (result.rowCount !== 1) throw unavailable();
  return execution;
}

export async function findPostgresApprovedActionExecution(
  queryable: Queryable,
  dispatchId: string,
): Promise<Readonly<ApprovedActionExecutionRecord> | null> {
  const result = await queryable.query<Row>(
    `SELECT execution_json AS "executionJson",
            execution_digest AS "executionDigest"
     FROM "ql3"."approved_action_executions"
     WHERE dispatch_id = $1
     LIMIT 2`,
    [dispatchId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return parseExecution(result.rows[0]!);
}

async function loadSnapshot(
  queryable: Queryable,
  dispatchId: string,
  lock = false,
): Promise<Readonly<ApprovedActionExecutionSnapshot> | null> {
  const result = await queryable.query<Row>(
    `SELECT execution.execution_json AS "executionJson",
            execution.execution_digest AS "executionDigest",
            dispatch.dispatch_json AS "dispatchJson"
     FROM "ql3"."approved_action_executions" AS execution
     JOIN "ql3"."approved_action_dispatches" AS dispatch
       ON dispatch.dispatch_id = execution.dispatch_id
     WHERE execution.dispatch_id = $1
     LIMIT 2
     ${lock ? 'FOR UPDATE OF execution' : ''}`,
    [dispatchId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return normalizeApprovedActionExecutionSnapshot({
    dispatch: parseDispatch(result.rows[0]!),
    execution: parseExecution(result.rows[0]!),
  });
}

async function replaceExecution(
  client: PostgresClient,
  previous: Readonly<ApprovedActionExecutionRecord>,
  next: Readonly<ApprovedActionExecutionRecord>,
): Promise<void> {
  const values = executionValues(next);
  const result = await client.query(
    `UPDATE "ql3"."approved_action_executions"
     SET dispatch_digest = $1, project_id = $2, status = $3,
         version = $4, attempt_count = $5, max_attempts = $6,
         eligible_at_ms = $7, next_attempt_at_ms = $8, lease_owner = $9,
         lease_token = $10, lease_expires_at_ms = $11, started_at_ms = $12,
         result_mutation_id = $13, result_code = $14, result_digest = $15,
         completed_at_ms = $16, created_at_ms = $17, updated_at_ms = $18,
         execution_json = $19::jsonb, execution_digest = $20
     WHERE dispatch_id = $21 AND version = $22
       AND execution_digest = $23`,
    [
      ...values.slice(1),
      previous.dispatchId,
      previous.version,
      previous.executionDigest,
    ],
  );
  if (result.rowCount !== 1) {
    throw new ApprovedActionExecutionFenceConflictError();
  }
}

function assertPageSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new ApprovedActionExecutionStateConflictError();
  }
}

function actionTypes(values: readonly string[]): readonly string[] {
  if (
    !Array.isArray(values) ||
    values.length > 64 ||
    values.some(
      (value) =>
        typeof value !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
    ) ||
    new Set(values).size !== values.length
  ) {
    throw new ApprovedActionExecutionStateConflictError();
  }
  return values;
}

export class PostgresApprovedActionExecutionRepository
  implements ApprovedActionExecutionRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL Approved Action execution pool is invalid');
    }
  }

  async #transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        throw mappedError(error);
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const result = await work(client);
        await client.query('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          state &&
          POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) &&
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        throw mappedError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }

  async findExecutionByDispatchId(
    dispatchId: string,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot> | null> {
    try {
      return await loadSnapshot(this.pool, dispatchId);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async listDueExecutions(
    query: ListDueApprovedActionExecutionsQuery,
  ): Promise<ListDueApprovedActionExecutionsResult> {
    assertPageSize(query.limit);
    const handledActionTypes = actionTypes(query.actionTypes);
    if (!Number.isSafeInteger(query.nowMs) || query.nowMs < 0) {
      throw new ApprovedActionExecutionStateConflictError();
    }
    if (handledActionTypes.length === 0) {
      return Object.freeze({ executions: Object.freeze([]), truncated: false });
    }
    const cursor = query.cursor
      ? normalizeApprovedActionExecutionCursor(query.cursor)
      : undefined;
    try {
      const result = await this.pool.query<Row>(
        `SELECT execution.execution_json AS "executionJson",
                execution.execution_digest AS "executionDigest",
                dispatch.dispatch_json AS "dispatchJson"
         FROM "ql3"."approved_action_executions" AS execution
         JOIN "ql3"."approved_action_dispatches" AS dispatch
           ON dispatch.dispatch_id = execution.dispatch_id
         WHERE execution.status IN ('pending','leased','retry_wait')
           AND execution.eligible_at_ms <= $1
           AND dispatch.action_type = ANY($2::varchar[])
           AND (
             $3::varchar IS NULL OR execution.eligible_at_ms > $4 OR
             (
               execution.eligible_at_ms = $4
               AND execution.dispatch_id > $3
             )
           )
         ORDER BY execution.eligible_at_ms, execution.dispatch_id
         LIMIT $5`,
        [
          query.nowMs,
          handledActionTypes,
          cursor?.dispatchId ?? null,
          cursor?.eligibleAtMs ?? 0,
          query.limit + 1,
        ],
      );
      const truncated = result.rows.length > query.limit;
      const rows = truncated
        ? result.rows.slice(0, query.limit)
        : result.rows;
      const executions = rows.map((row) =>
        normalizeApprovedActionExecutionSnapshot({
          dispatch: parseDispatch(row),
          execution: parseExecution(row),
        }),
      );
      const last = executions.at(-1)?.execution;
      return Object.freeze({
        executions: Object.freeze(executions),
        truncated,
        ...(truncated && last?.eligibleAtMs !== null
          ? {
              nextCursor: Object.freeze({
                eligibleAtMs: last!.eligibleAtMs!,
                dispatchId: last!.dispatchId,
              }),
            }
          : {}),
      });
    } catch (error) {
      throw mappedError(error);
    }
  }

  claimExecution(
    command: ClaimApprovedActionExecutionCommand,
  ): Promise<ClaimApprovedActionExecutionResult> {
    return this.#transaction(async (client) => {
      const current = await loadSnapshot(client, command.dispatchId, true);
      if (!current) return Object.freeze({ status: 'not_found' as const });
      const effective = approvedActionExecutionEffectiveStatus(
        current.execution,
        command.nowMs,
      );
      if (
        current.execution.status === 'leased' &&
        current.execution.leaseExpiresAtMs !== null &&
        current.execution.leaseExpiresAtMs <= command.nowMs &&
        current.execution.attemptCount >= current.execution.maxAttempts
      ) {
        return Object.freeze({
          status: 'recovery_required' as const,
          snapshot: current,
        });
      }
      const due =
        current.execution.eligibleAtMs !== null &&
        current.execution.eligibleAtMs <= command.nowMs;
      if (
        effective !== 'pending' &&
        effective !== 'retry_wait' &&
        !(effective === 'leased' && due)
      ) {
        return Object.freeze({ status: effective, snapshot: current });
      }
      if (!due) {
        return Object.freeze({
          status: 'not_due' as const,
          snapshot: current,
        });
      }
      const next = claimApprovedActionExecution(current.execution, {
        owner: command.owner,
        leaseToken: command.leaseToken,
        nowMs: command.nowMs,
        leaseDurationMs: command.leaseDurationMs,
      });
      await replaceExecution(client, current.execution, next);
      return Object.freeze({
        status: 'claimed' as const,
        snapshot: Object.freeze({
          dispatch: current.dispatch,
          execution: next,
        }),
      });
    });
  }

  startExecution(
    command: StartApprovedActionExecutionCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>> {
    return this.#mutate(command.dispatchId, (current) =>
      startApprovedActionExecution(current, command),
    );
  }

  renewExecution(
    command: RenewApprovedActionExecutionCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>> {
    return this.#mutate(command.dispatchId, (current) =>
      renewApprovedActionExecution(current.execution, {
        owner: command.owner,
        leaseToken: command.leaseToken,
        expectedVersion: command.expectedVersion,
        nowMs: command.nowMs,
        leaseDurationMs: command.leaseDurationMs,
      }),
    );
  }

  releaseExecutionBeforeStart(
    command: ReleaseApprovedActionExecutionBeforeStartCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>> {
    return this.#mutate(command.dispatchId, (current) =>
      releaseApprovedActionExecutionBeforeStart(current.execution, {
        owner: command.owner,
        leaseToken: command.leaseToken,
        expectedVersion: command.expectedVersion,
        resultMutationId: command.resultMutationId,
        resultCode: command.resultCode,
        atMs: command.atMs,
        ...(command.retryAtMs === undefined
          ? {}
          : { retryAtMs: command.retryAtMs }),
      }),
    );
  }

  completeExecution(
    command: CompleteApprovedActionExecutionCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>> {
    return this.#mutate(command.dispatchId, (current) =>
      completeApprovedActionExecution(current.execution, {
        owner: command.owner,
        leaseToken: command.leaseToken,
        expectedVersion: command.expectedVersion,
        resultMutationId: command.resultMutationId,
        outcome: command.outcome,
        resultCode: command.resultCode,
        ...(command.resultDigest === undefined
          ? {}
          : { resultDigest: command.resultDigest }),
        completedAtMs: command.completedAtMs,
      }),
    );
  }

  #mutate(
    dispatchId: string,
    transition: (
      current: Readonly<ApprovedActionExecutionSnapshot>,
    ) => Readonly<ApprovedActionExecutionRecord>,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>> {
    return this.#transaction(async (client) => {
      const current = await loadSnapshot(client, dispatchId, true);
      if (!current) throw new ApprovedActionExecutionStateConflictError();
      const next = transition(current);
      await replaceExecution(client, current.execution, next);
      return Object.freeze({
        dispatch: current.dispatch,
        execution: next,
      });
    });
  }
}
