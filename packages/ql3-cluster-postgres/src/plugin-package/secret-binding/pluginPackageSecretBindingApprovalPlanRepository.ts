import type { PostgresPool } from '@qinglong/runtime-core';
import {
  approvalRequestDigest,
  normalizeApprovalRequestRecord,
  type ApprovalRequestRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  normalizePluginPackageInstallProposal,
  type PluginPackageInstallProposal,
} from '@qinglong/runtime-core/plugin-package-proposal';
import {
  normalizePluginPackageInstallRecord,
  normalizePluginPackageLock,
  type PluginPackageInstallRecord,
  type PluginPackageLock,
} from '@qinglong/runtime-core/plugin-package-install';
import {
  InvalidPluginPackageSecretBindingApprovalPlanError,
  PluginPackageSecretBindingApprovalPlanConflictError,
  PluginPackageSecretBindingApprovalPlanUnavailableError,
  normalizePluginPackageSecretBindingApprovalPlan,
  type CreatePluginPackageSecretBindingApprovalPlanResult,
  type PluginPackageSecretBindingApprovalPlan,
  type PluginPackageSecretBindingApprovalPlanRepository,
} from '@qinglong/runtime-core/plugin-package-secret-binding-approval-plan';

import {
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
} from '../../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;

export interface PostgresPluginPackageSecretBindingPlanningSnapshot {
  readonly record: Readonly<PluginPackageInstallRecord>;
  readonly lock: Readonly<PluginPackageLock>;
  readonly proposal: Readonly<PluginPackageInstallProposal>;
  readonly observedAtMs: number;
}

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;

function unavailable(
  cause?: unknown,
): PluginPackageSecretBindingApprovalPlanUnavailableError {
  return new PluginPackageSecretBindingApprovalPlanUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageSecretBindingApprovalPlanError ||
    error instanceof PluginPackageSecretBindingApprovalPlanConflictError ||
    error instanceof PluginPackageSecretBindingApprovalPlanUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackageSecretBindingApprovalPlanConflictError(
      'plan identity or Package generation is already bound',
    );
  }
  return unavailable(error);
}

function validateActionRef(value: string): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    throw new InvalidPluginPackageSecretBindingApprovalPlanError(
      'actionRef is invalid',
    );
  }
  return value;
}

function normalizeRow(
  row: Row,
): Readonly<PluginPackageSecretBindingApprovalPlan> {
  try {
    return normalizePluginPackageSecretBindingApprovalPlan(
      postgresRequiredJsonObject(
        row.planJson,
        unavailable,
      ) as unknown as PluginPackageSecretBindingApprovalPlan,
    );
  } catch (error) {
    throw unavailable(error);
  }
}

function normalizeApprovalRow(row: Row): Readonly<ApprovalRequestRecord> {
  try {
    const request = normalizeApprovalRequestRecord(
      postgresRequiredJsonObject(
        row.requestJson,
        unavailable,
      ) as unknown as ApprovalRequestRecord,
    );
    if (
      approvalRequestDigest(request) !==
      postgresRequiredString(row.requestDigest, unavailable)
    ) {
      throw unavailable();
    }
    return request;
  } catch (error) {
    throw unavailable(error);
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class PostgresPluginPackageSecretBindingApprovalPlanReader {
  constructor(protected readonly pool: Pick<PostgresPool, 'query'>) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError(
        'PostgreSQL Plugin Package Secret binding approval plan reader is invalid',
      );
    }
  }

  async findByActionRef(
    actionRefValue: string,
  ): Promise<Readonly<PluginPackageSecretBindingApprovalPlan> | null> {
    const actionRef = validateActionRef(actionRefValue);
    try {
      const result = await this.pool.query<Row>(
        `SELECT plan_json AS "planJson"
         FROM "ql3"."plugin_package_secret_binding_approval_plans"
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

  async loadPlanningSnapshot(
    projectIdValue: string,
    packageNameValue: string,
  ): Promise<Readonly<PostgresPluginPackageSecretBindingPlanningSnapshot> | null> {
    if (
      typeof projectIdValue !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectIdValue) ||
      typeof packageNameValue !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(packageNameValue)
    ) {
      throw new InvalidPluginPackageSecretBindingApprovalPlanError(
        'planning target is invalid',
      );
    }
    try {
      const result = await this.pool.query<Row>(
        `SELECT record_json AS "recordJson",
                lock_json AS "lockJson",
                proposal_json AS "proposalJson",
                observed_at_ms AS "observedAtMs"
         FROM "ql3"."plugin_package_secret_binding_planning_snapshot"($1, $2)`,
        [projectIdValue, packageNameValue],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw unavailable();
      const row = result.rows[0]!;
      const record = normalizePluginPackageInstallRecord(
        postgresRequiredJsonObject(
          row.recordJson,
          unavailable,
        ) as unknown as PluginPackageInstallRecord,
      );
      const lock = normalizePluginPackageLock(
        postgresRequiredJsonObject(
          row.lockJson,
          unavailable,
        ) as unknown as PluginPackageLock,
      );
      const proposal = normalizePluginPackageInstallProposal(
        postgresRequiredJsonObject(
          row.proposalJson,
          unavailable,
        ) as unknown as PluginPackageInstallProposal,
      );
      const observedAtMs = postgresRequiredInteger(
        row.observedAtMs,
        unavailable,
      );
      if (
        record.projectId !== projectIdValue ||
        record.packageName !== packageNameValue ||
        record.lockDigest !== lock.lockDigest ||
        proposal.actionDigest !== lock.approval.actionDigest ||
        proposal.previewDigest !== lock.approval.previewDigest ||
        proposal.actionInput.projectId !== projectIdValue ||
        proposal.actionInput.manifest.metadata.name !== packageNameValue ||
        proposal.actionInput.targetGeneration !== record.targetGeneration ||
        proposal.actionInput.source.contentDigest !==
          lock.source.contentDigest ||
        proposal.actionInput.manifest.metadata.version !==
          record.packageVersion ||
        proposal.actionInput.manifest.spec.permissions.secrets.length === 0 ||
        !proposal.actionInput.manifest.spec.permissions.tools.includes(
          'secret.use',
        )
      ) {
        throw unavailable();
      }
      return Object.freeze({ record, lock, proposal, observedAtMs });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async listApprovedRequests(
    limitValue: number,
  ): Promise<readonly Readonly<ApprovalRequestRecord>[]> {
    if (
      !Number.isSafeInteger(limitValue) ||
      limitValue < 1 ||
      limitValue > 64
    ) {
      throw new TypeError('Secret binding approval page limit is invalid');
    }
    try {
      const result = await this.pool.query<Row>(
        `SELECT request.request_json AS "requestJson",
                request.request_digest AS "requestDigest"
         FROM "ql3"."approval_requests" AS request
         JOIN "ql3"."plugin_package_secret_binding_approval_plans" AS plan
           ON plan.action_ref = request.action_ref
         WHERE request.state = 'approved'
           AND request.action_type = 'plugin_package.secret_binding.bind'
         ORDER BY request.updated_at_ms, request.request_id
         LIMIT $1`,
        [limitValue],
      );
      if (result.rows.length > limitValue) throw unavailable();
      return Object.freeze(result.rows.map(normalizeApprovalRow));
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}

export class PostgresPluginPackageSecretBindingApprovalPlanRepository
  extends PostgresPluginPackageSecretBindingApprovalPlanReader
  implements PluginPackageSecretBindingApprovalPlanRepository
{
  async create(
    planValue: Readonly<PluginPackageSecretBindingApprovalPlan>,
  ): Promise<Readonly<CreatePluginPackageSecretBindingApprovalPlanResult>> {
    const plan = normalizePluginPackageSecretBindingApprovalPlan(planValue);
    try {
      const inserted = await this.pool.query<Row>(
        `SELECT "ql3"."create_plugin_package_secret_binding_approval_plan"(
           $1::jsonb
         ) AS status`,
        [JSON.stringify(plan)],
      );
      if (inserted.rows.length !== 1) throw unavailable();
      const status = postgresRequiredString(
        inserted.rows[0]?.status,
        unavailable,
      );
      if (status !== 'created' && status !== 'existing') throw unavailable();
      const stored = await this.findByActionRef(plan.actionRef);
      if (!stored || !same(stored, plan)) {
        throw new PluginPackageSecretBindingApprovalPlanConflictError(
          'actionRef is already bound to another Secret binding plan',
        );
      }
      return Object.freeze({
        status,
        plan: stored,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}
