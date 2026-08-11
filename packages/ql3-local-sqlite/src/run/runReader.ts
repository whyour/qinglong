import type {
  RunAttemptRecord,
  RunEventRecord,
  RunRecord,
  RunRepositoryReader,
  RunRetryPolicyRecord,
} from '@qinglong/runtime-core/run-repository';
import {
  normalizeProjectRunListQuery,
  type ProjectRunListQuery,
  type ProjectRunListReader,
} from '@qinglong/runtime-core/project-run-list';
import {
  MAX_LOCAL_RUN_STARTUP_RECOVERY_CANDIDATES,
  type LocalRunStartupRecoveryCandidate,
  type LocalRunStartupRecoveryPage,
} from '@qinglong/runtime-core/local-startup-recovery';
import {
  LOCAL_PROCESS_EXECUTOR_TYPE,
  assertLocalDispatchContextRef,
  assertLocalDispatchPageSize,
  normalizeLocalDispatchCandidate,
  normalizeLocalExecutionContextRecipe,
  normalizeLocalTaskExecutionRevision,
  type LocalDispatchCandidateCursor,
  type LocalDispatchCandidatePage,
  type LocalExecutionContextRecipe,
  type LocalTaskExecutionRevision,
} from '@qinglong/runtime-core/local-dispatch';
import {
  assertLocalExecutionControlLimit,
  normalizeLocalActiveExecutionCandidate,
  normalizeLocalActiveExecutionCursor,
  normalizeLocalExecutionControlCandidate,
  normalizeLocalExecutionControlCursor,
  type LocalActiveExecutionCursor,
  type LocalActiveExecutionPage,
  type LocalExecutionControlCursor,
  type LocalExecutionControlPage,
} from '@qinglong/runtime-core/local-execution-control';
import {
  MAX_CANCELLATION_RECOVERY_PAGE_SIZE,
  MAX_RUN_EVENT_PAGE_SIZE,
  RUN_CANCELLATION_REASONS,
} from '@qinglong/runtime-core/run-repository';
import type { DatabaseSync } from 'node:sqlite';
import {
  ATTEMPT_SELECT,
  EVENT_SELECT,
  RETRY_POLICY_SELECT,
  RUN_SELECT,
  optionalInteger,
  optionalString,
  queryRows,
  requiredEnum,
  requiredInteger,
  requiredJson,
  requiredString,
  rowToAttempt,
  rowToEvent,
  rowToRetryPolicy,
  rowToRun,
  singleRow,
} from './runPersistence';

const TERMINAL_RUN_STATUSES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const);

export class LocalSqliteRunReader
  implements RunRepositoryReader, ProjectRunListReader
{
  constructor(readonly client: DatabaseSync) {}

  async findRunById(runId: string): Promise<RunRecord | null> {
    const row = singleRow(
      queryRows(
        this.client,
        `SELECT ${RUN_SELECT} FROM "Runs" WHERE "id" = ? LIMIT 2`,
        [runId],
      ),
    );
    return row ? rowToRun(row) : null;
  }

  async listRunsByProject(
    value: Readonly<ProjectRunListQuery>,
  ): Promise<readonly RunRecord[]> {
    const query = normalizeProjectRunListQuery(value);
    return queryRows(
      this.client,
      `SELECT ${RUN_SELECT} FROM "Runs"
       WHERE "project_id" = ?
         AND (
           ? IS NULL
           OR "created_at_ms" < ?
           OR ("created_at_ms" = ? AND "id" < ?)
         )
       ORDER BY "created_at_ms" DESC, "id" DESC
       LIMIT ?`,
      [
        query.projectId,
        query.after?.runId ?? null,
        query.after?.createdAtMs ?? 0,
        query.after?.createdAtMs ?? 0,
        query.after?.runId ?? '',
        query.limit,
      ],
    ).map(rowToRun);
  }

  async findAttemptById(attemptId: string): Promise<RunAttemptRecord | null> {
    const row = singleRow(
      queryRows(
        this.client,
        `SELECT ${ATTEMPT_SELECT} FROM "RunAttempts" WHERE "id" = ? LIMIT 2`,
        [attemptId],
      ),
    );
    return row ? rowToAttempt(row) : null;
  }

  async findLatestAttemptByRunId(
    runId: string,
  ): Promise<RunAttemptRecord | null> {
    const row = singleRow(
      queryRows(
        this.client,
        `SELECT ${ATTEMPT_SELECT} FROM "RunAttempts"
         WHERE "run_id" = ? ORDER BY "attempt" DESC, "id" DESC LIMIT 1`,
        [runId],
      ),
    );
    return row ? rowToAttempt(row) : null;
  }

  async findRetryPolicyByRunId(
    runId: string,
  ): Promise<RunRetryPolicyRecord | null> {
    const row = singleRow(
      queryRows(
        this.client,
        `SELECT ${RETRY_POLICY_SELECT} FROM "RunRetryPolicies"
         WHERE "run_id" = ? LIMIT 2`,
        [runId],
      ),
    );
    return row ? rowToRetryPolicy(row) : null;
  }

  async listEvents(
    runId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<RunEventRecord[]> {
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError('afterSequence must be a non-negative integer');
    }
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_RUN_EVENT_PAGE_SIZE
    ) {
      throw new RangeError(
        'limit must be between 1 and MAX_RUN_EVENT_PAGE_SIZE',
      );
    }
    return queryRows(
      this.client,
      `SELECT ${EVENT_SELECT} FROM "RunEvents"
       WHERE "run_id" = ? AND "sequence" > ?
       ORDER BY "sequence", "id" LIMIT ?`,
      [runId, afterSequence, limit],
    ).map(rowToEvent);
  }

  async listCancellationRequested(
    options: { beforeMs?: number; limit?: number } = {},
  ): Promise<RunRecord[]> {
    const beforeMs = options.beforeMs;
    const limit = options.limit ?? 100;
    if (
      beforeMs !== undefined &&
      (!Number.isSafeInteger(beforeMs) || beforeMs < 0)
    ) {
      throw new RangeError('beforeMs must be a non-negative safe integer');
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_CANCELLATION_RECOVERY_PAGE_SIZE
    ) {
      throw new RangeError(
        'limit must be between 1 and MAX_CANCELLATION_RECOVERY_PAGE_SIZE',
      );
    }
    const terminalPlaceholders = TERMINAL_RUN_STATUSES.map(() => '?').join(',');
    return queryRows(
      this.client,
      `SELECT ${RUN_SELECT} FROM "Runs"
       WHERE "status" NOT IN (${terminalPlaceholders})
         AND "cancel_requested_at_ms" IS NOT NULL
         AND (? IS NULL OR "cancel_requested_at_ms" <= ?)
       ORDER BY "cancel_requested_at_ms", "id" LIMIT ?`,
      [...TERMINAL_RUN_STATUSES, beforeMs ?? null, beforeMs ?? null, limit],
    ).map(rowToRun);
  }

  async listLocalExecutionControlCandidates(options: {
    readonly observedAtMs: number;
    readonly limit: number;
    readonly after?: LocalExecutionControlCursor;
  }): Promise<LocalExecutionControlPage> {
    assertLocalExecutionControlLimit(options.limit);
    if (
      !Number.isSafeInteger(options.observedAtMs) ||
      options.observedAtMs < 0
    ) {
      throw new RangeError('observedAtMs must be a non-negative safe integer');
    }
    const after =
      options.after === undefined
        ? undefined
        : normalizeLocalExecutionControlCursor(options.after);
    const rows = queryRows(
      this.client,
      `WITH "control_candidates" AS (
         SELECT 'cancellation' AS "kind", "run"."id" AS "runId",
                "attempt"."id" AS "attemptId",
                "run"."cancel_requested_at_ms" AS "dueAtMs",
                "run"."cancel_reason" AS "cancelReason"
         FROM "Runs" AS "run"
         JOIN "RunAttempts" AS "attempt"
           ON "attempt"."run_id" = "run"."id"
         WHERE "run"."execution_owner" = 'runtime'
           AND "run"."status" NOT IN ('succeeded','failed','cancelled','timed_out')
           AND "run"."cancel_requested_at_ms" IS NOT NULL
           AND "run"."cancel_requested_at_ms" <= ?
           AND "attempt"."status" IN ('claimed','starting','running')
           AND "attempt"."executor_type" = 'local_process'
           AND (
             (
               "attempt"."step_run_id" IS NOT NULL
               AND EXISTS (
                 SELECT 1
                 FROM "QingLong3PluginPackageWorkflowTaskAttemptAdmissions"
                   AS "workflow_task"
                 WHERE "workflow_task"."attempt_id" = "attempt"."id"
                   AND "workflow_task"."run_id" = "attempt"."run_id"
                   AND "workflow_task"."step_run_id" =
                     "attempt"."step_run_id"
               )
             )
             OR NOT EXISTS (
               SELECT 1 FROM "RunAttempts" AS "newer"
               WHERE "newer"."run_id" = "attempt"."run_id"
                 AND "newer"."attempt" > "attempt"."attempt"
             )
           )
         UNION ALL
         SELECT 'deadline' AS "kind", "run"."id" AS "runId",
                "attempt"."id" AS "attemptId",
                "attempt"."deadline_at_ms" AS "dueAtMs",
                NULL AS "cancelReason"
         FROM "Runs" AS "run"
         JOIN "RunAttempts" AS "attempt"
           ON "attempt"."run_id" = "run"."id"
         WHERE "run"."execution_owner" = 'runtime'
           AND "run"."status" IN ('dispatching','running')
           AND "run"."cancel_requested_at_ms" IS NULL
           AND "attempt"."status" IN ('starting','running')
           AND "attempt"."executor_type" = 'local_process'
           AND "attempt"."deadline_at_ms" IS NOT NULL
           AND "attempt"."deadline_at_ms" <= ?
           AND (
             (
               "attempt"."step_run_id" IS NOT NULL
               AND EXISTS (
                 SELECT 1
                 FROM "QingLong3PluginPackageWorkflowTaskAttemptAdmissions"
                   AS "workflow_task"
                 WHERE "workflow_task"."attempt_id" = "attempt"."id"
                   AND "workflow_task"."run_id" = "attempt"."run_id"
                   AND "workflow_task"."step_run_id" =
                     "attempt"."step_run_id"
               )
             )
             OR NOT EXISTS (
               SELECT 1 FROM "RunAttempts" AS "newer"
               WHERE "newer"."run_id" = "attempt"."run_id"
                 AND "newer"."attempt" > "attempt"."attempt"
             )
           )
       )
       SELECT "kind", "runId", "attemptId", "dueAtMs", "cancelReason"
       FROM "control_candidates"
       WHERE ? IS NULL
          OR "dueAtMs" > ?
          OR ("dueAtMs" = ? AND "kind" > ?)
          OR ("dueAtMs" = ? AND "kind" = ? AND "attemptId" > ?)
       ORDER BY "dueAtMs", "kind", "attemptId"
       LIMIT ?`,
      [
        options.observedAtMs,
        options.observedAtMs,
        after?.attemptId ?? null,
        after?.dueAtMs ?? 0,
        after?.dueAtMs ?? 0,
        after?.kind ?? '',
        after?.dueAtMs ?? 0,
        after?.kind ?? '',
        after?.attemptId ?? '',
        options.limit + 1,
      ],
    );
    const truncated = rows.length > options.limit;
    const candidates = rows.slice(0, options.limit).map((row) => {
      const kind = requiredEnum(row, 'kind', [
        'cancellation',
        'deadline',
      ] as const);
      return normalizeLocalExecutionControlCandidate({
        kind,
        runId: requiredString(row, 'runId'),
        attemptId: requiredString(row, 'attemptId'),
        dueAtMs: requiredInteger(row, 'dueAtMs'),
        ...(kind === 'cancellation'
          ? {
              cancelReason: requiredEnum(
                row,
                'cancelReason',
                RUN_CANCELLATION_REASONS,
              ),
            }
          : {}),
      });
    });
    const last = candidates.at(-1);
    return Object.freeze({
      candidates: Object.freeze(candidates),
      truncated,
      ...(truncated && last
        ? {
            nextCursor: Object.freeze({
              dueAtMs: last.dueAtMs,
              kind: last.kind,
              attemptId: last.attemptId,
            }),
          }
        : {}),
    });
  }

  async listLocalActiveExecutions(options: {
    readonly limit: number;
    readonly after?: LocalActiveExecutionCursor;
  }): Promise<LocalActiveExecutionPage> {
    assertLocalExecutionControlLimit(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizeLocalActiveExecutionCursor(options.after);
    const rows = queryRows(
      this.client,
      `SELECT "run"."id" AS "runId", "attempt"."id" AS "attemptId",
              "attempt"."created_at_ms" AS "attemptCreatedAtMs"
       FROM "Runs" AS "run"
       JOIN "RunAttempts" AS "attempt"
         ON "attempt"."run_id" = "run"."id"
       WHERE "run"."execution_owner" = 'runtime'
         AND "run"."status" NOT IN ('succeeded','failed','cancelled','timed_out')
         AND "attempt"."status" IN ('claimed','starting','running')
         AND "attempt"."executor_type" = 'local_process'
         AND (
           (
             "attempt"."step_run_id" IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM "QingLong3PluginPackageWorkflowTaskAttemptAdmissions"
                 AS "workflow_task"
               WHERE "workflow_task"."attempt_id" = "attempt"."id"
                 AND "workflow_task"."run_id" = "attempt"."run_id"
                 AND "workflow_task"."step_run_id" =
                   "attempt"."step_run_id"
             )
           )
           OR NOT EXISTS (
             SELECT 1 FROM "RunAttempts" AS "newer"
             WHERE "newer"."run_id" = "attempt"."run_id"
               AND "newer"."attempt" > "attempt"."attempt"
           )
         )
         AND (
           ? IS NULL
           OR "attempt"."created_at_ms" > ?
           OR ("attempt"."created_at_ms" = ? AND "attempt"."id" > ?)
         )
       ORDER BY "attempt"."created_at_ms", "attempt"."id"
       LIMIT ?`,
      [
        after?.attemptId ?? null,
        after?.attemptCreatedAtMs ?? 0,
        after?.attemptCreatedAtMs ?? 0,
        after?.attemptId ?? '',
        options.limit + 1,
      ],
    );
    const truncated = rows.length > options.limit;
    const candidates = rows.slice(0, options.limit).map((row) =>
      normalizeLocalActiveExecutionCandidate({
        runId: requiredString(row, 'runId'),
        attemptId: requiredString(row, 'attemptId'),
        attemptCreatedAtMs: requiredInteger(row, 'attemptCreatedAtMs'),
      }),
    );
    const last = candidates.at(-1);
    return Object.freeze({
      candidates: Object.freeze(candidates),
      truncated,
      ...(truncated && last
        ? {
            nextCursor: Object.freeze({
              attemptCreatedAtMs: last.attemptCreatedAtMs,
              attemptId: last.attemptId,
            }),
          }
        : {}),
    });
  }

  async inspectStartupRecoveryCandidates(
    options: { limit?: number } = {},
  ): Promise<LocalRunStartupRecoveryPage> {
    const limit = options.limit ?? 64;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_LOCAL_RUN_STARTUP_RECOVERY_CANDIDATES
    ) {
      throw new RangeError(
        'limit must be between 1 and MAX_LOCAL_RUN_STARTUP_RECOVERY_CANDIDATES',
      );
    }
    const rows = queryRows(
      this.client,
      `SELECT
         "run"."id" AS "runId",
         "run"."status" AS "runStatus",
         (
           SELECT COUNT(*) FROM "RunAttempts" AS "attempt"
           WHERE "attempt"."run_id" = "run"."id"
             AND "attempt"."status" IN ('claimed','starting','running')
         ) AS "activeAttemptCount"
       FROM "Runs" AS "run"
       WHERE "run"."execution_owner" = 'runtime'
         AND "run"."status" IN ('dispatching','running')
         AND NOT EXISTS (
           SELECT 1
           FROM "QingLong3PluginPackageWorkflowAdmissions" AS "workflow"
           WHERE "workflow"."run_id" = "run"."id"
         )
       ORDER BY "run"."id"
       LIMIT ?`,
      [limit + 1],
    );
    const truncated = rows.length > limit;
    const candidates = rows.slice(0, limit).map((row) => {
      const runStatus = requiredEnum(row, 'runStatus', [
        'dispatching',
        'running',
      ] as const);
      const candidate: LocalRunStartupRecoveryCandidate = {
        runId: requiredString(row, 'runId'),
        runStatus,
        activeAttemptCount: requiredInteger(row, 'activeAttemptCount'),
      };
      return Object.freeze(candidate);
    });
    return Object.freeze({
      candidates: Object.freeze(candidates),
      truncated,
    });
  }

  async listLocalDispatchCandidates(options: {
    readonly limit: number;
    readonly after?: LocalDispatchCandidateCursor;
  }): Promise<LocalDispatchCandidatePage> {
    assertLocalDispatchPageSize(options.limit);
    const after = options.after;
    if (after !== undefined) {
      normalizeLocalDispatchCandidate({
        runId: 'cursor-validation-run',
        attemptId: after.attemptId,
        projectId: 'cursor-validation-project',
        taskId: 'cursor-validation-task',
        taskRevision: 'cursor-validation-revision',
        attemptNumber: 1,
        executorType: LOCAL_PROCESS_EXECUTOR_TYPE,
        priority: after.priority,
        queuedAtMs: after.queuedAtMs,
        attemptCreatedAtMs: after.attemptCreatedAtMs,
      });
    }
    const rows = queryRows(
      this.client,
      `WITH "dispatch_candidates" AS (
         SELECT
           "run"."id" AS "runId", NULL AS "stepRunId",
           "run"."project_id" AS "projectId",
           "run"."task_id" AS "taskId",
           "run"."task_revision" AS "taskRevision",
           "run"."priority" AS "priority",
           "run"."queued_at_ms" AS "queuedAtMs",
           "attempt"."id" AS "attemptId",
           "attempt"."attempt" AS "attemptNumber",
           "attempt"."created_at_ms" AS "attemptCreatedAtMs",
           "attempt"."executor_type" AS "executorType"
         FROM "Runs" AS "run"
         JOIN "RunAttempts" AS "attempt"
           ON "attempt"."run_id" = "run"."id"
         WHERE "run"."execution_owner" = 'runtime'
           AND "run"."status" = 'queued'
           AND "run"."cancel_requested_at_ms" IS NULL
           AND "run"."queued_at_ms" IS NOT NULL
           AND "attempt"."step_run_id" IS NULL
           AND "attempt"."status" = 'claimed'
           AND "attempt"."executor_type" = 'local_process'
           AND NOT EXISTS (
             SELECT 1 FROM "RunAttempts" AS "newer"
             WHERE "newer"."run_id" = "attempt"."run_id"
               AND "newer"."attempt" > "attempt"."attempt"
           )
         UNION ALL
         SELECT
           "run"."id" AS "runId", "step"."id" AS "stepRunId",
           "task_attempt"."project_id" AS "projectId",
           "task_attempt"."task_id" AS "taskId",
           "task_attempt"."task_revision" AS "taskRevision",
           "run"."priority" AS "priority",
           "step"."ready_at_ms" AS "queuedAtMs",
           "attempt"."id" AS "attemptId",
           "attempt"."attempt" AS "attemptNumber",
           "attempt"."created_at_ms" AS "attemptCreatedAtMs",
           "attempt"."executor_type" AS "executorType"
         FROM "QingLong3PluginPackageWorkflowTaskAttemptAdmissions"
           AS "task_attempt"
         JOIN "Runs" AS "run"
           ON "run"."id" = "task_attempt"."run_id"
         JOIN "RunAttempts" AS "attempt"
           ON "attempt"."id" = "task_attempt"."attempt_id"
          AND "attempt"."run_id" = "task_attempt"."run_id"
          AND "attempt"."step_run_id" = "task_attempt"."step_run_id"
         JOIN "StepRuns" AS "step"
           ON "step"."run_id" = "task_attempt"."run_id"
          AND "step"."id" = "task_attempt"."step_run_id"
         WHERE "run"."execution_owner" = 'runtime'
           AND "run"."status" = 'running'
           AND "run"."cancel_requested_at_ms" IS NULL
           AND "attempt"."status" = 'claimed'
           AND "attempt"."executor_type" = 'local_process'
           AND "step"."status" = 'ready'
           AND "step"."ready_at_ms" IS NOT NULL
           AND "step"."version" = "task_attempt"."step_run_version"
           AND "step"."step_run_digest" =
             "task_attempt"."step_run_digest"
       )
       SELECT *
       FROM "dispatch_candidates"
       WHERE (
         ? IS NULL
         OR "priority" < ?
         OR ("priority" = ? AND "queuedAtMs" > ?)
         OR ("priority" = ? AND "queuedAtMs" = ?
             AND "attemptCreatedAtMs" > ?)
         OR ("priority" = ? AND "queuedAtMs" = ?
             AND "attemptCreatedAtMs" = ? AND "attemptId" > ?)
       )
       ORDER BY "priority" DESC, "queuedAtMs",
                "attemptCreatedAtMs", "attemptId"
       LIMIT ?`,
      [
        after?.attemptId ?? null,
        after?.priority ?? 0,
        after?.priority ?? 0,
        after?.queuedAtMs ?? 0,
        after?.priority ?? 0,
        after?.queuedAtMs ?? 0,
        after?.attemptCreatedAtMs ?? 0,
        after?.priority ?? 0,
        after?.queuedAtMs ?? 0,
        after?.attemptCreatedAtMs ?? 0,
        after?.attemptId ?? '',
        options.limit + 1,
      ],
    );
    const truncated = rows.length > options.limit;
    const candidates = rows.slice(0, options.limit).map((row) =>
      normalizeLocalDispatchCandidate({
        runId: requiredString(row, 'runId'),
        attemptId: requiredString(row, 'attemptId'),
        ...(optionalString(row, 'stepRunId') === undefined
          ? {}
          : { stepRunId: optionalString(row, 'stepRunId')! }),
        projectId: requiredString(row, 'projectId'),
        taskId: requiredString(row, 'taskId'),
        taskRevision: requiredString(row, 'taskRevision'),
        attemptNumber: requiredInteger(row, 'attemptNumber'),
        executorType: requiredEnum(row, 'executorType', [
          LOCAL_PROCESS_EXECUTOR_TYPE,
        ] as const),
        priority: requiredInteger(row, 'priority'),
        queuedAtMs: requiredInteger(row, 'queuedAtMs'),
        attemptCreatedAtMs: requiredInteger(row, 'attemptCreatedAtMs'),
      }),
    );
    return Object.freeze({
      candidates: Object.freeze(candidates),
      truncated,
    });
  }

  async resolveLocalTaskExecutionRevision(identity: {
    readonly projectId: string;
    readonly taskId: string;
    readonly taskRevision: string;
  }): Promise<LocalTaskExecutionRevision | null> {
    const row = singleRow(
      queryRows(
        this.client,
        `SELECT
           "project_id" AS "projectId", "task_id" AS "taskId",
           "task_revision" AS "taskRevision",
           "executor_type" AS "executorType", "command_json" AS "commandJson",
           "working_directory" AS "workingDirectory",
           "timeout_ms" AS "timeoutMs", "context_ref" AS "contextRef",
           "content_digest" AS "contentDigest",
           "created_at_ms" AS "createdAtMs"
         FROM "QingLong3LocalTaskExecutionRevisions"
         WHERE "project_id" = ? AND "task_id" = ? AND "task_revision" = ?
         LIMIT 2`,
        [identity.projectId, identity.taskId, identity.taskRevision],
      ),
    );
    if (!row) return null;
    return normalizeLocalTaskExecutionRevision({
      projectId: requiredString(row, 'projectId'),
      taskId: requiredString(row, 'taskId'),
      taskRevision: requiredString(row, 'taskRevision'),
      executorType: requiredEnum(row, 'executorType', [
        LOCAL_PROCESS_EXECUTOR_TYPE,
      ] as const),
      command: requiredJson(
        row,
        'commandJson',
      ) as LocalTaskExecutionRevision['command'],
      ...(optionalString(row, 'workingDirectory') === undefined
        ? {}
        : { workingDirectory: optionalString(row, 'workingDirectory')! }),
      ...(optionalInteger(row, 'timeoutMs') === undefined
        ? {}
        : { timeoutMs: optionalInteger(row, 'timeoutMs')! }),
      contextRef: requiredString(row, 'contextRef'),
      contentDigest: requiredString(row, 'contentDigest'),
      createdAtMs: requiredInteger(row, 'createdAtMs'),
    });
  }

  async resolveLocalExecutionContextRecipe(
    contextRef: string,
  ): Promise<LocalExecutionContextRecipe | null> {
    assertLocalDispatchContextRef(contextRef);
    const row = singleRow(
      queryRows(
        this.client,
        `SELECT "context_ref" AS "contextRef",
                "environment_json" AS "environmentJson",
                "content_digest" AS "contentDigest",
                "created_at_ms" AS "createdAtMs"
         FROM "QingLong3LocalExecutionContextRecipes"
         WHERE "context_ref" = ? LIMIT 2`,
        [contextRef],
      ),
    );
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
}
