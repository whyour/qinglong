import {
  InvalidTaskDefinitionError,
  TaskDefinitionConflictError,
  TaskDefinitionUnavailableError,
  assertTaskDefinitionIdentifier,
  assertTaskDefinitionPageSize,
  assertTaskDefinitionRevision,
  createTaskDefinitionRecord,
  normalizeAppendTaskDefinitionRevisionCommand,
  normalizeTaskDefinitionCursor,
  normalizeTaskDefinitionRecord,
  type AppendTaskDefinitionRevisionCommand,
  type TaskDefinitionPage,
  type TaskDefinitionRecord,
  type TaskDefinitionRepository,
} from '@qinglong/runtime-core/task-definition';
import type { LocalCommandTaskExecutionPlan } from '@qinglong/runtime-core/task-definition-execution-compiler';
import {
  BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
  TaskSpecSemanticRegistry,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';
import type { DatabaseSync } from 'node:sqlite';
import {
  LocalSqliteDispatchDefinitionConflictError,
  LocalSqliteDispatchDefinitionStore,
} from './dispatchDefinitionStore';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type TaskDefinitionRow = Record<string, unknown>;
type LocalExecutionCompiler = (
  definition: TaskDefinitionRecord,
  semanticRegistry: TaskSpecSemanticRegistry,
) => LocalCommandTaskExecutionPlan;

export interface LocalSqliteTaskDefinitionTransactionContext {
  readonly command: Readonly<AppendTaskDefinitionRevisionCommand>;
  readonly replay: Readonly<TaskDefinitionRecord> | null;
}

export type LocalSqliteTaskDefinitionTransactionHook = (
  context: Readonly<LocalSqliteTaskDefinitionTransactionContext>,
) => void;

const SELECT_FIELDS = `
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

function text(row: TaskDefinitionRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new TaskDefinitionUnavailableError();
  return value;
}

function nullableText(row: TaskDefinitionRow, key: string): string | undefined {
  const value = row[key];
  if (value === null) return undefined;
  if (typeof value !== 'string') throw new TaskDefinitionUnavailableError();
  return value;
}

function integer(row: TaskDefinitionRow, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) {
    throw new TaskDefinitionUnavailableError();
  }
  return value as number;
}

function parseJson(row: TaskDefinitionRow, key: string): unknown {
  try {
    return JSON.parse(text(row, key));
  } catch {
    throw new TaskDefinitionUnavailableError();
  }
}

function record(row: TaskDefinitionRow): TaskDefinitionRecord {
  try {
    return normalizeTaskDefinitionRecord({
      projectId: text(row, 'projectId'),
      taskId: text(row, 'taskId'),
      revision: integer(row, 'revision'),
      mutationId: text(row, 'mutationId'),
      name: text(row, 'name'),
      ...(row.description === null
        ? {}
        : { description: nullableText(row, 'description') as string }),
      kind: text(row, 'kind') as TaskDefinitionRecord['kind'],
      spec: parseJson(row, 'specJson') as TaskDefinitionRecord['spec'],
      labels: parseJson(row, 'labelsJson') as TaskDefinitionRecord['labels'],
      enabled: integer(row, 'enabled') === 1,
      contentDigest: text(row, 'contentDigest'),
      createdAtMs: integer(row, 'createdAtMs'),
      updatedAtMs: integer(row, 'updatedAtMs'),
    });
  } catch (error) {
    if (error instanceof TaskDefinitionUnavailableError) throw error;
    throw new TaskDefinitionUnavailableError();
  }
}

function sameRecord(left: TaskDefinitionRecord, right: TaskDefinitionRecord) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof TaskDefinitionConflictError ||
    error instanceof TaskDefinitionUnavailableError
  ) {
    return error;
  }
  if (error instanceof LocalSqliteDispatchDefinitionConflictError) {
    return new TaskDefinitionConflictError();
  }
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  ) {
    return new TaskDefinitionConflictError();
  }
  return new TaskDefinitionUnavailableError();
}

export class LocalSqliteTaskDefinitionRepository
  implements TaskDefinitionRepository
{
  private readonly authority: LocalSqliteOperationAuthority;
  private readonly dispatchDefinitions: LocalSqliteDispatchDefinitionStore;
  private readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;

  constructor(
    authority: LocalSqliteOperationAuthority | DatabaseSync,
    taskSpecSemanticRegistry = createBuiltInTaskSpecSemanticRegistry(),
  ) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.dispatchDefinitions = new LocalSqliteDispatchDefinitionStore(
      this.authority.client,
    );
    this.taskSpecSemanticRegistry = taskSpecSemanticRegistry;
  }

  private localExecutionPlan(
    definition: TaskDefinitionRecord,
    compiler: LocalExecutionCompiler | null,
  ): LocalCommandTaskExecutionPlan | null {
    if (
      !definition.enabled ||
      definition.kind !== 'command' ||
      definition.spec.schema !== BUILT_IN_COMMAND_TASK_SPEC_SCHEMA
    ) {
      return null;
    }
    if (!compiler) throw new TaskDefinitionUnavailableError();
    return compiler(definition, this.taskSpecSemanticRegistry);
  }

  private assertLocalExecutionPlanPublished(
    plan: LocalCommandTaskExecutionPlan,
  ): void {
    const recipe = this.dispatchDefinitions.resolveRecipe(
      plan.contextRecipe.contextRef,
    );
    const revision = this.dispatchDefinitions.resolveRevision({
      projectId: plan.executionRevision.projectId,
      taskId: plan.executionRevision.taskId,
      taskRevision: plan.executionRevision.taskRevision,
    });
    if (
      !recipe ||
      !revision ||
      recipe.contentDigest !== plan.contextRecipe.contentDigest ||
      revision.contentDigest !== plan.executionRevision.contentDigest
    ) {
      throw new TaskDefinitionUnavailableError();
    }
  }

  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    return this.authority.enqueue(
      async () => {
        try {
          return await work();
        } catch (error) {
          throw mapStorageError(error);
        }
      },
      () => new TaskDefinitionUnavailableError(),
    );
  }

  private findCurrent(
    projectId: string,
    taskId: string,
  ): TaskDefinitionRecord | null {
    const row = this.authority.client
      .prepare(
        `SELECT ${SELECT_FIELDS}
         FROM "QingLong3TaskDefinitions" AS head
         JOIN "QingLong3TaskDefinitionRevisions" AS revision
           ON revision."project_id" = head."project_id"
          AND revision."task_id" = head."task_id"
          AND revision."revision" = head."current_revision"
         WHERE head."project_id" = ? AND head."task_id" = ?`,
      )
      .get(projectId, taskId) as TaskDefinitionRow | undefined;
    return row ? record(row) : null;
  }

  private findRevision(
    projectId: string,
    taskId: string,
    revision: number,
  ): TaskDefinitionRecord | null {
    const row = this.authority.client
      .prepare(
        `SELECT ${SELECT_FIELDS}
         FROM "QingLong3TaskDefinitions" AS head
         JOIN "QingLong3TaskDefinitionRevisions" AS revision
           ON revision."project_id" = head."project_id"
          AND revision."task_id" = head."task_id"
         WHERE head."project_id" = ? AND head."task_id" = ?
           AND revision."revision" = ?`,
      )
      .get(projectId, taskId, revision) as TaskDefinitionRow | undefined;
    return row ? record(row) : null;
  }

  private findByMutation(mutationId: string): TaskDefinitionRecord | null {
    const row = this.authority.client
      .prepare(
        `SELECT ${SELECT_FIELDS}
         FROM "QingLong3TaskDefinitionRevisions" AS revision
         JOIN "QingLong3TaskDefinitions" AS head
           ON head."project_id" = revision."project_id"
          AND head."task_id" = revision."task_id"
         WHERE revision."mutation_id" = ?`,
      )
      .get(mutationId) as TaskDefinitionRow | undefined;
    return row ? record(row) : null;
  }

  findCurrentTaskDefinition(
    projectId: string,
    taskId: string,
  ): Promise<TaskDefinitionRecord | null> {
    assertTaskDefinitionIdentifier(projectId, 'projectId');
    assertTaskDefinitionIdentifier(taskId, 'taskId');
    return this.enqueue(() => this.findCurrent(projectId, taskId));
  }

  findTaskDefinitionRevision(
    projectId: string,
    taskId: string,
    revision: number,
  ): Promise<TaskDefinitionRecord | null> {
    assertTaskDefinitionIdentifier(projectId, 'projectId');
    assertTaskDefinitionIdentifier(taskId, 'taskId');
    assertTaskDefinitionRevision(revision);
    return this.enqueue(() => this.findRevision(projectId, taskId, revision));
  }

  listTaskDefinitions(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: { readonly taskId: string };
  }): Promise<TaskDefinitionPage> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new InvalidTaskDefinitionError('list options are invalid');
    }
    const keys = Object.keys(options).sort();
    if (
      !keys.includes('limit') ||
      !keys.includes('projectId') ||
      keys.some((key) => !['after', 'limit', 'projectId'].includes(key))
    ) {
      throw new InvalidTaskDefinitionError(
        'list options have an invalid shape',
      );
    }
    assertTaskDefinitionIdentifier(options.projectId, 'projectId');
    assertTaskDefinitionPageSize(options.limit);
    const after = options.after
      ? normalizeTaskDefinitionCursor(options.after)
      : undefined;
    return this.enqueue(() => {
      const rows = this.authority.client
        .prepare(
          `SELECT ${SELECT_FIELDS}
           FROM "QingLong3TaskDefinitions" AS head
           JOIN "QingLong3TaskDefinitionRevisions" AS revision
             ON revision."project_id" = head."project_id"
            AND revision."task_id" = head."task_id"
            AND revision."revision" = head."current_revision"
           WHERE head."project_id" = ? AND head."task_id" > ?
           ORDER BY head."task_id"
           LIMIT ?`,
        )
        .all(options.projectId, after?.taskId ?? '', options.limit + 1) as
        | TaskDefinitionRow[]
        | undefined;
      if (!Array.isArray(rows)) throw new TaskDefinitionUnavailableError();
      const truncated = rows.length > options.limit;
      const definitions = Object.freeze(
        rows.slice(0, options.limit).map(record),
      );
      const last = definitions.at(-1);
      return Object.freeze({
        definitions,
        truncated,
        ...(truncated && last
          ? { next: Object.freeze({ taskId: last.taskId }) }
          : {}),
      });
    });
  }

  appendTaskDefinitionRevision(
    input: AppendTaskDefinitionRevisionCommand,
    transactionHook?: LocalSqliteTaskDefinitionTransactionHook,
  ): Promise<
    Readonly<{
      status: 'created' | 'updated' | 'existing';
      definition: TaskDefinitionRecord;
    }>
  > {
    if (
      transactionHook !== undefined &&
      typeof transactionHook !== 'function'
    ) {
      throw new InvalidTaskDefinitionError('transaction hook is invalid');
    }
    const normalized = normalizeAppendTaskDefinitionRevisionCommand(input);
    const command = Object.freeze({
      ...normalized,
      spec: this.taskSpecSemanticRegistry.normalize({
        projectId: normalized.projectId,
        taskId: normalized.taskId,
        kind: normalized.kind,
        spec: normalized.spec,
      }),
    });
    const needsLocalExecutionCompiler =
      command.enabled &&
      command.kind === 'command' &&
      command.spec.schema === BUILT_IN_COMMAND_TASK_SPEC_SCHEMA;
    const compiler = needsLocalExecutionCompiler
      ? import(
          '@qinglong/runtime-core/task-definition-execution-compiler'
        ).then(
          ({ compileLocalCommandTaskDefinition }) =>
            compileLocalCommandTaskDefinition,
          () => {
            throw new TaskDefinitionUnavailableError();
          },
        )
      : Promise.resolve(null);
    return compiler.then((compileLocalExecution) =>
      this.authority.enqueue(
        async () => {
          const client = this.authority.client;
          let transactionHookError: unknown;
          try {
            client.exec('BEGIN IMMEDIATE');
            const ownership = client
              .prepare(
                `SELECT package_name AS "packageName"
                 FROM "QingLong3PluginPackageTaskOwnerships"
                 WHERE project_id = ? AND task_id = ?`,
              )
              .get(command.projectId, command.taskId);
            if (ownership) throw new TaskDefinitionConflictError();
            const replay = this.findByMutation(command.mutationId);
            if (transactionHook) {
              let hookResult: void;
              try {
                hookResult = transactionHook(
                  Object.freeze({ command, replay }),
                );
              } catch (error) {
                transactionHookError = error;
                throw error;
              }
              if (hookResult !== undefined) {
                throw new InvalidTaskDefinitionError(
                  'transaction hook must not return a value',
                );
              }
            }
            if (replay) {
              const expected = createTaskDefinitionRecord(
                command,
                replay.createdAtMs,
              );
              if (!sameRecord(replay, expected)) {
                throw new TaskDefinitionConflictError();
              }
              const replayPlan = this.localExecutionPlan(
                replay,
                compileLocalExecution,
              );
              if (replayPlan)
                this.assertLocalExecutionPlanPublished(replayPlan);
              client.exec('COMMIT');
              return Object.freeze({
                status: 'existing' as const,
                definition: replay,
              });
            }

            const project = client
              .prepare(
                `SELECT "status" AS "status"
             FROM "QingLong3Projects" WHERE "id" = ?`,
              )
              .get(command.projectId) as { status?: unknown } | undefined;
            if (project?.status !== 'active') {
              throw new TaskDefinitionConflictError();
            }
            const head = client
              .prepare(
                `SELECT "current_revision" AS "currentRevision",
                    "created_at_ms" AS "createdAtMs",
                    "updated_at_ms" AS "updatedAtMs"
             FROM "QingLong3TaskDefinitions"
             WHERE "project_id" = ? AND "task_id" = ?`,
              )
              .get(command.projectId, command.taskId) as
              | {
                  currentRevision?: unknown;
                  createdAtMs?: unknown;
                  updatedAtMs?: unknown;
                }
              | undefined;
            const currentRevision = head
              ? integer(head, 'currentRevision')
              : null;
            const createdAtMs = head
              ? integer(head, 'createdAtMs')
              : command.occurredAtMs;
            const previousUpdatedAtMs = head
              ? integer(head, 'updatedAtMs')
              : command.occurredAtMs;
            if (
              currentRevision !== command.expectedRevision ||
              command.occurredAtMs < previousUpdatedAtMs
            ) {
              throw new TaskDefinitionConflictError();
            }
            const definition = createTaskDefinitionRecord(command, createdAtMs);
            const executionPlan = this.localExecutionPlan(
              definition,
              compileLocalExecution,
            );
            if (!head) {
              client
                .prepare(
                  `INSERT INTO "QingLong3TaskDefinitions" (
                 "project_id", "task_id", "current_revision",
                 "created_at_ms", "updated_at_ms"
               ) VALUES (?, ?, 1, ?, ?)`,
                )
                .run(
                  command.projectId,
                  command.taskId,
                  definition.createdAtMs,
                  definition.updatedAtMs,
                );
            }
            client
              .prepare(
                `INSERT INTO "QingLong3TaskDefinitionRevisions" (
               "project_id", "task_id", "revision", "mutation_id",
               "name", "description", "kind", "spec_json", "labels_json",
               "enabled", "content_digest", "created_at_ms"
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
            if (executionPlan) {
              this.dispatchDefinitions.appendPlan(executionPlan);
            }
            if (head) {
              const update = client
                .prepare(
                  `UPDATE "QingLong3TaskDefinitions"
               SET "current_revision" = ?, "updated_at_ms" = ?
               WHERE "project_id" = ? AND "task_id" = ?
                 AND "current_revision" = ?`,
                )
                .run(
                  definition.revision,
                  definition.updatedAtMs,
                  definition.projectId,
                  definition.taskId,
                  command.expectedRevision,
                );
              if (update.changes !== 1) {
                throw new TaskDefinitionConflictError();
              }
            }
            client.exec('COMMIT');
            return Object.freeze({
              status: head ? ('updated' as const) : ('created' as const),
              definition,
            });
          } catch (error) {
            if (client.isTransaction) client.exec('ROLLBACK');
            if (error === transactionHookError && error instanceof Error) {
              throw error;
            }
            throw mapStorageError(error);
          }
        },
        () => new TaskDefinitionUnavailableError(),
      ),
    );
  }
}
