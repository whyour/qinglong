// PostgreSQL authority for Task Definition publication and execution revisions.
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
  type TaskDefinitionSource,
} from '@qinglong/runtime-core/task-definition';
import {
  BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
  TaskSpecSemanticRegistry,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';
import {
  compileClusterCommandTaskDefinition,
  normalizeClusterTaskExecutionRevision,
  type ClusterTaskExecutionRevision,
  type ClusterTaskExecutionRevisionSource,
} from '@qinglong/runtime-core/cluster-execution-revision';
import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryResult,
} from '@qinglong/runtime-core';
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
} from '../repository/definitionRepositorySupport';

type TaskDefinitionRow = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

export interface PostgresTaskDefinitionRevisionTransactionContext {
  readonly command: Readonly<AppendTaskDefinitionRevisionCommand>;
  readonly replay: Readonly<TaskDefinitionRecord> | null;
  readonly record: Readonly<TaskDefinitionRecord>;
}

export type PostgresTaskDefinitionRevisionTransactionHook = (
  client: PostgresClient,
  context: Readonly<PostgresTaskDefinitionRevisionTransactionContext>,
) => Promise<void>;

const SELECT_FIELDS = `
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

function unavailable(): TaskDefinitionUnavailableError {
  return new TaskDefinitionUnavailableError();
}

function taskDefinitionRecord(row: TaskDefinitionRow): TaskDefinitionRecord {
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
    if (error instanceof TaskDefinitionUnavailableError) throw error;
    throw unavailable();
  }
}

function sameRecord(
  left: TaskDefinitionRecord,
  right: TaskDefinitionRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function executionPlanJson(
  revision: ClusterTaskExecutionRevision,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    command: revision.command,
    environment: revision.environment,
    ...(revision.environmentBundleRef === undefined
      ? {}
      : { environmentBundleRef: revision.environmentBundleRef }),
    ...(revision.workingDirectory === undefined
      ? {}
      : { workingDirectory: revision.workingDirectory }),
    ...(revision.timeoutMs === undefined
      ? {}
      : { timeoutMs: revision.timeoutMs }),
    ...(revision.placement === undefined
      ? {}
      : { placement: revision.placement }),
  });
}

function executionRevision(
  row: TaskDefinitionRow,
): ClusterTaskExecutionRevision {
  try {
    const plan = postgresRequiredJsonObject(row.planJson, unavailable);
    const keys = Object.keys(plan);
    if (
      !keys.includes('command') ||
      !keys.includes('environment') ||
      keys.some(
        (key) =>
          ![
            'command',
            'environment',
            'environmentBundleRef',
            'placement',
            'timeoutMs',
            'workingDirectory',
          ].includes(key),
      )
    ) {
      throw unavailable();
    }
    return normalizeClusterTaskExecutionRevision({
      projectId: postgresRequiredString(row.projectId, unavailable),
      taskId: postgresRequiredString(row.taskId, unavailable),
      sourceRevision: postgresRequiredInteger(row.sourceRevision, unavailable),
      taskRevision: postgresRequiredString(row.taskRevision, unavailable),
      sourceContentDigest: postgresRequiredString(
        row.sourceContentDigest,
        unavailable,
      ),
      executorType: postgresRequiredString(
        row.executorType,
        unavailable,
      ) as ClusterTaskExecutionRevision['executorType'],
      planSchema: postgresRequiredString(
        row.planSchema,
        unavailable,
      ) as ClusterTaskExecutionRevision['planSchema'],
      command: plan.command as ClusterTaskExecutionRevision['command'],
      environment:
        plan.environment as ClusterTaskExecutionRevision['environment'],
      ...(plan.environmentBundleRef === undefined
        ? {}
        : { environmentBundleRef: plan.environmentBundleRef as string }),
      ...(plan.workingDirectory === undefined
        ? {}
        : { workingDirectory: plan.workingDirectory as string }),
      ...(plan.timeoutMs === undefined
        ? {}
        : { timeoutMs: plan.timeoutMs as number }),
      ...(plan.placement === undefined
        ? {}
        : {
            placement: plan.placement as unknown as NonNullable<
              ClusterTaskExecutionRevision['placement']
            >,
          }),
      contentDigest: postgresRequiredString(row.contentDigest, unavailable),
      createdAtMs: postgresRequiredInteger(row.createdAtMs, unavailable),
    });
  } catch (error) {
    if (error instanceof TaskDefinitionUnavailableError) throw error;
    throw unavailable();
  }
}

export async function findExecutionRevision(
  queryable: Queryable,
  projectId: string,
  taskId: string,
  sourceRevision: number,
): Promise<ClusterTaskExecutionRevision | null> {
  const result = await queryable.query<TaskDefinitionRow>(
    `SELECT project_id AS "projectId", task_id AS "taskId",
            source_revision AS "sourceRevision",
            task_revision AS "taskRevision",
            source_content_digest AS "sourceContentDigest",
            executor_type AS "executorType", plan_schema AS "planSchema",
            plan_json AS "planJson", content_digest AS "contentDigest",
            created_at_ms AS "createdAtMs"
     FROM "ql3"."task_execution_revisions"
     WHERE project_id = $1 AND task_id = $2 AND source_revision = $3
       AND executor_type = 'remote_worker'
     LIMIT 2`,
    [projectId, taskId, sourceRevision],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return executionRevision(result.rows[0]!);
}

function sameExecutionRevision(
  left: ClusterTaskExecutionRevision | null,
  right: ClusterTaskExecutionRevision | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mappedError(error: unknown): Error {
  if (
    error instanceof TaskDefinitionConflictError ||
    error instanceof TaskDefinitionUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new TaskDefinitionConflictError();
  }
  return unavailable();
}

async function findCurrent(
  queryable: Queryable,
  projectId: string,
  taskId: string,
): Promise<TaskDefinitionRecord | null> {
  const result = await queryable.query<TaskDefinitionRow>(
    `SELECT ${SELECT_FIELDS}
     FROM "ql3"."task_definitions" AS head
     LEFT JOIN "ql3"."task_definition_revisions" AS revision
       ON revision.project_id = head.project_id
      AND revision.task_id = head.task_id
      AND revision.revision = head.current_revision
     WHERE head.project_id = $1 AND head.task_id = $2
     LIMIT 2`,
    [projectId, taskId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return taskDefinitionRecord(result.rows[0]!);
}

async function findRevision(
  queryable: Queryable,
  projectId: string,
  taskId: string,
  revision: number,
): Promise<TaskDefinitionRecord | null> {
  const result = await queryable.query<TaskDefinitionRow>(
    `SELECT ${SELECT_FIELDS}
     FROM "ql3"."task_definitions" AS head
     JOIN "ql3"."task_definition_revisions" AS revision
       ON revision.project_id = head.project_id
      AND revision.task_id = head.task_id
     WHERE head.project_id = $1 AND head.task_id = $2
       AND revision.revision = $3
     LIMIT 2`,
    [projectId, taskId, revision],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return taskDefinitionRecord(result.rows[0]!);
}

async function findByMutation(
  queryable: Queryable,
  mutationId: string,
): Promise<TaskDefinitionRecord | null> {
  const result = await queryable.query<TaskDefinitionRow>(
    `SELECT ${SELECT_FIELDS}
     FROM "ql3"."task_definition_revisions" AS revision
     JOIN "ql3"."task_definitions" AS head
       ON head.project_id = revision.project_id
      AND head.task_id = revision.task_id
     WHERE revision.mutation_id = $1
     LIMIT 2`,
    [mutationId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return taskDefinitionRecord(result.rows[0]!);
}

/** Read-only PostgreSQL TaskDefinition port for the runtime role. */
export class PostgresTaskDefinitionSource implements TaskDefinitionSource {
  constructor(protected readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL TaskDefinition pool is invalid');
    }
  }

  async findCurrentTaskDefinition(
    projectId: string,
    taskId: string,
  ): Promise<TaskDefinitionRecord | null> {
    assertTaskDefinitionIdentifier(projectId, 'projectId');
    assertTaskDefinitionIdentifier(taskId, 'taskId');
    try {
      return await findCurrent(this.pool, projectId, taskId);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async findTaskDefinitionRevision(
    projectId: string,
    taskId: string,
    revision: number,
  ): Promise<TaskDefinitionRecord | null> {
    assertTaskDefinitionIdentifier(projectId, 'projectId');
    assertTaskDefinitionIdentifier(taskId, 'taskId');
    assertTaskDefinitionRevision(revision);
    try {
      return await findRevision(this.pool, projectId, taskId, revision);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async listTaskDefinitions(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: { readonly taskId: string };
  }): Promise<TaskDefinitionPage> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new InvalidTaskDefinitionError('list options are invalid');
    }
    const keys = Object.keys(options);
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
    try {
      const result = await this.pool.query<TaskDefinitionRow>(
        `SELECT ${SELECT_FIELDS}
         FROM "ql3"."task_definitions" AS head
         LEFT JOIN "ql3"."task_definition_revisions" AS revision
           ON revision.project_id = head.project_id
          AND revision.task_id = head.task_id
          AND revision.revision = head.current_revision
         WHERE head.project_id = $1 AND head.task_id > $2
         ORDER BY head.task_id
         LIMIT $3`,
        [options.projectId, after?.taskId ?? '', options.limit + 1],
      );
      const truncated = result.rows.length > options.limit;
      const definitions = Object.freeze(
        result.rows.slice(0, options.limit).map(taskDefinitionRecord),
      );
      const last = definitions.at(-1);
      return Object.freeze({
        definitions,
        truncated,
        ...(truncated && last
          ? { next: Object.freeze({ taskId: last.taskId }) }
          : {}),
      });
    } catch (error) {
      throw mappedError(error);
    }
  }
}

/** Read-only, digest-verifying remote Worker execution revision source. */
export class PostgresTaskExecutionRevisionSource
  implements ClusterTaskExecutionRevisionSource
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL Task execution revision pool is invalid');
    }
  }

  async resolveClusterTaskExecutionRevision(identity: {
    readonly projectId: string;
    readonly taskId: string;
    readonly sourceRevision: number;
  }): Promise<ClusterTaskExecutionRevision | null> {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      throw new TypeError(
        'Cluster Task execution revision identity is invalid',
      );
    }
    assertTaskDefinitionIdentifier(identity.projectId, 'projectId');
    assertTaskDefinitionIdentifier(identity.taskId, 'taskId');
    assertTaskDefinitionRevision(identity.sourceRevision);
    try {
      return await findExecutionRevision(
        this.pool,
        identity.projectId,
        identity.taskId,
        identity.sourceRevision,
      );
    } catch (error) {
      throw mappedError(error);
    }
  }
}

/** Administration-only TaskDefinition publisher; execution revisions are separate. */
export class PostgresTaskDefinitionRepository
  extends PostgresTaskDefinitionSource
  implements TaskDefinitionRepository
{
  constructor(
    pool: PostgresPool,
    private readonly semanticRegistry: TaskSpecSemanticRegistry = createBuiltInTaskSpecSemanticRegistry(),
  ) {
    super(pool);
  }

  async appendTaskDefinitionRevision(
    input: AppendTaskDefinitionRevisionCommand,
    transactionHook?: PostgresTaskDefinitionRevisionTransactionHook,
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
      spec: this.semanticRegistry.normalize({
        projectId: normalized.projectId,
        taskId: normalized.taskId,
        kind: normalized.kind,
        spec: normalized.spec,
      }),
    });
    const compiledExecution =
      command.enabled &&
      command.kind === 'command' &&
      command.spec.schema === BUILT_IN_COMMAND_TASK_SPEC_SCHEMA
        ? compileClusterCommandTaskDefinition(
            createTaskDefinitionRecord(command, command.occurredAtMs),
            this.semanticRegistry,
          )
        : null;

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
        const ownership = await client.query(
          `SELECT 1
           FROM "ql3"."plugin_package_task_ownerships"
           WHERE project_id = $1 AND task_id = $2`,
          [command.projectId, command.taskId],
        );
        if (ownership.rows.length !== 0) {
          throw new TaskDefinitionConflictError();
        }
        const replay = await findByMutation(client, command.mutationId);
        if (replay) {
          const expected = createTaskDefinitionRecord(
            command,
            replay.createdAtMs,
          );
          if (!sameRecord(replay, expected)) {
            throw new TaskDefinitionConflictError();
          }
          const persistedExecution = await findExecutionRevision(
            client,
            replay.projectId,
            replay.taskId,
            replay.revision,
          );
          if (!sameExecutionRevision(persistedExecution, compiledExecution)) {
            throw unavailable();
          }
          if (transactionHook) {
            try {
              const hookResult = await transactionHook(
                client,
                Object.freeze({ command, replay, record: replay }),
              );
              if (hookResult !== undefined) {
                throw new InvalidTaskDefinitionError(
                  'transaction hook must not return a value',
                );
              }
            } catch (error) {
              transactionHookError = error;
              throw error;
            }
          }
          await client.query('COMMIT');
          began = false;
          return Object.freeze({ status: 'existing', definition: replay });
        }

        const project = await client.query<{ status: unknown }>(
          `SELECT status FROM "ql3"."projects"
           WHERE id = $1`,
          [command.projectId],
        );
        if (project.rows.length !== 1 || project.rows[0]?.status !== 'active') {
          throw new TaskDefinitionConflictError();
        }

        const inserted = await client.query(
          `INSERT INTO "ql3"."task_definitions" (
             project_id, task_id, current_revision, created_at_ms, updated_at_ms
           ) VALUES ($1, $2, 1, $3, $3)
           ON CONFLICT (project_id, task_id) DO NOTHING
           RETURNING task_id`,
          [command.projectId, command.taskId, command.occurredAtMs],
        );
        if (inserted.rows.length > 1) throw unavailable();
        const created = inserted.rows.length === 1;
        const head = await client.query<TaskDefinitionRow>(
          `SELECT current_revision AS "currentRevision",
                  created_at_ms AS "createdAtMs",
                  updated_at_ms AS "updatedAtMs"
           FROM "ql3"."task_definitions"
           WHERE project_id = $1 AND task_id = $2
           FOR UPDATE`,
          [command.projectId, command.taskId],
        );
        if (head.rows.length !== 1) throw unavailable();
        const currentRevision = postgresRequiredInteger(
          head.rows[0]!.currentRevision,
          unavailable,
        );
        const createdAtMs = postgresRequiredInteger(
          head.rows[0]!.createdAtMs,
          unavailable,
        );
        const previousUpdatedAtMs = postgresRequiredInteger(
          head.rows[0]!.updatedAtMs,
          unavailable,
        );
        if (
          (created
            ? command.expectedRevision !== null
            : currentRevision !== command.expectedRevision) ||
          command.occurredAtMs < previousUpdatedAtMs
        ) {
          throw new TaskDefinitionConflictError();
        }
        const definition = createTaskDefinitionRecord(command, createdAtMs);
        await client.query(
          `INSERT INTO "ql3"."task_definition_revisions" (
             project_id, task_id, revision, mutation_id, name, description,
             kind, spec_json, labels_json, enabled, content_digest, created_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
                     $10, $11, $12)`,
          [
            definition.projectId,
            definition.taskId,
            definition.revision,
            definition.mutationId,
            definition.name,
            definition.description ?? null,
            definition.kind,
            JSON.stringify(definition.spec),
            JSON.stringify(definition.labels),
            definition.enabled,
            definition.contentDigest,
            definition.updatedAtMs,
          ],
        );
        if (compiledExecution) {
          await client.query(
            `INSERT INTO "ql3"."task_execution_revisions" (
               project_id, task_id, source_revision, task_revision,
               source_content_digest, executor_type, plan_schema, plan_json,
               content_digest, created_at_ms
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
            [
              compiledExecution.projectId,
              compiledExecution.taskId,
              compiledExecution.sourceRevision,
              compiledExecution.taskRevision,
              compiledExecution.sourceContentDigest,
              compiledExecution.executorType,
              compiledExecution.planSchema,
              JSON.stringify(executionPlanJson(compiledExecution)),
              compiledExecution.contentDigest,
              compiledExecution.createdAtMs,
            ],
          );
        }
        if (!created) {
          const update = await client.query(
            `UPDATE "ql3"."task_definitions"
             SET current_revision = $1, updated_at_ms = $2
             WHERE project_id = $3 AND task_id = $4
               AND current_revision = $5`,
            [
              definition.revision,
              definition.updatedAtMs,
              definition.projectId,
              definition.taskId,
              command.expectedRevision,
            ],
          );
          if (update.rowCount !== 1) throw new TaskDefinitionConflictError();
        }
        if (transactionHook) {
          try {
            const hookResult = await transactionHook(
              client,
              Object.freeze({ command, replay: null, record: definition }),
            );
            if (hookResult !== undefined) {
              throw new InvalidTaskDefinitionError(
                'transaction hook must not return a value',
              );
            }
          } catch (error) {
            transactionHookError = error;
            throw error;
          }
        }
        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: created ? 'created' : 'updated',
          definition,
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
