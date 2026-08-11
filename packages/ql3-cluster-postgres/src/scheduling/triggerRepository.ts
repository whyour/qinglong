// PostgreSQL authority for Trigger publication and schedule binding.
import {
  InvalidTriggerError,
  TriggerConflictError,
  TriggerSpecSemanticRegistry,
  TriggerUnavailableError,
  assertTriggerIdentifier,
  assertTriggerPageSize,
  assertTriggerRevision,
  createBuiltInTriggerSpecSemanticRegistry,
  createTriggerRecord,
  normalizeAppendTriggerRevisionCommand,
  normalizeTriggerCursor,
  normalizeTriggerRecord,
  type AppendTriggerRevisionCommand,
  type TriggerPage,
  type TriggerRecord,
  type TriggerRepository,
  type TriggerSource,
} from '@qinglong/runtime-core/trigger';
import {
  normalizeTaskDefinitionRecord,
  type TaskDefinitionRecord,
} from '@qinglong/runtime-core/task-definition';
import type {
  PostgresClient,
  PostgresPool,
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

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

export interface PostgresTriggerRevisionTransactionContext {
  readonly command: Readonly<AppendTriggerRevisionCommand>;
  readonly replay: Readonly<TriggerRecord> | null;
  readonly record: Readonly<TriggerRecord>;
}

export type PostgresTriggerRevisionTransactionHook = (
  client: PostgresClient,
  context: Readonly<PostgresTriggerRevisionTransactionContext>,
) => Promise<void>;

const SELECT_FIELDS = `
  head.project_id AS "projectId",
  head.trigger_id AS "triggerId",
  revision.revision,
  revision.mutation_id AS "mutationId",
  revision.task_id AS "taskId",
  revision.task_revision AS "taskRevision",
  revision.task_content_digest AS "taskContentDigest",
  revision.spec_json AS "specJson",
  revision.enabled,
  revision.content_digest AS "contentDigest",
  head.created_at_ms AS "createdAtMs",
  revision.created_at_ms AS "updatedAtMs"`;

const TASK_SELECT_FIELDS = `
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

function unavailable(): TriggerUnavailableError {
  return new TriggerUnavailableError();
}

function triggerRecord(row: Row): TriggerRecord {
  try {
    return normalizeTriggerRecord({
      projectId: postgresRequiredString(row.projectId, unavailable),
      triggerId: postgresRequiredString(row.triggerId, unavailable),
      revision: postgresRequiredInteger(row.revision, unavailable),
      mutationId: postgresRequiredString(row.mutationId, unavailable),
      taskId: postgresRequiredString(row.taskId, unavailable),
      taskRevision: postgresRequiredInteger(row.taskRevision, unavailable),
      taskContentDigest: postgresRequiredString(
        row.taskContentDigest,
        unavailable,
      ),
      spec: postgresRequiredJsonObject(
        row.specJson,
        unavailable,
      ) as unknown as TriggerRecord['spec'],
      enabled: postgresRequiredBoolean(row.enabled, unavailable),
      contentDigest: postgresRequiredString(row.contentDigest, unavailable),
      createdAtMs: postgresRequiredInteger(row.createdAtMs, unavailable),
      updatedAtMs: postgresRequiredInteger(row.updatedAtMs, unavailable),
    });
  } catch (error) {
    if (error instanceof TriggerUnavailableError) throw error;
    throw unavailable();
  }
}

function taskRecord(row: Row): TaskDefinitionRecord {
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
    if (error instanceof TriggerUnavailableError) throw error;
    throw unavailable();
  }
}

function sameRecord(left: TriggerRecord, right: TriggerRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mappedError(error: unknown): Error {
  if (
    error instanceof TriggerConflictError ||
    error instanceof TriggerUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new TriggerConflictError();
  }
  return unavailable();
}

async function findCurrent(
  queryable: Queryable,
  projectId: string,
  triggerId: string,
): Promise<TriggerRecord | null> {
  const result = await queryable.query<Row>(
    `SELECT ${SELECT_FIELDS}
     FROM "ql3"."triggers" AS head
     LEFT JOIN "ql3"."trigger_revisions" AS revision
       ON revision.project_id = head.project_id
      AND revision.trigger_id = head.trigger_id
      AND revision.revision = head.current_revision
     WHERE head.project_id = $1 AND head.trigger_id = $2
     LIMIT 2`,
    [projectId, triggerId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return triggerRecord(result.rows[0]!);
}

async function findRevision(
  queryable: Queryable,
  projectId: string,
  triggerId: string,
  revision: number,
): Promise<TriggerRecord | null> {
  const result = await queryable.query<Row>(
    `SELECT ${SELECT_FIELDS}
     FROM "ql3"."triggers" AS head
     JOIN "ql3"."trigger_revisions" AS revision
       ON revision.project_id = head.project_id
      AND revision.trigger_id = head.trigger_id
     WHERE head.project_id = $1 AND head.trigger_id = $2
       AND revision.revision = $3
     LIMIT 2`,
    [projectId, triggerId, revision],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return triggerRecord(result.rows[0]!);
}

async function findByMutation(
  queryable: Queryable,
  mutationId: string,
): Promise<TriggerRecord | null> {
  const result = await queryable.query<Row>(
    `SELECT ${SELECT_FIELDS}
     FROM "ql3"."trigger_revisions" AS revision
     JOIN "ql3"."triggers" AS head
       ON head.project_id = revision.project_id
      AND head.trigger_id = revision.trigger_id
     WHERE revision.mutation_id = $1
     LIMIT 2`,
    [mutationId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw unavailable();
  return triggerRecord(result.rows[0]!);
}

async function assertPinnedTask(
  queryable: Queryable,
  trigger: TriggerRecord,
  requireCurrent: boolean,
): Promise<void> {
  const result = await queryable.query<Row>(
    `SELECT ${TASK_SELECT_FIELDS}
     FROM "ql3"."task_definitions" AS head
     JOIN "ql3"."task_definition_revisions" AS revision
       ON revision.project_id = head.project_id
      AND revision.task_id = head.task_id
     WHERE revision.project_id = $1 AND revision.task_id = $2
       AND revision.revision = $3
       AND ($4::boolean = false OR head.current_revision = revision.revision)
     LIMIT 2`,
    [
      trigger.projectId,
      trigger.taskId,
      trigger.taskRevision,
      requireCurrent,
    ],
  );
  if (result.rows.length === 0) throw new TriggerConflictError();
  if (result.rows.length !== 1) throw unavailable();
  const task = taskRecord(result.rows[0]!);
  if (
    task.contentDigest !== trigger.taskContentDigest ||
    (trigger.enabled && !task.enabled)
  ) {
    throw new TriggerConflictError();
  }
}

async function assertScheduleBound(
  queryable: Queryable,
  trigger: TriggerRecord,
): Promise<void> {
  const result = await queryable.query<Row>(
    `SELECT trigger_revision AS "triggerRevision"
     FROM "ql3"."trigger_schedules"
     WHERE project_id = $1 AND trigger_id = $2
     LIMIT 2`,
    [trigger.projectId, trigger.triggerId],
  );
  if (
    result.rows.length !== 1 ||
    postgresRequiredInteger(
      result.rows[0]?.triggerRevision,
      unavailable,
    ) !== trigger.revision
  ) {
    throw unavailable();
  }
}

/** Read-only PostgreSQL Trigger port for cluster scheduler consumers. */
export class PostgresTriggerSource implements TriggerSource {
  constructor(protected readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL Trigger pool is invalid');
    }
  }


  async findCurrentTrigger(
    projectId: string,
    triggerId: string,
  ): Promise<TriggerRecord | null> {
    assertTriggerIdentifier(projectId, 'projectId');
    assertTriggerIdentifier(triggerId, 'triggerId');
    try {
      return await findCurrent(this.pool, projectId, triggerId);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async findTriggerRevision(
    projectId: string,
    triggerId: string,
    revision: number,
  ): Promise<TriggerRecord | null> {
    assertTriggerIdentifier(projectId, 'projectId');
    assertTriggerIdentifier(triggerId, 'triggerId');
    assertTriggerRevision(revision);
    try {
      return await findRevision(this.pool, projectId, triggerId, revision);
    } catch (error) {
      throw mappedError(error);
    }
  }

  async listTriggers(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: { readonly triggerId: string };
  }): Promise<TriggerPage> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new InvalidTriggerError('list options are invalid');
    }
    const keys = Object.keys(options);
    if (
      !keys.includes('limit') ||
      !keys.includes('projectId') ||
      keys.some((key) => !['after', 'limit', 'projectId'].includes(key))
    ) {
      throw new InvalidTriggerError('list options have an invalid shape');
    }
    assertTriggerIdentifier(options.projectId, 'projectId');
    assertTriggerPageSize(options.limit);
    const after = options.after ? normalizeTriggerCursor(options.after) : undefined;
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${SELECT_FIELDS}
         FROM "ql3"."triggers" AS head
         LEFT JOIN "ql3"."trigger_revisions" AS revision
           ON revision.project_id = head.project_id
          AND revision.trigger_id = head.trigger_id
          AND revision.revision = head.current_revision
         WHERE head.project_id = $1 AND head.trigger_id > $2
         ORDER BY head.trigger_id
         LIMIT $3`,
        [options.projectId, after?.triggerId ?? '', options.limit + 1],
      );
      const truncated = result.rows.length > options.limit;
      const triggers = Object.freeze(
        result.rows.slice(0, options.limit).map(triggerRecord),
      );
      const last = triggers.at(-1);
      return Object.freeze({
        triggers,
        truncated,
        ...(truncated && last
          ? { next: Object.freeze({ triggerId: last.triggerId }) }
          : {}),
      });
    } catch (error) {
      throw mappedError(error);
    }
  }
}

/** Administration-only Trigger publisher; schedule claims remain separate. */
export class PostgresTriggerRepository
  extends PostgresTriggerSource
  implements TriggerRepository
{
  constructor(
    pool: PostgresPool,
    private readonly semanticRegistry: TriggerSpecSemanticRegistry =
      createBuiltInTriggerSpecSemanticRegistry(),
  ) {
    super(pool);
  }

  async appendTriggerRevision(
    input: AppendTriggerRevisionCommand,
    transactionHook?: PostgresTriggerRevisionTransactionHook,
  ): Promise<
    Readonly<{
      status: 'created' | 'updated' | 'existing';
      trigger: TriggerRecord;
    }>
  > {
    if (
      transactionHook !== undefined &&
      typeof transactionHook !== 'function'
    ) {
      throw new InvalidTriggerError('transaction hook is invalid');
    }
    const normalized = normalizeAppendTriggerRevisionCommand(input);
    const command = Object.freeze({
      ...normalized,
      spec: this.semanticRegistry.normalize({
        projectId: normalized.projectId,
        triggerId: normalized.triggerId,
        taskId: normalized.taskId,
        taskRevision: normalized.taskRevision,
        spec: normalized.spec,
      }),
    });

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
        const replay = await findByMutation(client, command.mutationId);
        if (replay) {
          const expected = createTriggerRecord(command, replay.createdAtMs);
          if (!sameRecord(replay, expected)) throw new TriggerConflictError();
          await assertPinnedTask(client, replay, false);
          await assertScheduleBound(client, replay);
          if (transactionHook) {
            try {
              const hookResult = await transactionHook(
                client,
                Object.freeze({ command, replay, record: replay }),
              );
              if (hookResult !== undefined) {
                throw new InvalidTriggerError(
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
          return Object.freeze({ status: 'existing', trigger: replay });
        }

        const project = await client.query<{ status: unknown }>(
          `SELECT status FROM "ql3"."projects"
           WHERE id = $1`,
          [command.projectId],
        );
        if (
          project.rows.length !== 1 ||
          project.rows[0]?.status !== 'active'
        ) {
          throw new TriggerConflictError();
        }

        const inserted = await client.query(
          `INSERT INTO "ql3"."triggers" (
             project_id, trigger_id, task_id, current_revision,
             created_at_ms, updated_at_ms
           ) VALUES ($1, $2, $3, 1, $4, $4)
           ON CONFLICT (project_id, trigger_id) DO NOTHING
           RETURNING trigger_id`,
          [
            command.projectId,
            command.triggerId,
            command.taskId,
            command.occurredAtMs,
          ],
        );
        if (inserted.rows.length > 1) throw unavailable();
        const created = inserted.rows.length === 1;
        const head = await client.query<Row>(
          `SELECT task_id AS "taskId",
                  current_revision AS "currentRevision",
                  created_at_ms AS "createdAtMs",
                  updated_at_ms AS "updatedAtMs"
           FROM "ql3"."triggers"
           WHERE project_id = $1 AND trigger_id = $2
           FOR UPDATE`,
          [command.projectId, command.triggerId],
        );
        if (head.rows.length !== 1) throw unavailable();
        const taskId = postgresRequiredString(head.rows[0]!.taskId, unavailable);
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
          (created ? command.expectedRevision !== null :
            currentRevision !== command.expectedRevision) ||
          taskId !== command.taskId ||
          command.occurredAtMs < previousUpdatedAtMs
        ) {
          throw new TriggerConflictError();
        }
        const trigger = createTriggerRecord(command, createdAtMs);
        await assertPinnedTask(client, trigger, trigger.enabled);
        await client.query(
          `INSERT INTO "ql3"."trigger_revisions" (
             project_id, trigger_id, revision, mutation_id, task_id,
             task_revision, task_content_digest, spec_json, enabled,
             content_digest, created_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
          [
            trigger.projectId,
            trigger.triggerId,
            trigger.revision,
            trigger.mutationId,
            trigger.taskId,
            trigger.taskRevision,
            trigger.taskContentDigest,
            JSON.stringify(trigger.spec),
            trigger.enabled,
            trigger.contentDigest,
            trigger.updatedAtMs,
          ],
        );
        await client.query(
          `INSERT INTO "ql3"."trigger_schedules" (
             project_id, trigger_id, trigger_revision, next_fire_at_ms,
             last_scheduled_at_ms, state_version, claim_owner, claim_token,
             claim_version, claim_expires_at_ms, updated_at_ms
           ) VALUES ($1, $2, $3, NULL, NULL, 0, NULL, NULL, 0, NULL, $4)
           ON CONFLICT (project_id, trigger_id) DO UPDATE SET
             trigger_revision = EXCLUDED.trigger_revision,
             next_fire_at_ms = NULL,
             last_scheduled_at_ms = NULL,
             state_version = "trigger_schedules".state_version + 1,
             claim_owner = NULL,
             claim_token = NULL,
             claim_version = "trigger_schedules".claim_version + 1,
             claim_expires_at_ms = NULL,
             updated_at_ms = EXCLUDED.updated_at_ms`,
          [
            trigger.projectId,
            trigger.triggerId,
            trigger.revision,
            trigger.updatedAtMs,
          ],
        );
        if (!created) {
          const update = await client.query(
            `UPDATE "ql3"."triggers"
             SET current_revision = $1, updated_at_ms = $2
             WHERE project_id = $3 AND trigger_id = $4
               AND current_revision = $5 AND task_id = $6`,
            [
              trigger.revision,
              trigger.updatedAtMs,
              trigger.projectId,
              trigger.triggerId,
              command.expectedRevision,
              trigger.taskId,
            ],
          );
          if (update.rowCount !== 1) throw new TriggerConflictError();
        }
        if (transactionHook) {
          try {
            const hookResult = await transactionHook(
              client,
              Object.freeze({ command, replay: null, record: trigger }),
            );
            if (hookResult !== undefined) {
              throw new InvalidTriggerError(
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
          trigger,
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
