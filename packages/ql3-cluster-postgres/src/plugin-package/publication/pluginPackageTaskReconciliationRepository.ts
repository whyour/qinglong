// PostgreSQL adapter owned by Plugin Package publication and recovery.
import type {
  PostgresClient,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  InvalidPluginPackageTaskReconciliationError,
  PluginPackageTaskReconciliationConflictError,
  PluginPackageTaskReconciliationUnavailableError,
  normalizePluginPackageTaskReconciliationReceipt,
  planPluginPackageTaskReconciliation,
  pluginPackageTaskReconciliationTaskIds,
  type PluginPackageTaskOwnershipFact,
  type PluginPackageTaskReconciliationReceipt,
  type PluginPackageTaskReconciliationRepository,
} from '@qinglong/runtime-core/plugin-package-task-reconciliation';
import {
  assertPluginPackageTaskPublicationRecoveryPageSize,
  normalizePluginPackageTaskPublicationRecoveryCursor,
  type PluginPackageTaskPublicationRecoveryPage,
  type PluginPackageTaskPublicationRecoverySource,
} from '@qinglong/runtime-core/plugin-package-task-publication';
import {
  normalizePluginPackageMaterializedRevision,
  type PluginPackageMaterializedRevision,
} from '@qinglong/runtime-core/plugin-package-resource-materialization';
import {
  normalizePluginPackageResourceGeneration,
  type PluginPackageResourceGenerationSource,
} from '@qinglong/runtime-core/plugin-package-resource-generation';
import {
  normalizeTaskDefinitionRecord,
  type TaskDefinitionRecord,
} from '@qinglong/runtime-core/task-definition';
import {
  compileClusterCommandTaskDefinition,
  type ClusterTaskExecutionRevision,
} from '@qinglong/runtime-core/cluster-execution-revision';
import {
  BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
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

type Row = Record<string, unknown>;

const SELECT_TASK_FIELDS = `
  head.project_id AS "projectId",
  head.task_id AS "taskId",
  revision.revision,
  revision.mutation_id AS "mutationId",
  revision.name,
  revision.description,
  revision.kind,
  revision.spec_json AS "specJson",
  revision.labels_json AS "labelsJson",
  revision.enabled,
  revision.content_digest AS "contentDigest",
  head.created_at_ms AS "createdAtMs",
  revision.created_at_ms AS "updatedAtMs"`;

function unavailable(): PluginPackageTaskReconciliationUnavailableError {
  return new PluginPackageTaskReconciliationUnavailableError();
}

function taskRecord(row: Row): Readonly<TaskDefinitionRecord> {
  try {
    const description = row.description;
    if (description !== null && typeof description !== 'string') {
      throw unavailable();
    }
    return normalizeTaskDefinitionRecord({
      projectId: postgresRequiredString(row.projectId, unavailable),
      taskId: postgresRequiredString(row.taskId, unavailable),
      revision: postgresRequiredInteger(row.revision, unavailable),
      mutationId: postgresRequiredString(row.mutationId, unavailable),
      name: postgresRequiredString(row.name, unavailable),
      ...(description === null ? {} : { description }),
      kind: postgresRequiredString(
        row.kind,
        unavailable,
      ) as TaskDefinitionRecord['kind'],
      spec: postgresRequiredJsonObject(
        row.specJson,
        unavailable,
      ) as unknown as TaskDefinitionRecord['spec'],
      labels: postgresRequiredJsonObject(
        row.labelsJson,
        unavailable,
      ) as TaskDefinitionRecord['labels'],
      enabled: postgresRequiredBoolean(row.enabled, unavailable),
      contentDigest: postgresRequiredString(row.contentDigest, unavailable),
      createdAtMs: postgresRequiredInteger(row.createdAtMs, unavailable),
      updatedAtMs: postgresRequiredInteger(row.updatedAtMs, unavailable),
    });
  } catch (error) {
    if (error instanceof PluginPackageTaskReconciliationUnavailableError) {
      throw error;
    }
    throw unavailable();
  }
}

function executionPlanJson(
  value: Readonly<ClusterTaskExecutionRevision>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    command: value.command,
    environment: value.environment,
    ...(value.workingDirectory === undefined
      ? {}
      : { workingDirectory: value.workingDirectory }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    ...(value.placement === undefined
      ? {}
      : { placement: value.placement }),
  });
}

function executionJson(
  value: Readonly<ClusterTaskExecutionRevision>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    projectId: value.projectId,
    taskId: value.taskId,
    sourceRevision: value.sourceRevision,
    taskRevision: value.taskRevision,
    sourceContentDigest: value.sourceContentDigest,
    executorType: value.executorType,
    planSchema: value.planSchema,
    planJson: executionPlanJson(value),
    contentDigest: value.contentDigest,
    createdAtMs: value.createdAtMs,
  });
}

function mappedError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageTaskReconciliationError ||
    error instanceof PluginPackageTaskReconciliationConflictError ||
    error instanceof PluginPackageTaskReconciliationUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (
    state === '23503' ||
    state === '23505' ||
    state === '23514' ||
    state === '40001'
  ) {
    return new PluginPackageTaskReconciliationConflictError(
      'durable generation or TaskDefinition fence changed',
    );
  }
  return new PluginPackageTaskReconciliationUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class PostgresPluginPackageTaskReconciliationRepository
  implements
    PluginPackageTaskReconciliationRepository,
    PluginPackageTaskPublicationRecoverySource
{
  readonly #registry: TaskSpecSemanticRegistry;

  constructor(
    private readonly pool: PostgresPool,
    registry = createBuiltInTaskSpecSemanticRegistry(),
  ) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function' ||
      !(registry instanceof TaskSpecSemanticRegistry)
    ) {
      throw new TypeError(
        'PostgreSQL Package Task reconciliation repository options are invalid',
      );
    }
    this.#registry = registry;
  }

  async #findStored(
    queryable: Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>,
    generationDigest: string,
  ): Promise<Readonly<PluginPackageTaskReconciliationReceipt> | null> {
    const result = await queryable.query<Row>(
      `SELECT receipt_json AS "receiptJson"
       FROM "ql3"."plugin_package_task_reconciliations"
       WHERE generation_digest = $1
       LIMIT 2`,
      [generationDigest],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw unavailable();
    try {
      return normalizePluginPackageTaskReconciliationReceipt(
        postgresRequiredJsonObject(
          result.rows[0]!.receiptJson,
          unavailable,
        ) as unknown as PluginPackageTaskReconciliationReceipt,
      );
    } catch (error) {
      if (error instanceof PluginPackageTaskReconciliationUnavailableError) {
        throw error;
      }
      throw unavailable();
    }
  }

  async find(
    generationDigest: string,
  ): Promise<Readonly<PluginPackageTaskReconciliationReceipt> | null> {
    if (
      typeof generationDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(generationDigest)
    ) {
      throw new InvalidPluginPackageTaskReconciliationError(
        'generationDigest is invalid',
      );
    }
    try {
      return await this.#findStored(this.pool, generationDigest);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async listPendingPage(options: {
    readonly limit: number;
    readonly after?: Readonly<{
      readonly projectId: string;
      readonly packageName: string;
    }>;
  }): Promise<Readonly<PluginPackageTaskPublicationRecoveryPage>> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new InvalidPluginPackageTaskReconciliationError(
        'pending page options are invalid',
      );
    }
    assertPluginPackageTaskPublicationRecoveryPageSize(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizePluginPackageTaskPublicationRecoveryCursor(options.after);
    try {
      const result = await this.pool.query<Row>(
        `SELECT head.project_id AS "projectId",
                head.package_name AS "packageName"
         FROM "ql3"."plugin_package_install_heads" AS head
         JOIN "ql3"."plugin_package_installs" AS install
           ON install.installation_id = head.installation_id
         LEFT JOIN "ql3"."plugin_package_task_reconciliations" AS receipt
           ON receipt.project_id = install.project_id
          AND receipt.package_name = install.package_name
          AND receipt.generation = install.target_generation
          AND receipt.lock_digest = install.lock_digest
         WHERE install.state = 'active'
           AND install.active_lock_digest = install.lock_digest
           AND receipt.generation_digest IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM "ql3"."plugin_package_publisher_provenance" AS provenance
             JOIN "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
               ON revoked.publisher = provenance.publisher
              AND revoked.key_id = provenance.key_id
             WHERE provenance.installation_id = install.installation_id
               AND provenance.lock_digest = install.lock_digest
           )
           AND (
             $1::varchar IS NULL OR head.project_id > $1 OR
             (head.project_id = $1 AND head.package_name > $2)
           )
         ORDER BY head.project_id, head.package_name
         LIMIT $3`,
        [
          after?.projectId ?? null,
          after?.packageName ?? null,
          options.limit + 1,
        ],
      );
      const truncated = result.rows.length > options.limit;
      const candidates = result.rows.slice(0, options.limit).map((row) =>
        Object.freeze({
          projectId: postgresRequiredString(row.projectId, unavailable),
          packageName: postgresRequiredString(row.packageName, unavailable),
        }),
      );
      const last = candidates.at(-1);
      return Object.freeze({
        candidates: Object.freeze(candidates),
        truncated,
        ...(truncated && last
          ? {
              next: Object.freeze({
                projectId: last.projectId,
                packageName: last.packageName,
              }),
            }
          : {}),
      });
    } catch (error) {
      throw mappedError(error);
    }
  }

  async reconcile(
    revisionValue: Readonly<PluginPackageMaterializedRevision>,
    activeGenerationSource: PluginPackageResourceGenerationSource,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackageTaskReconciliationReceipt>;
    }>
  > {
    const revision = normalizePluginPackageMaterializedRevision(
      revisionValue,
      this.#registry,
    );
    if (
      !activeGenerationSource ||
      typeof activeGenerationSource.findActiveResourceGeneration !== 'function'
    ) {
      throw new InvalidPluginPackageTaskReconciliationError(
        'active generation source is invalid',
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
      } catch {
        throw unavailable();
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const existing = await this.#findStored(
          client,
          revision.generation.generationDigest,
        );
        if (existing) {
          if (
            existing.materializedRevisionDigest !== revision.revisionDigest ||
            existing.projectId !== revision.generation.projectId ||
            existing.packageName !== revision.generation.packageName
          ) {
            throw new PluginPackageTaskReconciliationConflictError(
              'generation is bound to another materialized revision',
            );
          }
          await client.query('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing',
            receipt: existing,
          });
        }

        const materialized = await client.query<Row>(
          `SELECT revision_digest AS "revisionDigest"
           FROM "ql3"."plugin_package_materialized_revisions"
           WHERE generation_digest = $1`,
          [revision.generation.generationDigest],
        );
        if (
          materialized.rows.length !== 1 ||
          postgresRequiredString(
            materialized.rows[0]!.revisionDigest,
            unavailable,
          ) !== revision.revisionDigest
        ) {
          throw new PluginPackageTaskReconciliationConflictError(
            'materialized revision is not durably published',
          );
        }
        const install = await client.query<Row>(
          `SELECT install.installation_id AS "installationId",
                  install.state,
                  install.target_generation AS "targetGeneration",
                  install.lock_digest AS "lockDigest",
                  install.previous_active_lock_digest AS "previousLockDigest"
           FROM "ql3"."plugin_package_install_heads" AS head
           JOIN "ql3"."plugin_package_installs" AS install
             ON install.installation_id = head.installation_id
           WHERE head.project_id = $1 AND head.package_name = $2
             AND NOT EXISTS (
               SELECT 1
               FROM "ql3"."plugin_package_publisher_provenance" AS provenance
               JOIN "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
                 ON revoked.publisher = provenance.publisher
                AND revoked.key_id = provenance.key_id
               WHERE provenance.installation_id = install.installation_id
                 AND provenance.lock_digest = install.lock_digest
             )
           FOR UPDATE OF install`,
          [
            revision.generation.projectId,
            revision.generation.packageName,
          ],
        );
        const installRow = install.rows[0];
        if (
          install.rows.length !== 1 ||
          !installRow ||
          postgresRequiredString(installRow.installationId, unavailable) !==
            revision.generation.installationId ||
          postgresRequiredString(installRow.state, unavailable) !== 'active' ||
          postgresRequiredInteger(installRow.targetGeneration, unavailable) !==
            revision.generation.generation ||
          postgresRequiredString(installRow.lockDigest, unavailable) !==
            revision.generation.lockDigest ||
          (installRow.previousLockDigest === null
            ? null
            : postgresRequiredString(
                installRow.previousLockDigest,
                unavailable,
              )) !== revision.generation.previousActiveLockDigest
        ) {
          throw new PluginPackageTaskReconciliationConflictError(
            'Package install head is not the materialized generation',
          );
        }
        const previousResult =
          revision.generation.generation === 1
            ? { rows: [] as Row[] }
            : await client.query<Row>(
                `SELECT receipt_json AS "receiptJson"
                 FROM "ql3"."plugin_package_task_reconciliations"
                 WHERE project_id = $1 AND package_name = $2
                   AND generation = $3`,
                [
                  revision.generation.projectId,
                  revision.generation.packageName,
                  revision.generation.generation - 1,
                ],
              );
        const previous =
          previousResult.rows.length === 0
            ? null
            : normalizePluginPackageTaskReconciliationReceipt(
                postgresRequiredJsonObject(
                  previousResult.rows[0]!.receiptJson,
                  unavailable,
                ) as unknown as PluginPackageTaskReconciliationReceipt,
              );
        if (
          previousResult.rows.length > 1 ||
          (revision.generation.generation > 1 && previous === null)
        ) {
          throw new PluginPackageTaskReconciliationConflictError(
            'previous generation receipt is missing',
          );
        }
        const taskIds = pluginPackageTaskReconciliationTaskIds(
          revision,
          previous,
          this.#registry,
        );
        const facts: PluginPackageTaskOwnershipFact[] = [];
        for (const taskId of taskIds) {
          const result = await client.query<Row>(
            `SELECT
               ${SELECT_TASK_FIELDS},
               ownership.package_name AS "ownerPackageName"
             FROM (SELECT 1) AS seed
             LEFT JOIN "ql3"."task_definitions" AS head
               ON head.project_id = $1 AND head.task_id = $2
             LEFT JOIN "ql3"."task_definition_revisions" AS revision
               ON revision.project_id = head.project_id
              AND revision.task_id = head.task_id
              AND revision.revision = head.current_revision
             LEFT JOIN "ql3"."plugin_package_task_ownerships" AS ownership
               ON ownership.project_id = $1 AND ownership.task_id = $2`,
            [revision.generation.projectId, taskId],
          );
          if (result.rows.length !== 1) throw unavailable();
          const row = result.rows[0]!;
          facts.push(
            Object.freeze({
              taskId,
              packageName:
                row.ownerPackageName === null
                  ? null
                  : postgresRequiredString(
                      row.ownerPackageName,
                      unavailable,
                    ),
              current: row.revision === null ? null : taskRecord(row),
            }),
          );
        }
        const clock = await client.query<Row>(
          `SELECT floor(
             extract(epoch FROM clock_timestamp()) * 1000
           )::bigint AS "nowMs"`,
        );
        if (clock.rows.length !== 1) throw unavailable();
        const plan = planPluginPackageTaskReconciliation({
          revision,
          previousReceipt: previous,
          facts: Object.freeze(facts),
          committedAtMs: postgresRequiredInteger(
            clock.rows[0]!.nowMs,
            unavailable,
          ),
          taskSpecSemanticRegistry: this.#registry,
        });
        const activeValue =
          await activeGenerationSource.findActiveResourceGeneration(
            revision.generation.projectId,
            revision.generation.packageName,
          );
        if (
          activeValue === null ||
          normalizePluginPackageResourceGeneration(activeValue)
            .generationDigest !== revision.generation.generationDigest
        ) {
          throw new PluginPackageTaskReconciliationConflictError(
            'active generation changed during reconciliation',
          );
        }
        const executions = plan.writes.flatMap(({ definition }) =>
          definition.enabled &&
          definition.kind === 'command' &&
          definition.spec.schema === BUILT_IN_COMMAND_TASK_SPEC_SCHEMA
            ? [
                executionJson(
                  compileClusterCommandTaskDefinition(
                    definition,
                    this.#registry,
                  ),
                ),
              ]
            : [],
        );
        const committed = await client.query<Row>(
          `SELECT "ql3"."commit_plugin_package_task_reconciliation"(
             $1::char(64), $2::char(64), $3::jsonb, $4::jsonb, $5::jsonb
           ) AS "created"`,
          [
            revision.generation.generationDigest,
            revision.revisionDigest,
            JSON.stringify(plan.receipt),
            JSON.stringify(plan.writes),
            JSON.stringify(executions),
          ],
        );
        if (
          committed.rows.length !== 1 ||
          typeof committed.rows[0]!.created !== 'boolean'
        ) {
          throw unavailable();
        }
        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: committed.rows[0]!.created ? 'created' : 'existing',
          receipt: plan.receipt,
        });
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
}
