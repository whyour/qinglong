import { RUN_STATUSES, type RunStatus } from '@qinglong/runtime-core/run';
import {
  RunRepositoryConstraintError,
  RunRepositoryOperationError,
} from '@qinglong/runtime-core/run-repository';
import {
  normalizeTaskRunOutcomeWindowQuery,
  normalizeTaskRunOutcomeWindowRecord,
  type TaskRunOutcomeWindowQuery,
  type TaskRunOutcomeWindowReader,
  type TaskRunOutcomeWindowRecord,
} from '@qinglong/runtime-core/task-run-outcome-window';
import type { PostgresQueryable } from '@qinglong/runtime-core';

type QueryRow = Readonly<Record<string, unknown>>;

function requiredString(row: QueryRow, property: string): string {
  const value = row[property];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RunRepositoryConstraintError(
      `PostgreSQL Task Run outcome row has an invalid ${property}`,
    );
  }
  return value;
}

function requiredInteger(row: QueryRow, property: string): number {
  const value = row[property];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new RunRepositoryConstraintError(
    `PostgreSQL Task Run outcome row has an invalid ${property}`,
  );
}

function record(row: QueryRow): Readonly<TaskRunOutcomeWindowRecord> {
  const status = requiredString(row, 'status');
  if (!RUN_STATUSES.includes(status as RunStatus)) {
    throw new RunRepositoryConstraintError(
      'PostgreSQL Task Run outcome row has an invalid status',
    );
  }
  return normalizeTaskRunOutcomeWindowRecord({
    id: requiredString(row, 'id'),
    projectId: requiredString(row, 'projectId'),
    taskId: requiredString(row, 'taskId'),
    status: status as RunStatus,
    createdAtMs: requiredInteger(row, 'createdAtMs'),
  });
}

export class PostgresTaskRunOutcomeWindowReader
  implements TaskRunOutcomeWindowReader
{
  constructor(private readonly queryable: PostgresQueryable) {}

  async listRecentRunsByTask(
    value: Readonly<TaskRunOutcomeWindowQuery>,
  ): Promise<readonly Readonly<TaskRunOutcomeWindowRecord>[]> {
    const query = normalizeTaskRunOutcomeWindowQuery(value);
    try {
      const result = await this.queryable.query<QueryRow>(
        `SELECT
           "id" AS "id",
           "project_id" AS "projectId",
           "task_id" AS "taskId",
           "status" AS "status",
           "created_at_ms" AS "createdAtMs"
         FROM "ql3"."runs"
         WHERE "project_id" = $1 AND "task_id" = $2
         ORDER BY "created_at_ms" DESC, "id" DESC
         LIMIT $3`,
        [query.projectId, query.taskId, query.limit],
      );
      return Object.freeze(result.rows.map(record));
    } catch (error) {
      if (error instanceof RunRepositoryConstraintError) throw error;
      throw new RunRepositoryOperationError(error);
    }
  }
}
