import {
  normalizeLocalExecutionContextRecipe,
  normalizeLocalTaskExecutionRevision,
  type LocalExecutionContextRecipe,
  type LocalTaskExecutionRevision,
} from '@qinglong/runtime-core/local-dispatch';
import type { LocalCommandTaskExecutionPlan } from '@qinglong/runtime-core/task-definition-execution-compiler';
import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

export class LocalSqliteDispatchDefinitionConflictError extends Error {
  constructor() {
    super('Local SQLite dispatch definition identity already has other content');
    this.name = 'LocalSqliteDispatchDefinitionConflictError';
  }
}

function sqliteConstraint(error: unknown): boolean {
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
    Number.isSafeInteger(error.errcode) &&
    ((error.errcode as number) & 0xff) === 19
  );
}

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new TypeError(`Stored local dispatch ${key} is invalid`);
  }
  return value;
}

function optionalString(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null) return undefined;
  return requiredString(row, key);
}

function requiredInteger(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`Stored local dispatch ${key} is invalid`);
  }
  return value as number;
}

function optionalInteger(row: Row, key: string): number | undefined {
  const value = row[key];
  if (value === null) return undefined;
  return requiredInteger(row, key);
}

function requiredJson(row: Row, key: string): unknown {
  try {
    return JSON.parse(requiredString(row, key)) as unknown;
  } catch {
    throw new TypeError(`Stored local dispatch ${key} is invalid`);
  }
}

function sameRecipeContent(
  left: LocalExecutionContextRecipe,
  right: LocalExecutionContextRecipe,
): boolean {
  return (
    left.contextRef === right.contextRef &&
    left.contentDigest === right.contentDigest &&
    JSON.stringify(left.environment) === JSON.stringify(right.environment)
  );
}

function sameRevisionContent(
  left: LocalTaskExecutionRevision,
  right: LocalTaskExecutionRevision,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.taskId === right.taskId &&
    left.taskRevision === right.taskRevision &&
    left.contentDigest === right.contentDigest
  );
}

/**
 * Synchronous transaction-scoped storage primitive. Public repositories own
 * admission/error mapping; this class never opens a transaction or queue.
 */
export class LocalSqliteDispatchDefinitionStore {
  constructor(private readonly client: DatabaseSync) {}

  resolveRecipe(contextRef: string): LocalExecutionContextRecipe | null {
    const row = this.client
      .prepare(
        `SELECT "context_ref" AS "contextRef",
                "environment_json" AS "environmentJson",
                "content_digest" AS "contentDigest",
                "created_at_ms" AS "createdAtMs"
         FROM "QingLong3LocalExecutionContextRecipes"
         WHERE "context_ref" = ?`,
      )
      .get(contextRef) as Row | undefined;
    if (!row) return null;
    return normalizeLocalExecutionContextRecipe({
      contextRef: requiredString(row, 'contextRef'),
      environment: requiredJson(
        row,
        'environmentJson',
      ) as LocalExecutionContextRecipe['environment'],
      contentDigest: requiredString(row, 'contentDigest'),
      createdAtMs: requiredInteger(row, 'createdAtMs'),
    });
  }

  resolveRevision(identity: {
    readonly projectId: string;
    readonly taskId: string;
    readonly taskRevision: string;
  }): LocalTaskExecutionRevision | null {
    const row = this.client
      .prepare(
        `SELECT "project_id" AS "projectId", "task_id" AS "taskId",
                "task_revision" AS "taskRevision",
                "executor_type" AS "executorType",
                "command_json" AS "commandJson",
                "working_directory" AS "workingDirectory",
                "timeout_ms" AS "timeoutMs", "context_ref" AS "contextRef",
                "content_digest" AS "contentDigest",
                "created_at_ms" AS "createdAtMs"
         FROM "QingLong3LocalTaskExecutionRevisions"
         WHERE "project_id" = ? AND "task_id" = ? AND "task_revision" = ?`,
      )
      .get(identity.projectId, identity.taskId, identity.taskRevision) as
      | Row
      | undefined;
    if (!row) return null;
    const executorType = requiredString(row, 'executorType');
    if (executorType !== 'local_process') {
      throw new TypeError('Stored local dispatch executorType is invalid');
    }
    const workingDirectory = optionalString(row, 'workingDirectory');
    const timeoutMs = optionalInteger(row, 'timeoutMs');
    return normalizeLocalTaskExecutionRevision({
      projectId: requiredString(row, 'projectId'),
      taskId: requiredString(row, 'taskId'),
      taskRevision: requiredString(row, 'taskRevision'),
      executorType,
      command: requiredJson(
        row,
        'commandJson',
      ) as LocalTaskExecutionRevision['command'],
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      contextRef: requiredString(row, 'contextRef'),
      contentDigest: requiredString(row, 'contentDigest'),
      createdAtMs: requiredInteger(row, 'createdAtMs'),
    });
  }

  appendRecipe(
    value: LocalExecutionContextRecipe,
  ): 'inserted' | 'existing' {
    const recipe = normalizeLocalExecutionContextRecipe(value);
    try {
      this.client
        .prepare(
          `INSERT INTO "QingLong3LocalExecutionContextRecipes" (
             "context_ref", "environment_json", "content_digest", "created_at_ms"
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(
          recipe.contextRef,
          JSON.stringify(recipe.environment),
          recipe.contentDigest,
          recipe.createdAtMs,
        );
      return 'inserted';
    } catch (error) {
      if (!sqliteConstraint(error)) throw error;
      const existing = this.resolveRecipe(recipe.contextRef);
      if (existing && sameRecipeContent(existing, recipe)) return 'existing';
      throw new LocalSqliteDispatchDefinitionConflictError();
    }
  }

  appendRevision(
    value: LocalTaskExecutionRevision,
  ): 'inserted' | 'existing' {
    const revision = normalizeLocalTaskExecutionRevision(value);
    try {
      this.client
        .prepare(
          `INSERT INTO "QingLong3LocalTaskExecutionRevisions" (
             "project_id", "task_id", "task_revision", "executor_type",
             "command_json", "working_directory", "timeout_ms",
             "context_ref", "content_digest", "created_at_ms"
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision.projectId,
          revision.taskId,
          revision.taskRevision,
          revision.executorType,
          JSON.stringify(revision.command),
          revision.workingDirectory ?? null,
          revision.timeoutMs ?? null,
          revision.contextRef,
          revision.contentDigest,
          revision.createdAtMs,
        );
      return 'inserted';
    } catch (error) {
      if (!sqliteConstraint(error)) throw error;
      const existing = this.resolveRevision(revision);
      if (existing && sameRevisionContent(existing, revision)) {
        return 'existing';
      }
      throw new LocalSqliteDispatchDefinitionConflictError();
    }
  }

  appendPlan(plan: LocalCommandTaskExecutionPlan): Readonly<{
    recipe: 'inserted' | 'existing';
    revision: 'inserted' | 'existing';
  }> {
    const recipe = normalizeLocalExecutionContextRecipe(plan.contextRecipe);
    const revision = normalizeLocalTaskExecutionRevision(
      plan.executionRevision,
    );
    if (
      revision.projectId !== plan.source.projectId ||
      revision.taskId !== plan.source.taskId ||
      revision.taskRevision !== plan.source.taskRevision ||
      revision.contextRef !== recipe.contextRef
    ) {
      throw new TypeError('Local command execution plan identities do not match');
    }
    return Object.freeze({
      recipe: this.appendRecipe(recipe),
      revision: this.appendRevision(revision),
    });
  }
}
