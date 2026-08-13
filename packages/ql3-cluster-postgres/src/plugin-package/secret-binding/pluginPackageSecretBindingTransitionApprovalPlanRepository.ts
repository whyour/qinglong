import type { PostgresPool } from '@qinglong/runtime-core';
import {
  approvalRequestDigest,
  normalizeApprovalRequestRecord,
  type ApprovalRequestRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  normalizePluginPackageInstallRecord,
  normalizePluginPackageLock,
  type PluginPackageInstallRecord,
  type PluginPackageLock,
} from '@qinglong/runtime-core/plugin-package-install';
import {
  normalizePluginPackageInstallProposal,
  type PluginPackageInstallProposal,
} from '@qinglong/runtime-core/plugin-package-proposal';
import {
  normalizePluginPackageSecretBinding,
  type PluginPackageSecretBinding,
} from '@qinglong/runtime-core/plugin-package-secret-binding';
import {
  InvalidPluginPackageSecretBindingTransitionApprovalPlanError,
  PluginPackageSecretBindingTransitionApprovalPlanConflictError,
  PluginPackageSecretBindingTransitionApprovalPlanUnavailableError,
  normalizePluginPackageSecretBindingTransitionApprovalPlan,
  type CreatePluginPackageSecretBindingTransitionApprovalPlanResult,
  type PluginPackageSecretBindingTransitionApprovalPlan,
  type PluginPackageSecretBindingTransitionApprovalPlanRepository,
} from '@qinglong/runtime-core/plugin-package-secret-binding-transition-approval-plan';

import {
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
} from '../../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;

export interface PostgresPluginPackageSecretBindingTransitionPlanningSnapshot {
  readonly next: Readonly<{
    record: Readonly<PluginPackageInstallRecord>;
    lock: Readonly<PluginPackageLock>;
    proposal: Readonly<PluginPackageInstallProposal>;
  }>;
  readonly previous: Readonly<{
    record: Readonly<PluginPackageInstallRecord>;
    lock: Readonly<PluginPackageLock>;
    proposal: Readonly<PluginPackageInstallProposal>;
    binding: Readonly<PluginPackageSecretBinding> | null;
  }>;
  readonly previousAttemptGeneration: number;
  readonly observedAtMs: number;
}

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function unavailable(
  cause?: unknown,
): PluginPackageSecretBindingTransitionApprovalPlanUnavailableError {
  return new PluginPackageSecretBindingTransitionApprovalPlanUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof
      InvalidPluginPackageSecretBindingTransitionApprovalPlanError ||
    error instanceof
      PluginPackageSecretBindingTransitionApprovalPlanConflictError ||
    error instanceof
      PluginPackageSecretBindingTransitionApprovalPlanUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackageSecretBindingTransitionApprovalPlanConflictError(
      'plan identity or staged generation is already bound',
    );
  }
  return unavailable(error);
}

function validateActionRef(value: string): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    throw new InvalidPluginPackageSecretBindingTransitionApprovalPlanError(
      'actionRef is invalid',
    );
  }
  return value;
}

function normalizeRow(
  row: Row,
): Readonly<PluginPackageSecretBindingTransitionApprovalPlan> {
  try {
    return normalizePluginPackageSecretBindingTransitionApprovalPlan(
      postgresRequiredJsonObject(
        row.planJson,
        unavailable,
      ) as unknown as PluginPackageSecretBindingTransitionApprovalPlan,
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

export class PostgresPluginPackageSecretBindingTransitionApprovalPlanReader {
  constructor(protected readonly pool: Pick<PostgresPool, 'query'>) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError(
        'PostgreSQL Secret binding transition approval reader is invalid',
      );
    }
  }

  async findByActionRef(
    actionRefValue: string,
  ): Promise<
    Readonly<PluginPackageSecretBindingTransitionApprovalPlan> | null
  > {
    const actionRef = validateActionRef(actionRefValue);
    try {
      const result = await this.pool.query<Row>(
        `SELECT plan_json AS "planJson"
         FROM "ql3"."plugin_package_secret_binding_transition_approval_plans"
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
    projectId: string,
    packageName: string,
  ): Promise<
    Readonly<PostgresPluginPackageSecretBindingTransitionPlanningSnapshot> | null
  > {
    if (
      typeof projectId !== 'string' ||
      !PROJECT_PATTERN.test(projectId) ||
      typeof packageName !== 'string' ||
      !PACKAGE_PATTERN.test(packageName)
    ) {
      throw new InvalidPluginPackageSecretBindingTransitionApprovalPlanError(
        'planning target is invalid',
      );
    }
    try {
      const result = await this.pool.query<Row>(
        `SELECT next_record_json AS "nextRecordJson",
                next_lock_json AS "nextLockJson",
                next_proposal_json AS "nextProposalJson",
                previous_record_json AS "previousRecordJson",
                previous_lock_json AS "previousLockJson",
                previous_proposal_json AS "previousProposalJson",
                previous_binding_json AS "previousBindingJson",
                previous_attempt_generation AS "previousAttemptGeneration",
                observed_at_ms AS "observedAtMs"
         FROM "ql3"."plugin_package_secret_binding_transition_snapshot"($1, $2)`,
        [projectId, packageName],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw unavailable();
      const row = result.rows[0]!;
      const next = Object.freeze({
        record: normalizePluginPackageInstallRecord(
          postgresRequiredJsonObject(
            row.nextRecordJson,
            unavailable,
          ) as unknown as PluginPackageInstallRecord,
        ),
        lock: normalizePluginPackageLock(
          postgresRequiredJsonObject(
            row.nextLockJson,
            unavailable,
          ) as unknown as PluginPackageLock,
        ),
        proposal: normalizePluginPackageInstallProposal(
          postgresRequiredJsonObject(
            row.nextProposalJson,
            unavailable,
          ) as unknown as PluginPackageInstallProposal,
        ),
      });
      const previous = Object.freeze({
        record: normalizePluginPackageInstallRecord(
          postgresRequiredJsonObject(
            row.previousRecordJson,
            unavailable,
          ) as unknown as PluginPackageInstallRecord,
        ),
        lock: normalizePluginPackageLock(
          postgresRequiredJsonObject(
            row.previousLockJson,
            unavailable,
          ) as unknown as PluginPackageLock,
        ),
        proposal: normalizePluginPackageInstallProposal(
          postgresRequiredJsonObject(
            row.previousProposalJson,
            unavailable,
          ) as unknown as PluginPackageInstallProposal,
        ),
        binding:
          row.previousBindingJson === null
            ? null
            : normalizePluginPackageSecretBinding(
                postgresRequiredJsonObject(row.previousBindingJson, unavailable),
              ),
      });
      const previousAttemptGeneration = postgresRequiredInteger(
        row.previousAttemptGeneration,
        unavailable,
      );
      const observedAtMs = postgresRequiredInteger(
        row.observedAtMs,
        unavailable,
      );
      const previousBindingTarget = previous.binding?.target;
      if (
        next.record.projectId !== projectId ||
        next.record.packageName !== packageName ||
        next.record.state !== 'staged' ||
        next.record.targetGeneration !== previousAttemptGeneration + 1 ||
        next.record.lockDigest !== next.lock.lockDigest ||
        next.record.previousActiveLockDigest !== previous.lock.lockDigest ||
        next.proposal.actionDigest !== next.lock.approval.actionDigest ||
        next.proposal.previewDigest !== next.lock.approval.previewDigest ||
        next.proposal.actionInput.targetGeneration !==
          next.record.targetGeneration ||
        next.proposal.actionInput.source.contentDigest !==
          next.lock.source.contentDigest ||
        previous.record.state !== 'active' ||
        previous.record.lockDigest !== previous.lock.lockDigest ||
        previous.proposal.actionDigest !==
          previous.lock.approval.actionDigest ||
        previous.proposal.previewDigest !== previous.lock.approval.previewDigest ||
        previous.proposal.actionInput.targetGeneration !==
          previous.record.targetGeneration ||
        previous.proposal.actionInput.source.contentDigest !==
          previous.lock.source.contentDigest ||
        (previousBindingTarget !== undefined &&
          (previousBindingTarget.projectId !== previous.record.projectId ||
            previousBindingTarget.packageName !== previous.record.packageName ||
            previousBindingTarget.installationId !==
              previous.record.installationId ||
            previousBindingTarget.lockDigest !== previous.record.lockDigest ||
            previousBindingTarget.generation !==
              previous.record.targetGeneration ||
            previousBindingTarget.manifestDigest !==
              previous.lock.manifestDigest))
      ) {
        throw unavailable();
      }
      return Object.freeze({
        next,
        previous,
        previousAttemptGeneration,
        observedAtMs,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async listApprovedRequests(
    limit: number,
  ): Promise<readonly Readonly<ApprovalRequestRecord>[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
      throw new TypeError('Secret transition approval page limit is invalid');
    }
    try {
      const result = await this.pool.query<Row>(
        `SELECT request.request_json AS "requestJson",
                request.request_digest AS "requestDigest"
         FROM "ql3"."approval_requests" AS request
         JOIN "ql3"."plugin_package_secret_binding_transition_approval_plans" AS plan
           ON plan.action_ref = request.action_ref
          AND plan.approval_plan_digest = request.action_digest
          AND plan.transition_digest = request.preview_digest
         WHERE request.state = 'approved'
           AND request.action_type = 'plugin_package.secret_binding.transition'
         ORDER BY request.updated_at_ms, request.request_id
         LIMIT $1`,
        [limit],
      );
      if (result.rows.length > limit) throw unavailable();
      return Object.freeze(result.rows.map(normalizeApprovalRow));
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}

export class PostgresPluginPackageSecretBindingTransitionApprovalPlanRepository
  extends PostgresPluginPackageSecretBindingTransitionApprovalPlanReader
  implements PluginPackageSecretBindingTransitionApprovalPlanRepository
{
  async create(
    value: Readonly<PluginPackageSecretBindingTransitionApprovalPlan>,
  ): Promise<
    Readonly<CreatePluginPackageSecretBindingTransitionApprovalPlanResult>
  > {
    const plan =
      normalizePluginPackageSecretBindingTransitionApprovalPlan(value);
    try {
      const result = await this.pool.query<Row>(
        `SELECT "ql3"."create_plugin_package_secret_transition_plan"(
           $1::jsonb
         ) AS status`,
        [JSON.stringify(plan)],
      );
      if (result.rows.length !== 1) throw unavailable();
      const status = postgresRequiredString(
        result.rows[0]?.status,
        unavailable,
      );
      if (status !== 'created' && status !== 'existing') throw unavailable();
      const stored = await this.findByActionRef(plan.actionRef);
      if (!stored || !same(stored, plan)) {
        throw new PluginPackageSecretBindingTransitionApprovalPlanConflictError(
          'actionRef is already bound to another transition plan',
        );
      }
      return Object.freeze({ status, plan: stored });
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}
