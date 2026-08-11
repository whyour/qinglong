// PostgreSQL adapter owned by the Plugin Package lifecycle capability.
import { createHash } from 'node:crypto';

import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';
import {
  approvedActionDispatchDigest,
  normalizeApprovedActionDispatchRecord,
  type ApprovedActionDispatchRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  InvalidPluginPackageAutomationPublicationError,
  PluginPackageAutomationPublicationConflictError,
  PluginPackageAutomationPublicationUnavailableError,
  createPluginPackageAutomationLifecyclePublication,
} from '@qinglong/runtime-core/plugin-package-automation-publication';
import {
  InvalidPluginPackageLifecycleError,
  MAX_PLUGIN_PACKAGE_LIFECYCLE_RETAINED_SOURCES,
  MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS,
  PLUGIN_PACKAGE_LIFECYCLE_ACTIONS,
  PluginPackageLifecycleConflictError,
  PluginPackageLifecycleUnavailableError,
  assertPluginPackageLifecycleReceiptMatchesEvent,
  createPluginPackageLifecycleImpact,
  createPluginPackageLifecycleReceipt,
  normalizePluginPackageLifecycleEvent,
  normalizePluginPackageLifecycleReceipt,
  pluginPackageLifecycleReferenceGraphDigest,
  pluginPackageLifecycleTaskMutationId,
  type PluginPackageLifecycleAction,
  type PluginPackageLifecycleBlockingReference,
  type PluginPackageLifecycleEvent,
  type PluginPackageLifecycleHead,
  type PluginPackageLifecycleImpact,
  type PluginPackageLifecycleReceipt,
  type PluginPackageLifecycleRepository,
  type PluginPackageLifecycleTaskTransition,
} from '@qinglong/runtime-core/plugin-package-lifecycle';
import {
  normalizePluginPackageInstallRecord,
  type PluginPackageInstallRecord,
} from '@qinglong/runtime-core/plugin-package-install';
import {
  normalizePluginPackageMaterializedRevision,
  type PluginPackageMaterializedRevision,
} from '@qinglong/runtime-core/plugin-package-resource-materialization';
import {
  createProjectToolDefinitionSnapshot,
  normalizeProjectToolDefinitionSnapshot,
  projectToolDefinitionSnapshotContribution,
  type ProjectToolDefinitionSnapshot,
  type ProjectToolDefinitionSnapshotContribution,
} from '@qinglong/runtime-core/project-tool-definition-snapshot';
import {
  createTaskDefinitionRecord,
  normalizeTaskDefinitionRecord,
  type TaskDefinitionRecord,
} from '@qinglong/runtime-core/task-definition';
import {
  TaskSpecSemanticRegistry,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredBoolean,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../../repository/definitionRepositorySupport';
import { isPostgresAvailabilityError } from '../../connection/pool';
import { PostgresPluginPackageAutomationPublicationRepository } from '../publication/pluginPackageAutomationPublicationRepository';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresQueryable, 'query'>;

const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function unavailable(
  cause?: unknown,
): PluginPackageLifecycleUnavailableError {
  return new PluginPackageLifecycleUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageAutomationPublicationError ||
    error instanceof PluginPackageAutomationPublicationConflictError
  ) {
    return new PluginPackageLifecycleConflictError(
      'Workflow/Prompt publication does not match lifecycle state',
    );
  }
  if (error instanceof PluginPackageAutomationPublicationUnavailableError) {
    return unavailable(error);
  }
  if (
    error instanceof InvalidPluginPackageLifecycleError ||
    error instanceof PluginPackageLifecycleConflictError ||
    error instanceof PluginPackageLifecycleUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackageLifecycleConflictError(
      'durable lifecycle identity or target state conflicts',
    );
  }
  return unavailable(error);
}

function recordJson(row: Row, key: string): Readonly<Record<string, unknown>> {
  return postgresRequiredJsonObject(row[key], unavailable);
}

function text(row: Row, key: string): string {
  return postgresRequiredString(row[key], unavailable);
}

function integer(row: Row, key: string): number {
  const value = postgresRequiredInteger(row[key], unavailable);
  if (value < 0) throw unavailable();
  return value;
}

function normalizePlanTarget(
  action: PluginPackageLifecycleAction,
  projectId: string,
  packageName: string,
): Readonly<{
  action: PluginPackageLifecycleAction;
  projectId: string;
  packageName: string;
}> {
  if (
    typeof action !== 'string' ||
    !PLUGIN_PACKAGE_LIFECYCLE_ACTIONS.includes(action)
  ) {
    throw new InvalidPluginPackageLifecycleError('action is invalid');
  }
  if (
    typeof projectId !== 'string' ||
    projectId.length < 1 ||
    Buffer.byteLength(projectId, 'utf8') > 128 ||
    projectId.includes('\0')
  ) {
    throw new InvalidPluginPackageLifecycleError('projectId is invalid');
  }
  if (
    typeof packageName !== 'string' ||
    !PACKAGE_NAME_PATTERN.test(packageName)
  ) {
    throw new InvalidPluginPackageLifecycleError('packageName is invalid');
  }
  return Object.freeze({ action, projectId, packageName });
}

function taskRecord(row: Row): Readonly<TaskDefinitionRecord> {
  try {
    const description = row.description;
    if (description !== null && typeof description !== 'string') {
      throw unavailable();
    }
    return normalizeTaskDefinitionRecord({
      projectId: text(row, 'projectId'),
      taskId: text(row, 'taskId'),
      revision: integer(row, 'revision'),
      mutationId: text(row, 'mutationId'),
      name: text(row, 'name'),
      ...(description === null ? {} : { description }),
      kind: text(row, 'kind') as TaskDefinitionRecord['kind'],
      spec: recordJson(
        row,
        'specJson',
      ) as unknown as TaskDefinitionRecord['spec'],
      labels: recordJson(row, 'labelsJson') as TaskDefinitionRecord['labels'],
      enabled: postgresRequiredBoolean(row.enabled, unavailable),
      contentDigest: text(row, 'contentDigest'),
      createdAtMs: integer(row, 'createdAtMs'),
      updatedAtMs: integer(row, 'updatedAtMs'),
    });
  } catch (error) {
    if (error instanceof PluginPackageLifecycleUnavailableError) throw error;
    throw unavailable(error);
  }
}

export class PostgresPluginPackageLifecycleRepository
  implements PluginPackageLifecycleRepository
{
  readonly #registry: TaskSpecSemanticRegistry;

  constructor(
    private readonly pool: PostgresPool,
    options: Readonly<{ registry?: TaskSpecSemanticRegistry }> = {},
  ) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Plugin Package lifecycle repository is invalid',
      );
    }
    const registry =
      options.registry ?? createBuiltInTaskSpecSemanticRegistry();
    if (!(registry instanceof TaskSpecSemanticRegistry)) {
      throw new TypeError('TaskSpec semantic registry is invalid');
    }
    this.#registry = registry;
  }

  async #currentInstall(
    queryable: Queryable,
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageInstallRecord>> {
    const result = await queryable.query<Row>(
      `SELECT install.record_json AS "recordJson"
       FROM "ql3"."plugin_package_install_heads" AS head
       JOIN "ql3"."plugin_package_installs" AS install
         ON install.installation_id = head.installation_id
       WHERE head.project_id = $1 AND head.package_name = $2
       LIMIT 2`,
      [projectId, packageName],
    );
    if (result.rows.length !== 1) {
      throw new PluginPackageLifecycleConflictError(
        'current Package installation is absent',
      );
    }
    try {
      const record = normalizePluginPackageInstallRecord(
        recordJson(result.rows[0]!, 'recordJson') as unknown as
          PluginPackageInstallRecord,
      );
      if (
        record.state !== 'active' ||
        record.activeLockDigest !== record.lockDigest
      ) {
        throw new PluginPackageLifecycleConflictError(
          'current Package installation is not active',
        );
      }
      return record;
    } catch (error) {
      if (error instanceof PluginPackageLifecycleConflictError) throw error;
      throw unavailable(error);
    }
  }

  async #materialized(
    queryable: Queryable,
    record: Readonly<PluginPackageInstallRecord>,
  ): Promise<Readonly<PluginPackageMaterializedRevision>> {
    const result = await queryable.query<Row>(
      `SELECT revision_json AS "revisionJson"
       FROM "ql3"."plugin_package_materialized_revisions"
       WHERE project_id = $1 AND package_name = $2 AND generation = $3
         AND lock_digest = $4
       LIMIT 2`,
      [
        record.projectId,
        record.packageName,
        record.targetGeneration,
        record.lockDigest,
      ],
    );
    if (result.rows.length !== 1) {
      throw new PluginPackageLifecycleConflictError(
        'materialized Package revision is absent',
      );
    }
    try {
      return normalizePluginPackageMaterializedRevision(
        recordJson(result.rows[0]!, 'revisionJson') as unknown as
          PluginPackageMaterializedRevision,
        this.#registry,
      );
    } catch (error) {
      throw unavailable(error);
    }
  }

  async #event(
    queryable: Queryable,
    eventDigest: string,
  ): Promise<Readonly<PluginPackageLifecycleEvent> | null> {
    const result = await queryable.query<Row>(
      `SELECT event_json AS "eventJson"
       FROM "ql3"."plugin_package_lifecycle_events"
       WHERE event_digest = $1
       LIMIT 2`,
      [eventDigest],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw unavailable();
    try {
      return normalizePluginPackageLifecycleEvent(
        recordJson(result.rows[0]!, 'eventJson') as unknown as
          PluginPackageLifecycleEvent,
      );
    } catch (error) {
      throw unavailable(error);
    }
  }

  async #receipt(
    queryable: Queryable,
    event: Readonly<PluginPackageLifecycleEvent>,
  ): Promise<Readonly<PluginPackageLifecycleReceipt> | null> {
    const result = await queryable.query<Row>(
      `SELECT receipt_json AS "receiptJson"
       FROM "ql3"."plugin_package_lifecycle_receipts"
       WHERE event_digest = $1
       LIMIT 2`,
      [event.eventDigest],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw unavailable();
    try {
      const receipt = normalizePluginPackageLifecycleReceipt(
        recordJson(result.rows[0]!, 'receiptJson') as unknown as
          PluginPackageLifecycleReceipt,
      );
      assertPluginPackageLifecycleReceiptMatchesEvent(event, receipt);
      const tasks = await queryable.query<Row>(
        `SELECT task_id AS "taskId",
                previous_revision AS "previousRevision",
                current_revision AS "currentRevision",
                previous_content_digest AS "previousContentDigest",
                current_content_digest AS "currentContentDigest",
                previous_enabled AS "previousEnabled",
                current_enabled AS "currentEnabled"
         FROM "ql3"."plugin_package_lifecycle_tasks"
         WHERE event_digest = $1
         ORDER BY task_id`,
        [event.eventDigest],
      );
      const transitions = tasks.rows.map((row) => ({
        taskId: text(row, 'taskId'),
        previousRevision: integer(row, 'previousRevision'),
        currentRevision: integer(row, 'currentRevision'),
        previousContentDigest: text(row, 'previousContentDigest'),
        currentContentDigest: text(row, 'currentContentDigest'),
        previousEnabled: postgresRequiredBoolean(
          row.previousEnabled,
          unavailable,
        ),
        currentEnabled: postgresRequiredBoolean(
          row.currentEnabled,
          unavailable,
        ),
      }));
      const snapshots = await queryable.query<Row>(
        `SELECT snapshot_digest AS "snapshotDigest",
                (
                  SELECT count(*)::integer
                  FROM "ql3"."project_tool_definition_snapshot_sources"
                  WHERE project_id = snapshot.project_id
                    AND active_vector_digest = snapshot.active_vector_digest
                ) AS "sourceCount"
         FROM "ql3"."project_tool_definition_snapshots" AS snapshot
         WHERE project_id = $1 AND active_vector_digest = $2
         LIMIT 2`,
        [
          receipt.target.projectId,
          receipt.capability.currentActiveVectorDigest,
        ],
      );
      if (
        !same(transitions, receipt.capability.taskTransitions) ||
        snapshots.rows.length !== 1 ||
        text(snapshots.rows[0]!, 'snapshotDigest') !==
          receipt.capability.currentToolSnapshotDigest ||
        integer(snapshots.rows[0]!, 'sourceCount') !==
          receipt.capability.retainedSourceCount
      ) {
        throw unavailable();
      }
      return receipt;
    } catch (error) {
      if (error instanceof PluginPackageLifecycleUnavailableError) {
        throw error;
      }
      throw unavailable(error);
    }
  }

  async #storedHead(
    queryable: Queryable,
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageLifecycleHead> | null> {
    const result = await queryable.query<Row>(
      `SELECT head.project_id AS "projectId",
              head.package_name AS "packageName",
              head.installation_id AS "installationId",
              head.lock_digest AS "lockDigest",
              head.install_record_digest AS "installRecordDigest",
              head.version, head.disposition,
              head.event_digest AS "eventDigest",
              head.updated_at_ms AS "updatedAtMs",
              receipt.receipt_json AS "receiptJson"
       FROM "ql3"."plugin_package_lifecycle_heads" AS head
       JOIN "ql3"."plugin_package_lifecycle_receipts" AS receipt
         ON receipt.event_digest = head.event_digest
       WHERE head.project_id = $1 AND head.package_name = $2
       LIMIT 2`,
      [projectId, packageName],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw unavailable();
    const row = result.rows[0]!;
    try {
      const lifecycle = normalizePluginPackageLifecycleReceipt(
        recordJson(row, 'receiptJson') as unknown as
          PluginPackageLifecycleReceipt,
      ).lifecycle;
      if (
        lifecycle.projectId !== text(row, 'projectId') ||
        lifecycle.packageName !== text(row, 'packageName') ||
        lifecycle.installationId !== text(row, 'installationId') ||
        lifecycle.lockDigest !== text(row, 'lockDigest') ||
        lifecycle.installRecordDigest !== text(row, 'installRecordDigest') ||
        lifecycle.version !== integer(row, 'version') ||
        lifecycle.disposition !== text(row, 'disposition') ||
        lifecycle.eventDigest !== text(row, 'eventDigest') ||
        lifecycle.updatedAtMs !== integer(row, 'updatedAtMs')
      ) {
        throw unavailable();
      }
      return lifecycle;
    } catch (error) {
      if (error instanceof PluginPackageLifecycleUnavailableError) {
        throw error;
      }
      throw unavailable(error);
    }
  }

  async #assertDispatch(
    queryable: Queryable,
    event: Readonly<PluginPackageLifecycleEvent>,
  ): Promise<void> {
    const result = await queryable.query<Row>(
      `SELECT dispatch_json AS "dispatchJson",
              dispatch_digest AS "dispatchDigest"
       FROM "ql3"."approved_action_dispatches"
       WHERE dispatch_id = $1
       LIMIT 2`,
      [event.dispatchId],
    );
    if (result.rows.length !== 1) {
      throw new PluginPackageLifecycleConflictError(
        'approved action dispatch is absent',
      );
    }
    try {
      const dispatch = normalizeApprovedActionDispatchRecord(
        recordJson(result.rows[0]!, 'dispatchJson') as unknown as
          ApprovedActionDispatchRecord,
      );
      if (
        approvedActionDispatchDigest(dispatch) !==
          text(result.rows[0]!, 'dispatchDigest') ||
        dispatch.projectId !== event.impact.target.projectId ||
        dispatch.action.permission !== 'package.manage' ||
        dispatch.action.actionType !==
          `plugin_package.lifecycle.${event.impact.action}` ||
        dispatch.action.actionDigest !== event.actionDigest ||
        dispatch.action.previewDigest !== event.impact.impactDigest ||
        dispatch.requestedBy.type !== event.requestedBy.type ||
        dispatch.requestedBy.id !== event.requestedBy.id ||
        dispatch.approvedBy.type !== event.approvedBy.type ||
        dispatch.approvedBy.id !== event.approvedBy.id ||
        event.occurredAtMs < dispatch.approvedAtMs ||
        event.occurredAtMs > dispatch.expiresAtMs
      ) {
        throw new PluginPackageLifecycleConflictError(
          'approved action dispatch does not authorize lifecycle event',
        );
      }
    } catch (error) {
      if (error instanceof PluginPackageLifecycleConflictError) throw error;
      throw unavailable(error);
    }
  }

  async #contributions(
    queryable: Queryable,
    projectId: string,
  ): Promise<
    readonly Readonly<ProjectToolDefinitionSnapshotContribution>[]
  > {
    const result = await queryable.query<Row>(
      `SELECT revision.revision_json AS "revisionJson"
       FROM "ql3"."plugin_package_install_heads" AS head
       JOIN "ql3"."plugin_package_installs" AS head_install
         ON head_install.installation_id = head.installation_id
       JOIN "ql3"."plugin_package_installs" AS active_install
         ON active_install.project_id = head.project_id
        AND active_install.package_name = head.package_name
        AND active_install.lock_digest = head_install.active_lock_digest
       JOIN "ql3"."plugin_package_materialized_revisions" AS revision
         ON revision.project_id = active_install.project_id
        AND revision.package_name = active_install.package_name
        AND revision.generation = active_install.target_generation
        AND revision.lock_digest = active_install.lock_digest
       LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
         ON quarantine.project_id = active_install.project_id
        AND quarantine.package_name = active_install.package_name
        AND quarantine.installation_id = active_install.installation_id
        AND quarantine.lock_digest = active_install.lock_digest
       LEFT JOIN "ql3"."plugin_package_lifecycle_heads" AS lifecycle
         ON lifecycle.project_id = active_install.project_id
        AND lifecycle.package_name = active_install.package_name
        AND lifecycle.installation_id = active_install.installation_id
        AND lifecycle.lock_digest = active_install.lock_digest
        AND lifecycle.install_record_digest = active_install.record_digest
       WHERE head.project_id = $1
         AND active_install.state = 'active'
         AND quarantine.event_digest IS NULL
         AND (
           lifecycle.event_digest IS NULL OR lifecycle.disposition = 'active'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM "ql3"."plugin_package_publisher_provenance" AS provenance
           JOIN "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
             ON revoked.publisher = provenance.publisher
            AND revoked.key_id = provenance.key_id
           WHERE provenance.installation_id = active_install.installation_id
             AND provenance.lock_digest = active_install.lock_digest
         )
       ORDER BY head.package_name
       LIMIT $2`,
      [projectId, MAX_PLUGIN_PACKAGE_LIFECYCLE_RETAINED_SOURCES + 1],
    );
    if (
      result.rows.length > MAX_PLUGIN_PACKAGE_LIFECYCLE_RETAINED_SOURCES
    ) {
      throw new PluginPackageLifecycleConflictError(
        'active Package sources exceed the Cluster lifecycle limit',
      );
    }
    try {
      return Object.freeze(
        result.rows.map((row) =>
          projectToolDefinitionSnapshotContribution(
            recordJson(row, 'revisionJson') as never,
            this.#registry,
          ),
        ),
      );
    } catch (error) {
      throw unavailable(error);
    }
  }

  async #currentSnapshot(
    queryable: Queryable,
    projectId: string,
    contributions: readonly Readonly<ProjectToolDefinitionSnapshotContribution>[],
  ): Promise<Readonly<ProjectToolDefinitionSnapshot>> {
    const expected = createProjectToolDefinitionSnapshot({
      projectId,
      contributions,
    });
    const result = await queryable.query<Row>(
      `SELECT snapshot_json AS "snapshotJson"
       FROM "ql3"."project_tool_definition_snapshots"
       WHERE project_id = $1 AND active_vector_digest = $2
         AND snapshot_digest = $3
       LIMIT 2`,
      [
        projectId,
        expected.activeVectorDigest,
        expected.snapshotDigest,
      ],
    );
    if (result.rows.length !== 1) {
      throw new PluginPackageLifecycleConflictError(
        'current Tool snapshot is not durably published',
      );
    }
    try {
      const stored = normalizeProjectToolDefinitionSnapshot(
        recordJson(result.rows[0]!, 'snapshotJson') as unknown as
          ProjectToolDefinitionSnapshot,
      );
      if (!same(stored, expected)) throw unavailable();
      return stored;
    } catch (error) {
      if (error instanceof PluginPackageLifecycleUnavailableError) {
        throw error;
      }
      throw unavailable(error);
    }
  }

  async #ownedTasks(
    queryable: Queryable,
    record: Readonly<PluginPackageInstallRecord>,
  ): Promise<readonly Readonly<TaskDefinitionRecord>[]> {
    const result = await queryable.query<Row>(
      `SELECT head.project_id AS "projectId",
              head.task_id AS "taskId",
              revision.revision,
              revision.mutation_id::text AS "mutationId",
              revision.name, revision.description, revision.kind,
              revision.spec_json AS "specJson",
              revision.labels_json AS "labelsJson",
              revision.enabled,
              revision.content_digest AS "contentDigest",
              head.created_at_ms AS "createdAtMs",
              revision.created_at_ms AS "updatedAtMs"
       FROM "ql3"."plugin_package_task_ownerships" AS ownership
       JOIN "ql3"."task_definitions" AS head
         ON head.project_id = ownership.project_id
        AND head.task_id = ownership.task_id
       JOIN "ql3"."task_definition_revisions" AS revision
         ON revision.project_id = head.project_id
        AND revision.task_id = head.task_id
        AND revision.revision = head.current_revision
       WHERE ownership.project_id = $1 AND ownership.package_name = $2
       ORDER BY ownership.task_id
       LIMIT $3`,
      [
        record.projectId,
        record.packageName,
        MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS + 1,
      ],
    );
    if (result.rows.length > MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS) {
      throw new PluginPackageLifecycleConflictError(
        'owned Tasks exceed the lifecycle limit',
      );
    }
    return Object.freeze(result.rows.map(taskRecord));
  }

  async #blockingReferences(
    queryable: Queryable,
    record: Readonly<PluginPackageInstallRecord>,
  ): Promise<
    readonly Readonly<PluginPackageLifecycleBlockingReference>[]
  > {
    const result = await queryable.query<Row>(
      `SELECT blocking.run_id AS "runId", blocking.status, blocking.version,
              blocking.event_sequence AS "eventSequence",
              blocking.task_id AS "taskId",
              blocking.task_revision AS "taskRevision"
       FROM "ql3"."plugin_package_lifecycle_blocking_runs"(
         $1, $2, $3
       ) AS blocking`,
      [
        record.projectId,
        record.packageName,
        MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS + 1,
      ],
    );
    if (result.rows.length > MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS) {
      throw new PluginPackageLifecycleConflictError(
        'execution recovery references exceed the lifecycle limit',
      );
    }
    return Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          kind: 'execution_recovery' as const,
          ownerId: text(row, 'runId'),
          referenceDigest: createHash('sha256')
            .update(
              'qinglong/plugin-package-lifecycle-execution-reference@v1\0',
            )
            .update(
              JSON.stringify({
                runId: text(row, 'runId'),
                status: text(row, 'status'),
                version: integer(row, 'version'),
                eventSequence: integer(row, 'eventSequence'),
                taskId: text(row, 'taskId'),
                taskRevision: text(row, 'taskRevision'),
              }),
            )
            .digest('hex'),
        }),
      ),
    );
  }

  async #computeImpact(
    queryable: Queryable,
    actionValue: PluginPackageLifecycleAction,
    projectIdValue: string,
    packageNameValue: string,
  ): Promise<Readonly<PluginPackageLifecycleImpact>> {
    const { action, projectId, packageName } = normalizePlanTarget(
      actionValue,
      projectIdValue,
      packageNameValue,
    );
    const record = await this.#currentInstall(
      queryable,
      projectId,
      packageName,
    );
    const revision = await this.#materialized(queryable, record);
    const head = await this.#storedHead(queryable, projectId, packageName);
    const exactHead =
      head &&
      head.installationId === record.installationId &&
      head.lockDigest === record.lockDigest &&
      head.installRecordDigest === record.recordDigest
        ? head
        : null;
    const expected = exactHead
      ? {
          disposition: exactHead.disposition,
          version: exactHead.version,
          eventDigest: exactHead.eventDigest,
        }
      : { disposition: 'active' as const, version: 0, eventDigest: null };
    const contributions = await this.#contributions(queryable, projectId);
    const targetContributions = contributions.filter(
      ({ generation }) =>
        generation.installationId === record.installationId &&
        generation.lockDigest === record.lockDigest,
    );
    if (
      (action === 'disable' && targetContributions.length !== 1) ||
      (action !== 'disable' && targetContributions.length !== 0)
    ) {
      throw new PluginPackageLifecycleConflictError(
        'current Tool source does not match lifecycle disposition',
      );
    }
    if (
      action === 'enable' &&
      contributions.length >= MAX_PLUGIN_PACKAGE_LIFECYCLE_RETAINED_SOURCES
    ) {
      throw new PluginPackageLifecycleConflictError(
        'enabling Package would exceed the Cluster source limit',
      );
    }
    if (action === 'enable') {
      const quarantine = await queryable.query<Row>(
        `SELECT 1
         FROM "ql3"."plugin_package_quarantine_events"
         WHERE project_id = $1 AND package_name = $2
           AND installation_id = $3 AND lock_digest = $4
         LIMIT 1`,
        [
          record.projectId,
          record.packageName,
          record.installationId,
          record.lockDigest,
        ],
      );
      if (quarantine.rows.length > 0) {
        throw new PluginPackageLifecycleConflictError(
          'quarantined Package cannot be enabled',
        );
      }
    }
    const snapshot = await this.#currentSnapshot(
      queryable,
      projectId,
      contributions,
    );
    const ownedTasks = await this.#ownedTasks(queryable, record);
    let taskIds: readonly string[];
    if (action === 'disable') {
      taskIds = ownedTasks
        .filter((task) => task.enabled)
        .map((task) => task.taskId);
    } else if (action === 'enable') {
      if (!exactHead || exactHead.disposition !== 'disabled') {
        taskIds = [];
      } else {
        const priorEvent = await this.#event(
          queryable,
          exactHead.eventDigest,
        );
        const priorReceipt = priorEvent
          ? await this.#receipt(queryable, priorEvent)
          : null;
        if (!priorReceipt || priorReceipt.action !== 'disable') {
          throw unavailable();
        }
        taskIds = priorReceipt.capability.taskTransitions.map(
          (task) => task.taskId,
        );
        if (
          taskIds.some((taskId) => {
            const current = ownedTasks.find((task) => task.taskId === taskId);
            const previous = priorReceipt.capability.taskTransitions.find(
              (task) => task.taskId === taskId,
            )!;
            return (
              !current ||
              current.enabled ||
              current.revision !== previous.currentRevision ||
              current.contentDigest !== previous.currentContentDigest
            );
          })
        ) {
          throw new PluginPackageLifecycleConflictError(
            'disabled Package Tasks advanced before enable',
          );
        }
      }
    } else {
      taskIds = [];
    }
    const resourceCounts = {
      tasks: revision.resources.filter(({ kind }) => kind === 'task').length,
      tools: revision.resources.filter(({ kind }) => kind === 'tool').length,
      workflows: revision.resources.filter(({ kind }) => kind === 'workflow')
        .length,
      prompts: revision.resources.filter(({ kind }) => kind === 'prompt')
        .length,
    };
    const blockingReferences = await this.#blockingReferences(
      queryable,
      record,
    );
    const graph = {
      target: {
        projectId: record.projectId,
        packageName: record.packageName,
        installationId: record.installationId,
        lockDigest: record.lockDigest,
        installVersion: record.version,
        installRecordDigest: record.recordDigest,
      },
      generationDigest: revision.generation.generationDigest,
      materializedRevisionDigest: revision.revisionDigest,
      taskIds,
      resourceCounts,
      blockingReferences,
    };
    return createPluginPackageLifecycleImpact({
      action,
      ...graph,
      expected,
      currentToolSnapshotDigest: snapshot.snapshotDigest,
      referenceGraphDigest:
        pluginPackageLifecycleReferenceGraphDigest(graph),
    });
  }

  async #databaseNowMs(queryable: Queryable): Promise<number> {
    const result = await queryable.query<Row>(
      `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
         AS "nowMs"`,
    );
    if (result.rows.length !== 1) throw unavailable();
    return integer(result.rows[0]!, 'nowMs');
  }

  #taskWrite(
    event: Readonly<PluginPackageLifecycleEvent>,
    current: Readonly<TaskDefinitionRecord>,
    enabled: boolean,
    committedAtMs: number,
  ): Readonly<{
    next: Readonly<TaskDefinitionRecord>;
    transition: Readonly<PluginPackageLifecycleTaskTransition>;
  }> {
    const next = createTaskDefinitionRecord(
      {
        projectId: current.projectId,
        taskId: current.taskId,
        expectedRevision: current.revision,
        mutationId: pluginPackageLifecycleTaskMutationId(
          event.eventDigest,
          current.taskId,
        ),
        name: current.name,
        ...(current.description === undefined
          ? {}
          : { description: current.description }),
        kind: current.kind,
        spec: current.spec,
        labels: current.labels,
        enabled,
        occurredAtMs: committedAtMs,
      },
      current.createdAtMs,
    );
    return Object.freeze({
      next,
      transition: Object.freeze({
        taskId: current.taskId,
        previousRevision: current.revision,
        currentRevision: next.revision,
        previousContentDigest: current.contentDigest,
        currentContentDigest: next.contentDigest,
        previousEnabled: current.enabled,
        currentEnabled: next.enabled,
      }),
    });
  }

  async #publishAutomationLifecycle(
    client: PostgresClient,
    event: Readonly<PluginPackageLifecycleEvent>,
    record: Readonly<PluginPackageInstallRecord>,
    committedAtMs: number,
  ): Promise<void> {
    if (
      event.impact.resourceCounts.workflows === 0 &&
      event.impact.resourceCounts.prompts === 0
    ) {
      return;
    }
    const publications =
      new PostgresPluginPackageAutomationPublicationRepository(this.pool);
    const current = await publications.findCurrentInTransaction(
      client,
      record.projectId,
      record.packageName,
    );
    if (
      !current ||
      current.target.projectId !== record.projectId ||
      current.target.packageName !== record.packageName ||
      current.target.installationId !== record.installationId ||
      current.target.lockDigest !== record.lockDigest ||
      current.target.generationDigest !== event.impact.generationDigest ||
      current.target.materializedRevisionDigest !==
        event.impact.materializedRevisionDigest
    ) {
      throw new PluginPackageLifecycleConflictError(
        'Workflow/Prompt publication does not match the active Package generation',
      );
    }
    const expectedState =
      event.impact.action === 'disable' ? 'active' : 'withdrawn';
    if (current.state !== expectedState) {
      throw new PluginPackageLifecycleConflictError(
        'Workflow/Prompt publication state does not match lifecycle disposition',
      );
    }
    if (event.impact.action === 'uninstall') return;
    await publications.publishInTransaction(
      client,
      createPluginPackageAutomationLifecyclePublication({
        previous: current,
        state:
          event.impact.action === 'disable' ? 'withdrawn' : 'active',
        lifecycleEventDigest: event.eventDigest,
        publishedAtMs: committedAtMs,
      }),
    );
  }

  async #findStored(
    queryable: Queryable,
    eventDigest: string,
  ): Promise<Readonly<PluginPackageLifecycleReceipt> | null> {
    const event = await this.#event(queryable, eventDigest);
    if (!event) return null;
    const receipt = await this.#receipt(queryable, event);
    if (!receipt) throw unavailable();
    return receipt;
  }

  async plan(
    action: PluginPackageLifecycleAction,
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageLifecycleImpact>> {
    normalizePlanTarget(action, projectId, packageName);
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        if (attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS) continue;
        throw unavailable(error);
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const impact = await this.#computeImpact(
          client,
          action,
          projectId,
          packageName,
        );
        await client.query('COMMIT');
        began = false;
        return impact;
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS &&
          (isPostgresAvailabilityError(error) ||
            !state ||
            POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) ||
            state.startsWith('08'))
        ) {
          continue;
        }
        throw mapStorageError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }

  async findHead(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageLifecycleHead> | null> {
    normalizePlanTarget('disable', projectId, packageName);
    try {
      return await this.#storedHead(this.pool, projectId, packageName);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findByEventDigest(
    eventDigest: string,
  ): Promise<Readonly<PluginPackageLifecycleReceipt> | null> {
    if (
      typeof eventDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(eventDigest)
    ) {
      throw new InvalidPluginPackageLifecycleError(
        'eventDigest is invalid',
      );
    }
    try {
      return await this.#findStored(this.pool, eventDigest);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async #commit(
    client: PostgresClient,
    event: Readonly<PluginPackageLifecycleEvent>,
  ): Promise<
    Readonly<{
      created: boolean;
      receipt: Readonly<PluginPackageLifecycleReceipt>;
    }>
  > {
    await this.#assertDispatch(client, event);
    const existing = await this.#event(client, event.eventDigest);
    if (existing) {
      if (!same(existing, event)) {
        throw new PluginPackageLifecycleConflictError(
          'event digest is bound to another lifecycle event',
        );
      }
      const receipt = await this.#receipt(client, existing);
      if (!receipt) throw unavailable();
      return Object.freeze({ created: false, receipt });
    }
    const project = await client.query<Row>(
      `SELECT "ql3"."lock_active_plugin_package_project"($1) AS active`,
      [event.impact.target.projectId],
    );
    if (project.rows.length !== 1 || project.rows[0]?.active !== true) {
      throw new PluginPackageLifecycleConflictError(
        'lifecycle Project is absent or inactive',
      );
    }
    const impact = await this.#computeImpact(
      client,
      event.impact.action,
      event.impact.target.projectId,
      event.impact.target.packageName,
    );
    if (!same(impact, event.impact)) {
      throw new PluginPackageLifecycleConflictError(
        'approved lifecycle impact is stale',
      );
    }
    const record = await this.#currentInstall(
      client,
      impact.target.projectId,
      impact.target.packageName,
    );
    const committedAtMs = Math.max(
      await this.#databaseNowMs(client),
      event.occurredAtMs,
    );
    const previousContributions = await this.#contributions(
      client,
      record.projectId,
    );
    const previousSnapshot = await this.#currentSnapshot(
      client,
      record.projectId,
      previousContributions,
    );
    let nextContributions = previousContributions;
    if (impact.action === 'disable') {
      nextContributions = Object.freeze(
        previousContributions.filter(
          ({ generation }) =>
            generation.installationId !== record.installationId ||
            generation.lockDigest !== record.lockDigest,
        ),
      );
    } else if (impact.action === 'enable') {
      const revision = await this.#materialized(client, record);
      nextContributions = Object.freeze(
        [
          ...previousContributions,
          projectToolDefinitionSnapshotContribution(
            revision,
            this.#registry,
          ),
        ].sort((left, right) =>
          Buffer.compare(
            Buffer.from(left.generation.packageName, 'utf8'),
            Buffer.from(right.generation.packageName, 'utf8'),
          ),
        ),
      );
    }
    const nextSnapshot =
      impact.action === 'uninstall'
        ? previousSnapshot
        : createProjectToolDefinitionSnapshot({
            projectId: record.projectId,
            contributions: nextContributions,
          });
    const taskById = new Map(
      (await this.#ownedTasks(client, record)).map((task) => [
        task.taskId,
        task,
      ]),
    );
    const taskWrites =
      impact.action === 'uninstall'
        ? []
        : impact.taskIds.map((taskId) => {
            const task = taskById.get(taskId);
            if (!task) {
              throw new PluginPackageLifecycleConflictError(
                'approved Package Task is absent',
              );
            }
            return this.#taskWrite(
              event,
              task,
              impact.action === 'enable',
              committedAtMs,
            );
          });
    const lifecycle = Object.freeze({
      projectId: record.projectId,
      packageName: record.packageName,
      installationId: record.installationId,
      lockDigest: record.lockDigest,
      installRecordDigest: record.recordDigest,
      version: impact.expected.version + 1,
      disposition:
        impact.action === 'enable'
          ? ('active' as const)
          : impact.action === 'disable'
          ? ('disabled' as const)
          : ('uninstalled' as const),
      eventDigest: event.eventDigest,
      updatedAtMs: committedAtMs,
    });
    const receipt = createPluginPackageLifecycleReceipt({
      eventDigest: event.eventDigest,
      action: impact.action,
      target: impact.target,
      lifecycle,
      capability: {
        status:
          impact.action === 'enable'
            ? 'restored'
            : impact.action === 'disable'
            ? 'withdrawn'
            : 'retired',
        taskTransitions: taskWrites.map(({ transition }) => transition),
        previousActiveVectorDigest: previousSnapshot.activeVectorDigest,
        currentActiveVectorDigest: nextSnapshot.activeVectorDigest,
        currentToolSnapshotDigest: nextSnapshot.snapshotDigest,
        retainedSourceCount: nextSnapshot.sources.length,
      },
      committedAtMs,
    });
    const committed = await client.query<Row>(
      `SELECT "ql3"."commit_plugin_package_lifecycle"(
         $1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb
       ) AS "created"`,
      [
        JSON.stringify(event),
        JSON.stringify(receipt),
        JSON.stringify(taskWrites),
        impact.action === 'uninstall'
          ? JSON.stringify(null)
          : JSON.stringify(nextSnapshot),
      ],
    );
    if (
      committed.rows.length !== 1 ||
      typeof committed.rows[0]?.created !== 'boolean'
    ) {
      throw unavailable();
    }
    await this.#publishAutomationLifecycle(
      client,
      event,
      record,
      committedAtMs,
    );
    const stored = await this.#findStored(client, event.eventDigest);
    if (!stored || !same(stored, receipt)) throw unavailable();
    return Object.freeze({
      created: committed.rows[0].created,
      receipt: stored,
    });
  }

  async transition(
    eventValue: Readonly<PluginPackageLifecycleEvent>,
    confirmAuthorization: () => void | Promise<void>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackageLifecycleReceipt>;
    }>
  > {
    const event = normalizePluginPackageLifecycleEvent(eventValue);
    if (typeof confirmAuthorization !== 'function') {
      throw new InvalidPluginPackageLifecycleError(
        'confirmAuthorization is invalid',
      );
    }
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        if (attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS) continue;
        throw unavailable(error);
      }
      let began = false;
      let authorizationFailure = false;
      const authorize = async (): Promise<void> => {
        try {
          await confirmAuthorization();
        } catch (error) {
          authorizationFailure = true;
          throw error;
        }
      };
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        await authorize();
        const result = await this.#commit(client, event);
        await authorize();
        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: result.created ? 'created' : 'existing',
          receipt: result.receipt,
        });
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        if (authorizationFailure) throw error;
        const state = postgresSqlState(error);
        if (
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS &&
          (isPostgresAvailabilityError(error) ||
            !state ||
            POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) ||
            state.startsWith('08'))
        ) {
          continue;
        }
        throw mapStorageError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
