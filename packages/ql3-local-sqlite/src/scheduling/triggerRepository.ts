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
} from '@qinglong/runtime-core/trigger';
import {
  normalizeTaskDefinitionRecord,
  type TaskDefinitionRecord,
} from '@qinglong/runtime-core/task-definition';
import type { DatabaseSync } from 'node:sqlite';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

export type LocalSqliteTriggerRevisionTransactionHook = (
  context: Readonly<{
    command: Readonly<AppendTriggerRevisionCommand>;
    replay: TriggerRecord | null;
  }>,
) => void;

const SELECT_FIELDS = `
  head."project_id" AS "projectId",
  head."trigger_id" AS "triggerId",
  revision."revision" AS "revision",
  revision."mutation_id" AS "mutationId",
  revision."task_id" AS "taskId",
  revision."task_revision" AS "taskRevision",
  revision."task_content_digest" AS "taskContentDigest",
  revision."spec_json" AS "specJson",
  revision."enabled" AS "enabled",
  revision."content_digest" AS "contentDigest",
  head."created_at_ms" AS "createdAtMs",
  revision."created_at_ms" AS "updatedAtMs"`;

const TASK_SELECT_FIELDS = `
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
  if (typeof value !== 'string') throw new TriggerUnavailableError();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) throw new TriggerUnavailableError();
  return value as number;
}

function parseJson(row: Row, key: string): unknown {
  try {
    return JSON.parse(text(row, key));
  } catch {
    throw new TriggerUnavailableError();
  }
}

function triggerRecord(row: Row): TriggerRecord {
  try {
    return normalizeTriggerRecord({
      projectId: text(row, 'projectId'),
      triggerId: text(row, 'triggerId'),
      revision: integer(row, 'revision'),
      mutationId: text(row, 'mutationId'),
      taskId: text(row, 'taskId'),
      taskRevision: integer(row, 'taskRevision'),
      taskContentDigest: text(row, 'taskContentDigest'),
      spec: parseJson(row, 'specJson') as TriggerRecord['spec'],
      enabled: integer(row, 'enabled') === 1,
      contentDigest: text(row, 'contentDigest'),
      createdAtMs: integer(row, 'createdAtMs'),
      updatedAtMs: integer(row, 'updatedAtMs'),
    });
  } catch (error) {
    if (error instanceof TriggerUnavailableError) throw error;
    throw new TriggerUnavailableError();
  }
}

function taskRecord(row: Row): TaskDefinitionRecord {
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
      spec: parseJson(row, 'specJson') as TaskDefinitionRecord['spec'],
      labels: parseJson(row, 'labelsJson') as TaskDefinitionRecord['labels'],
      enabled: integer(row, 'enabled') === 1,
      contentDigest: text(row, 'contentDigest'),
      createdAtMs: integer(row, 'createdAtMs'),
      updatedAtMs: integer(row, 'updatedAtMs'),
    });
  } catch (error) {
    if (error instanceof TriggerUnavailableError) throw error;
    throw new TriggerUnavailableError();
  }
}

function sameRecord(left: TriggerRecord, right: TriggerRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  ) {
    return true;
  }
  return (
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    (error.errcode & 0xff) === 19
  );
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof TriggerConflictError ||
    error instanceof TriggerUnavailableError
  ) {
    return error;
  }
  return isConstraintError(error)
    ? new TriggerConflictError()
    : new TriggerUnavailableError();
}

export class LocalSqliteTriggerRepository implements TriggerRepository {
  private readonly authority: LocalSqliteOperationAuthority;
  private readonly semanticRegistry: TriggerSpecSemanticRegistry;

  constructor(
    authority: LocalSqliteOperationAuthority | DatabaseSync,
    semanticRegistry = createBuiltInTriggerSpecSemanticRegistry(),
  ) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.semanticRegistry = semanticRegistry;
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
      () => new TriggerUnavailableError(),
    );
  }

  private findCurrent(
    projectId: string,
    triggerId: string,
  ): TriggerRecord | null {
    const row = this.authority.client
      .prepare(
        `SELECT ${SELECT_FIELDS}
         FROM "QingLong3Triggers" AS head
         JOIN "QingLong3TriggerRevisions" AS revision
           ON revision."project_id" = head."project_id"
          AND revision."trigger_id" = head."trigger_id"
          AND revision."revision" = head."current_revision"
         WHERE head."project_id" = ? AND head."trigger_id" = ?`,
      )
      .get(projectId, triggerId) as Row | undefined;
    return row ? triggerRecord(row) : null;
  }

  private findRevision(
    projectId: string,
    triggerId: string,
    revision: number,
  ): TriggerRecord | null {
    const row = this.authority.client
      .prepare(
        `SELECT ${SELECT_FIELDS}
         FROM "QingLong3Triggers" AS head
         JOIN "QingLong3TriggerRevisions" AS revision
           ON revision."project_id" = head."project_id"
          AND revision."trigger_id" = head."trigger_id"
         WHERE head."project_id" = ? AND head."trigger_id" = ?
           AND revision."revision" = ?`,
      )
      .get(projectId, triggerId, revision) as Row | undefined;
    return row ? triggerRecord(row) : null;
  }

  private findByMutation(mutationId: string): TriggerRecord | null {
    const row = this.authority.client
      .prepare(
        `SELECT ${SELECT_FIELDS}
         FROM "QingLong3TriggerRevisions" AS revision
         JOIN "QingLong3Triggers" AS head
           ON head."project_id" = revision."project_id"
          AND head."trigger_id" = revision."trigger_id"
         WHERE revision."mutation_id" = ?`,
      )
      .get(mutationId) as Row | undefined;
    return row ? triggerRecord(row) : null;
  }

  private pinnedTask(
    record: TriggerRecord,
    requireCurrent: boolean,
  ): TaskDefinitionRecord {
    const row = this.authority.client
      .prepare(
        `SELECT ${TASK_SELECT_FIELDS}
         FROM "QingLong3TaskDefinitions" AS head
         JOIN "QingLong3TaskDefinitionRevisions" AS revision
           ON revision."project_id" = head."project_id"
          AND revision."task_id" = head."task_id"
         WHERE revision."project_id" = ? AND revision."task_id" = ?
           AND revision."revision" = ?`,
      )
      .get(record.projectId, record.taskId, record.taskRevision) as
      | Row
      | undefined;
    if (!row) throw new TriggerConflictError();
    const task = taskRecord(row);
    if (
      task.contentDigest !== record.taskContentDigest ||
      (record.enabled && !task.enabled)
    ) {
      throw new TriggerConflictError();
    }
    if (requireCurrent) {
      const current = this.authority.client
        .prepare(
          `SELECT "current_revision" AS "currentRevision"
           FROM "QingLong3TaskDefinitions"
           WHERE "project_id" = ? AND "task_id" = ?`,
        )
        .get(record.projectId, record.taskId) as Row | undefined;
      if (
        !current ||
        integer(current, 'currentRevision') !== record.taskRevision
      ) {
        throw new TriggerConflictError();
      }
    }
    return task;
  }

  findCurrentTrigger(
    projectId: string,
    triggerId: string,
  ): Promise<TriggerRecord | null> {
    assertTriggerIdentifier(projectId, 'projectId');
    assertTriggerIdentifier(triggerId, 'triggerId');
    return this.enqueue(() => this.findCurrent(projectId, triggerId));
  }

  findTriggerRevision(
    projectId: string,
    triggerId: string,
    revision: number,
  ): Promise<TriggerRecord | null> {
    assertTriggerIdentifier(projectId, 'projectId');
    assertTriggerIdentifier(triggerId, 'triggerId');
    assertTriggerRevision(revision);
    return this.enqueue(() =>
      this.findRevision(projectId, triggerId, revision),
    );
  }

  listTriggers(options: {
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
    const after = options.after
      ? normalizeTriggerCursor(options.after)
      : undefined;
    return this.enqueue(() => {
      const rows = this.authority.client
        .prepare(
          `SELECT ${SELECT_FIELDS}
           FROM "QingLong3Triggers" AS head
           JOIN "QingLong3TriggerRevisions" AS revision
             ON revision."project_id" = head."project_id"
            AND revision."trigger_id" = head."trigger_id"
            AND revision."revision" = head."current_revision"
           WHERE head."project_id" = ? AND head."trigger_id" > ?
           ORDER BY head."trigger_id"
           LIMIT ?`,
        )
        .all(options.projectId, after?.triggerId ?? '', options.limit + 1) as
        | Row[]
        | undefined;
      if (!Array.isArray(rows)) throw new TriggerUnavailableError();
      const truncated = rows.length > options.limit;
      const triggers = Object.freeze(
        rows.slice(0, options.limit).map(triggerRecord),
      );
      const last = triggers.at(-1);
      return Object.freeze({
        triggers,
        truncated,
        ...(truncated && last
          ? { next: Object.freeze({ triggerId: last.triggerId }) }
          : {}),
      });
    });
  }

  appendTriggerRevision(
    input: AppendTriggerRevisionCommand,
    transactionHook?: LocalSqliteTriggerRevisionTransactionHook,
  ): Promise<
    Readonly<{
      status: 'created' | 'updated' | 'existing';
      trigger: TriggerRecord;
    }>
  > {
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
    if (
      transactionHook !== undefined &&
      typeof transactionHook !== 'function'
    ) {
      throw new InvalidTriggerError('transaction hook is invalid');
    }
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        let transactionHookError: unknown;
        try {
          client.exec('BEGIN IMMEDIATE');
          const replay = this.findByMutation(command.mutationId);
          if (transactionHook) {
            try {
              transactionHook(Object.freeze({ command, replay }));
            } catch (error) {
              transactionHookError = error;
              throw error;
            }
          }
          if (replay) {
            const expected = createTriggerRecord(command, replay.createdAtMs);
            if (!sameRecord(replay, expected)) throw new TriggerConflictError();
            this.pinnedTask(replay, false);
            client.exec('COMMIT');
            return Object.freeze({
              status: 'existing' as const,
              trigger: replay,
            });
          }

          const project = client
            .prepare(
              `SELECT "status" AS "status"
             FROM "QingLong3Projects" WHERE "id" = ?`,
            )
            .get(command.projectId) as { status?: unknown } | undefined;
          if (project?.status !== 'active') throw new TriggerConflictError();

          const head = client
            .prepare(
              `SELECT "task_id" AS "taskId",
                    "current_revision" AS "currentRevision",
                    "created_at_ms" AS "createdAtMs",
                    "updated_at_ms" AS "updatedAtMs"
             FROM "QingLong3Triggers"
             WHERE "project_id" = ? AND "trigger_id" = ?`,
            )
            .get(command.projectId, command.triggerId) as Row | undefined;
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
            (head && text(head, 'taskId') !== command.taskId) ||
            command.occurredAtMs < previousUpdatedAtMs
          ) {
            throw new TriggerConflictError();
          }
          const trigger = createTriggerRecord(command, createdAtMs);
          this.pinnedTask(trigger, trigger.enabled);
          if (!head) {
            client
              .prepare(
                `INSERT INTO "QingLong3Triggers" (
                 "project_id", "trigger_id", "task_id", "current_revision",
                 "created_at_ms", "updated_at_ms"
               ) VALUES (?, ?, ?, 1, ?, ?)`,
              )
              .run(
                trigger.projectId,
                trigger.triggerId,
                trigger.taskId,
                trigger.createdAtMs,
                trigger.updatedAtMs,
              );
          }
          client
            .prepare(
              `INSERT INTO "QingLong3TriggerRevisions" (
               "project_id", "trigger_id", "revision", "mutation_id",
               "task_id", "task_revision", "task_content_digest",
               "spec_json", "enabled", "content_digest", "created_at_ms"
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              trigger.projectId,
              trigger.triggerId,
              trigger.revision,
              trigger.mutationId,
              trigger.taskId,
              trigger.taskRevision,
              trigger.taskContentDigest,
              JSON.stringify(trigger.spec),
              trigger.enabled ? 1 : 0,
              trigger.contentDigest,
              trigger.updatedAtMs,
            );
          if (head) {
            const update = client
              .prepare(
                `UPDATE "QingLong3Triggers"
               SET "current_revision" = ?, "updated_at_ms" = ?
               WHERE "project_id" = ? AND "trigger_id" = ?
                 AND "current_revision" = ? AND "task_id" = ?`,
              )
              .run(
                trigger.revision,
                trigger.updatedAtMs,
                trigger.projectId,
                trigger.triggerId,
                command.expectedRevision,
                trigger.taskId,
              );
            if (update.changes !== 1) throw new TriggerConflictError();
          }
          client
            .prepare(
              `INSERT INTO "QingLong3LocalTriggerSchedules" (
               "project_id", "trigger_id", "trigger_revision",
               "next_fire_at_ms", "last_scheduled_at_ms", "state_version",
               "updated_at_ms"
             ) VALUES (?, ?, ?, ?, NULL, 0, ?)
             ON CONFLICT ("project_id", "trigger_id") DO UPDATE SET
               "trigger_revision" = excluded."trigger_revision",
               "next_fire_at_ms" = excluded."next_fire_at_ms",
               "last_scheduled_at_ms" = NULL,
               "state_version" = "QingLong3LocalTriggerSchedules"."state_version" + 1,
               "updated_at_ms" = excluded."updated_at_ms"`,
            )
            .run(
              trigger.projectId,
              trigger.triggerId,
              trigger.revision,
              null,
              trigger.updatedAtMs,
            );
          client.exec('COMMIT');
          return Object.freeze({
            status: head ? ('updated' as const) : ('created' as const),
            trigger,
          });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (error === transactionHookError && error instanceof Error) {
            throw error;
          }
          throw mapStorageError(error);
        }
      },
      () => new TriggerUnavailableError(),
    );
  }
}
