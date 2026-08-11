import type { DatabaseSync } from 'node:sqlite';

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
  compileLocalCommandTaskDefinition,
} from '@qinglong/runtime-core/task-definition-execution-compiler';
import {
  BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
  TaskSpecSemanticRegistry,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';

import { LocalSqliteDispatchDefinitionStore } from '../task-definition/dispatchDefinitionStore';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

const SELECT_TASK_FIELDS = `
  head."project_id" AS "projectId",
  head."task_id" AS "taskId",
  revision."revision" AS "revision",
  revision."mutation_id" AS "mutationId",
  revision."name" AS "name",
  revision."description" AS "description",
  revision."kind" AS "kind",
  revision."spec_json" AS "specJson",
  revision."labels_json" AS "labelsJson",
  revision."enabled" AS "enabled",
  revision."content_digest" AS "contentDigest",
  head."created_at_ms" AS "createdAtMs",
  revision."created_at_ms" AS "updatedAtMs"`;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new PluginPackageTaskReconciliationUnavailableError();
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return text(row, key);
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackageTaskReconciliationUnavailableError();
  }
  return value as number;
}

function json(row: Row, key: string): unknown {
  try {
    return JSON.parse(text(row, key));
  } catch {
    throw new PluginPackageTaskReconciliationUnavailableError();
  }
}

function taskRecord(row: Row): Readonly<TaskDefinitionRecord> {
  try {
    return normalizeTaskDefinitionRecord({
      projectId: text(row, 'projectId'),
      taskId: text(row, 'taskId'),
      revision: integer(row, 'revision'),
      mutationId: text(row, 'mutationId'),
      name: text(row, 'name'),
      ...(row.description === null
        ? {}
        : { description: text(row, 'description') }),
      kind: text(row, 'kind') as TaskDefinitionRecord['kind'],
      spec: json(row, 'specJson') as TaskDefinitionRecord['spec'],
      labels: json(row, 'labelsJson') as TaskDefinitionRecord['labels'],
      enabled: integer(row, 'enabled') === 1,
      contentDigest: text(row, 'contentDigest'),
      createdAtMs: integer(row, 'createdAtMs'),
      updatedAtMs: integer(row, 'updatedAtMs'),
    });
  } catch (error) {
    if (error instanceof PluginPackageTaskReconciliationUnavailableError) {
      throw error;
    }
    throw new PluginPackageTaskReconciliationUnavailableError();
  }
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackageTaskReconciliationError ||
    error instanceof PluginPackageTaskReconciliationConflictError ||
    error instanceof PluginPackageTaskReconciliationUnavailableError
  ) {
    return error;
  }
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  ) {
    return new PluginPackageTaskReconciliationConflictError(
      'durable reconciliation identity is already bound',
    );
  }
  return new PluginPackageTaskReconciliationUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class LocalSqlitePluginPackageTaskReconciliationRepository
  implements
    PluginPackageTaskReconciliationRepository,
    PluginPackageTaskPublicationRecoverySource
{
  readonly #authority: LocalSqliteOperationAuthority;
  readonly #dispatchDefinitions: LocalSqliteDispatchDefinitionStore;
  readonly #registry: TaskSpecSemanticRegistry;

  constructor(
    authority: LocalSqliteOperationAuthority | DatabaseSync,
    registry = createBuiltInTaskSpecSemanticRegistry(),
  ) {
    if (!(registry instanceof TaskSpecSemanticRegistry)) {
      throw new TypeError('TaskSpec semantic registry is invalid');
    }
    this.#authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.#dispatchDefinitions = new LocalSqliteDispatchDefinitionStore(
      this.#authority.client,
    );
    this.#registry = registry;
  }

  #findStored(
    generationDigest: string,
  ): Readonly<PluginPackageTaskReconciliationReceipt> | null {
    const row = this.#authority.client
      .prepare(
        `SELECT receipt_json AS "receiptJson"
         FROM "QingLong3PluginPackageTaskReconciliations"
         WHERE generation_digest = ?`,
      )
      .get(generationDigest) as Row | undefined;
    if (!row) return null;
    try {
      return normalizePluginPackageTaskReconciliationReceipt(
        json(row, 'receiptJson') as PluginPackageTaskReconciliationReceipt,
      );
    } catch (error) {
      if (error instanceof PluginPackageTaskReconciliationUnavailableError) {
        throw error;
      }
      throw new PluginPackageTaskReconciliationUnavailableError();
    }
  }

  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    return this.#authority.enqueue(
      async () => {
        try {
          return await work();
        } catch (error) {
          throw mapStorageError(error);
        }
      },
      () => new PluginPackageTaskReconciliationUnavailableError(),
    );
  }

  find(
    generationDigest: string,
  ): Promise<Readonly<PluginPackageTaskReconciliationReceipt> | null> {
    if (typeof generationDigest !== 'string' || !/^[0-9a-f]{64}$/.test(generationDigest)) {
      throw new InvalidPluginPackageTaskReconciliationError(
        'generationDigest is invalid',
      );
    }
    return this.#enqueue(() => this.#findStored(generationDigest));
  }

  listPendingPage(options: {
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
    return this.#enqueue(() => {
      const rows = this.#authority.client
        .prepare(
          `SELECT head.project_id AS "projectId",
                  head.package_name AS "packageName"
           FROM "QingLong3PluginPackageInstallHeads" AS head
           JOIN "QingLong3PluginPackageInstalls" AS install
             ON install.installation_id = head.installation_id
           LEFT JOIN "QingLong3PluginPackageTaskReconciliations" AS receipt
             ON receipt.project_id = install.project_id
            AND receipt.package_name = install.package_name
            AND receipt.generation = install.target_generation
            AND receipt.lock_digest = install.lock_digest
           WHERE install.state = 'active'
             AND install.active_lock_digest = install.lock_digest
             AND receipt.generation_digest IS NULL
             AND (
               ? IS NULL OR head.project_id > ? OR
               (head.project_id = ? AND head.package_name > ?)
             )
           ORDER BY head.project_id, head.package_name
           LIMIT ?`,
        )
        .all(
          after?.projectId ?? null,
          after?.projectId ?? null,
          after?.projectId ?? null,
          after?.packageName ?? null,
          options.limit + 1,
        ) as Row[];
      const truncated = rows.length > options.limit;
      const candidates = rows.slice(0, options.limit).map((row) =>
        Object.freeze({
          projectId: text(row, 'projectId'),
          packageName: text(row, 'packageName'),
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
    });
  }

  reconcile(
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
    return this.#enqueue(async () => {
      const client = this.#authority.client;
      client.exec('BEGIN IMMEDIATE');
      try {
        const existing = this.#findStored(
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
          client.exec('COMMIT');
          return Object.freeze({
            status: 'existing' as const,
            receipt: existing,
          });
        }

        const materialized = client
          .prepare(
            `SELECT revision_digest AS "revisionDigest"
             FROM "QingLong3PluginPackageMaterializedRevisions"
             WHERE generation_digest = ?`,
          )
          .get(revision.generation.generationDigest) as Row | undefined;
        if (
          !materialized ||
          text(materialized, 'revisionDigest') !== revision.revisionDigest
        ) {
          throw new PluginPackageTaskReconciliationConflictError(
            'materialized revision is not durably published',
          );
        }
        const install = client
          .prepare(
            `SELECT
               install.installation_id AS "installationId",
               install.state AS "state",
               install.target_generation AS "targetGeneration",
               install.lock_digest AS "lockDigest",
               install.previous_active_lock_digest AS "previousLockDigest"
             FROM "QingLong3PluginPackageInstallHeads" AS head
             JOIN "QingLong3PluginPackageInstalls" AS install
               ON install.installation_id = head.installation_id
             WHERE head.project_id = ? AND head.package_name = ?`,
          )
          .get(
            revision.generation.projectId,
            revision.generation.packageName,
          ) as Row | undefined;
        if (
          !install ||
          text(install, 'installationId') !==
            revision.generation.installationId ||
          text(install, 'state') !== 'active' ||
          integer(install, 'targetGeneration') !==
            revision.generation.generation ||
          text(install, 'lockDigest') !== revision.generation.lockDigest ||
          nullableText(install, 'previousLockDigest') !==
            revision.generation.previousActiveLockDigest
        ) {
          throw new PluginPackageTaskReconciliationConflictError(
            'Package install head is not the materialized generation',
          );
        }
        const previous =
          revision.generation.generation === 1
            ? null
            : (() => {
                const row = client
                  .prepare(
                    `SELECT receipt_json AS "receiptJson"
                     FROM "QingLong3PluginPackageTaskReconciliations"
                     WHERE project_id = ? AND package_name = ?
                       AND generation = ?`,
                  )
                  .get(
                    revision.generation.projectId,
                    revision.generation.packageName,
                    revision.generation.generation - 1,
                  ) as Row | undefined;
                return row
                  ? normalizePluginPackageTaskReconciliationReceipt(
                      json(row, 'receiptJson') as PluginPackageTaskReconciliationReceipt,
                    )
                  : null;
              })();
        const taskIds = pluginPackageTaskReconciliationTaskIds(
          revision,
          previous,
          this.#registry,
        );
        const facts: PluginPackageTaskOwnershipFact[] = taskIds.map((taskId) => {
          const row = client
            .prepare(
              `SELECT
                 ${SELECT_TASK_FIELDS},
                 ownership.package_name AS "ownerPackageName"
               FROM (SELECT 1) AS seed
               LEFT JOIN "QingLong3TaskDefinitions" AS head
                 ON head.project_id = ? AND head.task_id = ?
               LEFT JOIN "QingLong3TaskDefinitionRevisions" AS revision
                 ON revision.project_id = head.project_id
                AND revision.task_id = head.task_id
                AND revision.revision = head.current_revision
               LEFT JOIN "QingLong3PluginPackageTaskOwnerships" AS ownership
                 ON ownership.project_id = ? AND ownership.task_id = ?`,
            )
            .get(
              revision.generation.projectId,
              taskId,
              revision.generation.projectId,
              taskId,
            ) as Row;
          return Object.freeze({
            taskId,
            packageName:
              row.ownerPackageName === null
                ? null
                : text(row, 'ownerPackageName'),
            current: row.revision === null ? null : taskRecord(row),
          });
        });
        const clock = client
          .prepare(
            `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS "nowMs"`,
          )
          .get() as Row;
        const plan = planPluginPackageTaskReconciliation({
          revision,
          previousReceipt: previous,
          facts: Object.freeze(facts),
          committedAtMs: integer(clock, 'nowMs'),
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

        for (const write of plan.writes) {
          const definition = write.definition;
          if (write.command.expectedRevision === null) {
            client
              .prepare(
                `INSERT INTO "QingLong3TaskDefinitions" (
                   project_id, task_id, current_revision,
                   created_at_ms, updated_at_ms
                 ) VALUES (?, ?, 1, ?, ?)`,
              )
              .run(
                definition.projectId,
                definition.taskId,
                definition.createdAtMs,
                definition.updatedAtMs,
              );
            client
              .prepare(
                `INSERT INTO "QingLong3PluginPackageTaskOwnerships" (
                   project_id, task_id, package_name,
                   claimed_generation_digest, created_at_ms
                 ) VALUES (?, ?, ?, ?, ?)`,
              )
              .run(
                definition.projectId,
                definition.taskId,
                revision.generation.packageName,
                revision.generation.generationDigest,
                plan.receipt.committedAtMs,
              );
          }
          client
            .prepare(
              `INSERT INTO "QingLong3TaskDefinitionRevisions" (
                 project_id, task_id, revision, mutation_id, name,
                 description, kind, spec_json, labels_json, enabled,
                 content_digest, created_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              definition.projectId,
              definition.taskId,
              definition.revision,
              definition.mutationId,
              definition.name,
              definition.description ?? null,
              definition.kind,
              JSON.stringify(definition.spec),
              JSON.stringify(definition.labels),
              definition.enabled ? 1 : 0,
              definition.contentDigest,
              definition.updatedAtMs,
            );
          if (
            definition.enabled &&
            definition.kind === 'command' &&
            definition.spec.schema === BUILT_IN_COMMAND_TASK_SPEC_SCHEMA
          ) {
            this.#dispatchDefinitions.appendPlan(
              compileLocalCommandTaskDefinition(definition, this.#registry),
            );
          }
          if (write.command.expectedRevision !== null) {
            const update = client
              .prepare(
                `UPDATE "QingLong3TaskDefinitions"
                 SET current_revision = ?, updated_at_ms = ?
                 WHERE project_id = ? AND task_id = ?
                   AND current_revision = ?`,
              )
              .run(
                definition.revision,
                definition.updatedAtMs,
                definition.projectId,
                definition.taskId,
                write.command.expectedRevision,
              );
            if (update.changes !== 1) {
              throw new PluginPackageTaskReconciliationConflictError(
                'TaskDefinition head changed during reconciliation',
              );
            }
          }
        }
        client
          .prepare(
            `INSERT INTO "QingLong3PluginPackageTaskReconciliations" (
               generation_digest, project_id, package_name, generation,
               materialized_revision_digest, lock_digest,
               previous_lock_digest, receipt_digest, receipt_json,
               committed_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            plan.receipt.generationDigest,
            plan.receipt.projectId,
            plan.receipt.packageName,
            plan.receipt.generation,
            plan.receipt.materializedRevisionDigest,
            plan.receipt.lockDigest,
            plan.receipt.previousLockDigest,
            plan.receipt.receiptDigest,
            JSON.stringify(plan.receipt),
            plan.receipt.committedAtMs,
          );
        const insertItem = client.prepare(
          `INSERT INTO "QingLong3PluginPackageTaskReconciliationItems" (
             generation_digest, task_id, revision, disposition, content_digest
           ) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const item of plan.receipt.items) {
          insertItem.run(
            plan.receipt.generationDigest,
            item.taskId,
            item.revision,
            item.disposition,
            item.contentDigest,
          );
        }
        client.exec('COMMIT');
        return Object.freeze({
          status: 'created' as const,
          receipt: plan.receipt,
        });
      } catch (error) {
        if (client.isTransaction) client.exec('ROLLBACK');
        throw error;
      }
    });
  }
}
