import {
  ClusterLegacyEnvMigrationPlanConflictError,
  ClusterLegacyEnvMigrationPlanUnavailableError,
  assertClusterLegacyEnvMigrationPlanIdentifier,
  clusterLegacyEnvMigrationPlanMatchesIntent,
  createClusterLegacyEnvMigrationPlan,
  normalizeClusterLegacyEnvMigrationPlan,
  normalizeClusterLegacyEnvMigrationPlanIntent,
  type ClusterLegacyEnvMigrationPlan,
  type ClusterLegacyEnvMigrationPlanIntent,
  type ClusterLegacyEnvMigrationPlanRepository,
} from '@qinglong/runtime-core/cluster-legacy-env-migration-plan';
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

export interface PostgresClusterLegacyEnvMigrationPlanTransactionContext {
  readonly intent: Readonly<ClusterLegacyEnvMigrationPlanIntent>;
  readonly replay: Readonly<ClusterLegacyEnvMigrationPlan> | null;
  readonly plan: Readonly<ClusterLegacyEnvMigrationPlan>;
}

export type PostgresClusterLegacyEnvMigrationPlanTransactionHook = (
  client: PostgresClient,
  context: Readonly<PostgresClusterLegacyEnvMigrationPlanTransactionContext>,
) => Promise<void>;

function unavailable(): ClusterLegacyEnvMigrationPlanUnavailableError {
  return new ClusterLegacyEnvMigrationPlanUnavailableError();
}

function planFromRow(row: Row): Readonly<ClusterLegacyEnvMigrationPlan> {
  try {
    return normalizeClusterLegacyEnvMigrationPlan(
      postgresRequiredJsonObject(
        row.planJson,
        unavailable,
      ) as unknown as ClusterLegacyEnvMigrationPlan,
    );
  } catch (error) {
    if (error instanceof ClusterLegacyEnvMigrationPlanUnavailableError) {
      throw error;
    }
    throw unavailable();
  }
}

async function findByPlanId(
  queryable: Queryable,
  planId: string,
): Promise<Readonly<ClusterLegacyEnvMigrationPlan> | null> {
  const result = await queryable.query<Row>(
    `SELECT plan_json AS "planJson"
       FROM "ql3"."cluster_legacy_env_migration_plans"
      WHERE plan_id = $1
      LIMIT 2`,
    [planId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  const plan = planFromRow(result.rows[0]!);
  if (plan.planId !== planId) throw unavailable();
  return plan;
}

async function findByMutationId(
  queryable: Queryable,
  mutationId: string,
): Promise<Readonly<ClusterLegacyEnvMigrationPlan> | null> {
  const result = await queryable.query<Row>(
    `SELECT plan_json AS "planJson"
       FROM "ql3"."cluster_legacy_env_migration_plans"
      WHERE mutation_id = $1
      LIMIT 2`,
    [mutationId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  const plan = planFromRow(result.rows[0]!);
  if (plan.mutationId !== mutationId) throw unavailable();
  return plan;
}

function mappedError(error: unknown): Error {
  if (
    error instanceof ClusterLegacyEnvMigrationPlanConflictError ||
    error instanceof ClusterLegacyEnvMigrationPlanUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new ClusterLegacyEnvMigrationPlanConflictError();
  }
  return unavailable();
}

/**
 * Automation-manager-only append authority for content-free Cluster Legacy Env
 * migration plans. It does not materialize Secrets or mutate Task/Trigger heads.
 */
export class PostgresClusterLegacyEnvMigrationPlanRepository
  implements ClusterLegacyEnvMigrationPlanRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Cluster Legacy Env migration pool is invalid',
      );
    }
  }

  async findByPlanId(
    planIdValue: string,
  ): Promise<Readonly<ClusterLegacyEnvMigrationPlan> | null> {
    const planId = assertClusterLegacyEnvMigrationPlanIdentifier(
      planIdValue,
      'planId',
    );
    try {
      return await findByPlanId(this.pool, planId);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async publish(
    intentValue: Readonly<ClusterLegacyEnvMigrationPlanIntent>,
    transactionHook?: PostgresClusterLegacyEnvMigrationPlanTransactionHook,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      plan: Readonly<ClusterLegacyEnvMigrationPlan>;
    }>
  > {
    if (
      transactionHook !== undefined &&
      typeof transactionHook !== 'function'
    ) {
      throw new TypeError(
        'Cluster Legacy Env migration transaction hook is invalid',
      );
    }
    const intent = normalizeClusterLegacyEnvMigrationPlanIntent(intentValue);

    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch {
        throw unavailable();
      }
      let began = false;
      let transactionHookError: unknown;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;

        const replay = await findByMutationId(client, intent.mutationId);
        if (replay) {
          if (!clusterLegacyEnvMigrationPlanMatchesIntent(replay, intent)) {
            throw new ClusterLegacyEnvMigrationPlanConflictError();
          }
          if (transactionHook) {
            try {
              const hookResult = await transactionHook(
                client,
                Object.freeze({ intent, replay, plan: replay }),
              );
              if (hookResult !== undefined) {
                throw new TypeError(
                  'Cluster Legacy Env migration transaction hook must not return a value',
                );
              }
            } catch (error) {
              transactionHookError = error;
              throw error;
            }
          }
          await client.query('COMMIT');
          began = false;
          return Object.freeze({ status: 'existing', plan: replay });
        }

        const project = await client.query<{ status: unknown }>(
          `SELECT status
             FROM "ql3"."projects"
            WHERE id = $1`,
          [intent.projectId],
        );
        if (project.rows.length !== 1 || project.rows[0]?.status !== 'active') {
          throw new ClusterLegacyEnvMigrationPlanConflictError();
        }

        const occupied = await findByPlanId(client, intent.planId);
        if (occupied) throw new ClusterLegacyEnvMigrationPlanConflictError();

        const clock = await client.query<{ plannedAtMs: unknown }>(
          `SELECT floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint AS "plannedAtMs"`,
        );
        if (clock.rows.length !== 1) throw unavailable();
        const plan = createClusterLegacyEnvMigrationPlan(
          intent,
          postgresRequiredInteger(clock.rows[0]?.plannedAtMs, unavailable),
        );

        await client.query(
          `INSERT INTO "ql3"."cluster_legacy_env_migration_plans" (
             plan_id, mutation_id, project_id, plan_digest,
             reconciliation_bundle_digest, decision_digest,
             candidate_set_digest, source_row_count, active_row_count,
             disabled_row_count, effective_binding_count, secret_ref,
             task_revision_set_digest, trigger_revision_set_digest,
             task_count, trigger_count, total_effective_bytes,
             planned_at_ms, plan_json
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb
           )`,
          [
            plan.planId,
            plan.mutationId,
            plan.projectId,
            plan.planDigest,
            plan.source.reconciliationBundleDigest,
            plan.source.decisionDigest,
            plan.source.candidateSetDigest,
            plan.source.sourceRowCount,
            plan.source.activeRowCount,
            plan.source.disabledRowCount,
            plan.source.effectiveBindingCount,
            plan.target.secretRef,
            plan.target.taskRevisionSetDigest,
            plan.target.triggerRevisionSetDigest,
            plan.target.taskCount,
            plan.target.triggerCount,
            plan.target.totalEffectiveBytes,
            plan.plannedAtMs,
            JSON.stringify(plan),
          ],
        );

        if (transactionHook) {
          try {
            const hookResult = await transactionHook(
              client,
              Object.freeze({ intent, replay: null, plan }),
            );
            if (hookResult !== undefined) {
              throw new TypeError(
                'Cluster Legacy Env migration transaction hook must not return a value',
              );
            }
          } catch (error) {
            transactionHookError = error;
            throw error;
          }
        }
        await client.query('COMMIT');
        began = false;
        return Object.freeze({ status: 'created', plan });
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
        if (error === transactionHookError && error instanceof Error) {
          throw error;
        }
        throw mappedError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
