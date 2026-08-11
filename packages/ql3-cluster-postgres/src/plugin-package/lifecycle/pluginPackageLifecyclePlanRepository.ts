// PostgreSQL adapter owned by the Plugin Package lifecycle capability.
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  InvalidPluginPackageLifecyclePlanError,
  PluginPackageLifecyclePlanConflictError,
  PluginPackageLifecyclePlanUnavailableError,
  normalizePluginPackageLifecyclePlan,
  type CreatePluginPackageLifecyclePlanResult,
  type PluginPackageLifecyclePlan,
  type PluginPackageLifecyclePlanRepository,
} from '@qinglong/runtime-core/plugin-package-lifecycle-plan';

import {
  postgresRequiredJsonObject,
  postgresSqlState,
} from '../../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;

function unavailable(
  cause?: unknown,
): PluginPackageLifecyclePlanUnavailableError {
  return new PluginPackageLifecyclePlanUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageLifecyclePlanError ||
    error instanceof PluginPackageLifecyclePlanConflictError ||
    error instanceof PluginPackageLifecyclePlanUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackageLifecyclePlanConflictError(
      'plan identity or target is already bound',
    );
  }
  return unavailable(error);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeRow(row: Row): Readonly<PluginPackageLifecyclePlan> {
  try {
    return normalizePluginPackageLifecyclePlan(
      postgresRequiredJsonObject(
        row.planJson,
        unavailable,
      ) as unknown as PluginPackageLifecyclePlan,
    );
  } catch (error) {
    throw unavailable(error);
  }
}

function validateActionRef(value: string): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    throw new InvalidPluginPackageLifecyclePlanError(
      'actionRef is invalid',
    );
  }
  return value;
}

export class PostgresPluginPackageLifecyclePlanReader {
  constructor(protected readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool !== 'object' ||
      typeof pool.query !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Plugin Package lifecycle plan reader is invalid',
      );
    }
  }

  async findByActionRef(
    actionRef: string,
  ): Promise<Readonly<PluginPackageLifecyclePlan> | null> {
    validateActionRef(actionRef);
    try {
      const result = await this.pool.query<Row>(
        `SELECT plan_json AS "planJson"
         FROM "ql3"."plugin_package_lifecycle_plans"
         WHERE action_ref = $1
         LIMIT 2`,
        [actionRef],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw unavailable();
      const plan = normalizeRow(result.rows[0]!);
      if (plan.actionRef !== actionRef) throw unavailable();
      return plan;
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}

export class PostgresPluginPackageLifecyclePlanRepository
  extends PostgresPluginPackageLifecyclePlanReader
  implements PluginPackageLifecyclePlanRepository
{
  async create(
    planValue: Readonly<PluginPackageLifecyclePlan>,
  ): Promise<Readonly<CreatePluginPackageLifecyclePlanResult>> {
    const plan = normalizePluginPackageLifecyclePlan(planValue);
    try {
      const inserted = await this.pool.query<Row>(
        `INSERT INTO "ql3"."plugin_package_lifecycle_plans" (
           action_ref, plan_digest, action, project_id, package_name,
           installation_id, lock_digest, impact_digest, requested_by_type,
           requested_by_id, planned_at_ms, expires_at_ms, plan_json
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb
         )
         ON CONFLICT DO NOTHING
         RETURNING action_ref AS "actionRef"`,
        [
          plan.actionRef,
          plan.planDigest,
          plan.impact.action,
          plan.impact.target.projectId,
          plan.impact.target.packageName,
          plan.impact.target.installationId,
          plan.impact.target.lockDigest,
          plan.impact.impactDigest,
          plan.requestedBy.type,
          plan.requestedBy.id,
          plan.plannedAtMs,
          plan.expiresAtMs,
          JSON.stringify(plan),
        ],
      );
      const stored = await this.findByActionRef(plan.actionRef);
      if (!stored || !same(stored, plan)) {
        throw new PluginPackageLifecyclePlanConflictError(
          'plan identity is already bound to another impact',
        );
      }
      return Object.freeze({
        status:
          inserted.rows.length === 1 ? ('created' as const) : ('existing' as const),
        plan: stored,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}
