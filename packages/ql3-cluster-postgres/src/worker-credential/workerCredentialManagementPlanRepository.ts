// PostgreSQL Worker Credential management plans are owned by this domain.
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  InvalidWorkerCredentialManagementPlanError,
  WorkerCredentialManagementPlanConflictError,
  WorkerCredentialManagementPlanUnavailableError,
  normalizeWorkerCredentialManagementPlan,
  type CreateWorkerCredentialManagementPlanResult,
  type WorkerCredentialManagementPlan,
  type WorkerCredentialManagementPlanRepository,
} from '@qinglong/runtime-core/worker-credential-management-plan';

import {
  postgresRequiredJsonObject,
  postgresSqlState,
} from '../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;

function unavailable(
  cause?: unknown,
): WorkerCredentialManagementPlanUnavailableError {
  return new WorkerCredentialManagementPlanUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidWorkerCredentialManagementPlanError ||
    error instanceof WorkerCredentialManagementPlanConflictError ||
    error instanceof WorkerCredentialManagementPlanUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new WorkerCredentialManagementPlanConflictError(
      'plan identity or authority target is already bound',
    );
  }
  return unavailable(error);
}

function same(
  left: Readonly<WorkerCredentialManagementPlan>,
  right: Readonly<WorkerCredentialManagementPlan>,
): boolean {
  const semanticFields = (value: Readonly<WorkerCredentialManagementPlan>) => ({
    actionRef: value.actionRef,
    authorityProjectId: value.authorityProjectId,
    action: value.action,
    target: value.target,
    requestedBy: value.requestedBy,
  });
  return JSON.stringify(semanticFields(left)) === JSON.stringify(semanticFields(right));
}

function normalizeRow(row: Row): Readonly<WorkerCredentialManagementPlan> {
  try {
    return normalizeWorkerCredentialManagementPlan(
      postgresRequiredJsonObject(
        row.planJson,
        unavailable,
      ) as unknown as WorkerCredentialManagementPlan,
    );
  } catch (error) {
    throw unavailable(error);
  }
}

function validateActionRef(value: string): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    throw new InvalidWorkerCredentialManagementPlanError(
      'actionRef is invalid',
    );
  }
  return value;
}

export class PostgresWorkerCredentialManagementPlanReader {
  constructor(protected readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool !== 'object' ||
      typeof pool.query !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Worker credential management plan reader is invalid',
      );
    }
  }

  async findByActionRef(
    actionRef: string,
  ): Promise<Readonly<WorkerCredentialManagementPlan> | null> {
    validateActionRef(actionRef);
    try {
      const result = await this.pool.query<Row>(
        `SELECT plan_json AS "planJson"
         FROM "ql3"."worker_credential_management_plans"
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

export class PostgresWorkerCredentialManagementPlanRepository
  extends PostgresWorkerCredentialManagementPlanReader
  implements WorkerCredentialManagementPlanRepository
{
  async create(
    planValue: Readonly<WorkerCredentialManagementPlan>,
  ): Promise<Readonly<CreateWorkerCredentialManagementPlanResult>> {
    const plan = normalizeWorkerCredentialManagementPlan(planValue);
    try {
      const inserted = await this.pool.query<Row>(
        `INSERT INTO "ql3"."worker_credential_management_plans" (
           action_ref, authority_project_id, action, delivery_id, worker_id,
           credential_id, previous_credential_id,
           credential_not_before_at_ms, credential_expires_at_ms,
           deployment_target_digest, deployment_generation,
           requested_by_type, requested_by_id, planned_at_ms, expires_at_ms,
           plan_digest, preview_digest, plan_json
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18::jsonb
         )
         ON CONFLICT DO NOTHING
         RETURNING action_ref AS "actionRef"`,
        [
          plan.actionRef,
          plan.authorityProjectId,
          plan.action,
          plan.target.deliveryId,
          plan.target.workerId,
          plan.target.credentialId,
          plan.target.previousCredentialId,
          plan.target.credentialNotBeforeAtMs,
          plan.target.credentialExpiresAtMs,
          plan.target.deploymentTargetDigest,
          plan.target.deploymentGeneration,
          plan.requestedBy.type,
          plan.requestedBy.id,
          plan.plannedAtMs,
          plan.expiresAtMs,
          plan.planDigest,
          plan.previewDigest,
          JSON.stringify(plan),
        ],
      );
      const stored = await this.findByActionRef(plan.actionRef);
      if (!stored || !same(stored, plan)) {
        throw new WorkerCredentialManagementPlanConflictError(
          'plan identity is already bound to another operation',
        );
      }
      return Object.freeze({
        status:
          inserted.rows.length === 1
            ? ('created' as const)
            : ('existing' as const),
        plan: stored,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}
