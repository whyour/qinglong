import { RUN_STATUSES } from '@qinglong/runtime-core/run';
import {
  normalizeTaskRunOutcomeWindowQuery,
  type TaskRunOutcomeWindowQuery,
  type TaskRunOutcomeWindowReader,
  type TaskRunOutcomeWindowRecord,
} from '@qinglong/runtime-core/task-run-outcome-window';
import type { DatabaseSync } from 'node:sqlite';

import {
  queryRows,
  requiredEnum,
  requiredInteger,
  requiredString,
} from '../runPersistence';

export class LocalSqliteTaskRunOutcomeWindowReader
  implements TaskRunOutcomeWindowReader
{
  constructor(private readonly client: DatabaseSync) {}

  async listRecentRunsByTask(
    value: Readonly<TaskRunOutcomeWindowQuery>,
  ): Promise<readonly Readonly<TaskRunOutcomeWindowRecord>[]> {
    const query = normalizeTaskRunOutcomeWindowQuery(value);
    return queryRows(
      this.client,
      `SELECT
         "id" AS "id",
         "project_id" AS "projectId",
         "task_id" AS "taskId",
         "status" AS "status",
         "created_at_ms" AS "createdAtMs"
       FROM "Runs"
       WHERE "project_id" = ? AND "task_id" = ?
       ORDER BY "created_at_ms" DESC, "id" DESC
       LIMIT ?`,
      [query.projectId, query.taskId, query.limit],
    ).map((row) =>
      Object.freeze({
        id: requiredString(row, 'id'),
        projectId: requiredString(row, 'projectId'),
        taskId: requiredString(row, 'taskId'),
        status: requiredEnum(row, 'status', RUN_STATUSES),
        createdAtMs: requiredInteger(row, 'createdAtMs'),
      }),
    );
  }
}
