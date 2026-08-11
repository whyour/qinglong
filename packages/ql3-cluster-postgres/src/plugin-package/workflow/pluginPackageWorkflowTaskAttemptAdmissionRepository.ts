// PostgreSQL authority for admitting Plugin Package Workflow task attempts.
import type {
  PostgresClient,
  PostgresPool,
  RunRecord,
} from '@qinglong/runtime-core';
import {
  normalizeClusterTaskExecutionRevision,
  type ClusterTaskExecutionRevision,
} from '@qinglong/runtime-core/cluster-execution-revision';
import {
  createPluginPackageWorkflowTaskAttemptAdmission,
  InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  MAX_PLUGIN_PACKAGE_WORKFLOW_TASK_ATTEMPT_PAGE_SIZE,
  normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt,
  PluginPackageWorkflowTaskAttemptAdmissionConflictError,
  PluginPackageWorkflowTaskAttemptAdmissionUnavailableError,
  type PluginPackageWorkflowTaskAttemptAdmissionCandidate,
  type PluginPackageWorkflowTaskAttemptAdmissionCursor,
  type PluginPackageWorkflowTaskAttemptAdmissionPage,
  type PluginPackageWorkflowTaskAttemptAdmissionReceipt,
  type PluginPackageWorkflowTaskAttemptAdmissionRepository,
  type PluginPackageWorkflowTaskAttemptAdmissionResult,
} from '@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission';
import {
  normalizePluginPackageTaskReconciliationReceipt,
  type PluginPackageTaskReconciliationReceipt,
} from '@qinglong/runtime-core/plugin-package-task-reconciliation';
import {
  normalizePluginPackageWorkflowExecutionPlan,
  type PluginPackageWorkflowExecutionPlan,
} from '@qinglong/runtime-core/plugin-package-workflow-execution-plan';
import {
  normalizeStepRunRecord,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';

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

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;

const RUN_SELECT = `
  id, project_id AS "projectId", task_id AS "taskId",
  task_revision AS "taskRevision", task_name AS "taskName",
  task_snapshot_ref AS "taskSnapshotRef", legacy_cron_id AS "legacyCronId",
  parent_run_id AS "parentRunId", retry_of_run_id AS "retryOfRunId",
  trigger_id AS "triggerId", trigger_type AS "triggerType",
  execution_origin AS "executionOrigin",
  execution_owner AS "executionOwner", triggered_by AS "triggeredBy",
  request_id AS "requestId", scheduled_for_ms AS "scheduledForMs",
  status, version, event_sequence AS "eventSequence", priority,
  idempotency_key AS "idempotencyKey", input_ref AS "inputRef",
  output_ref AS "outputRef", created_at_ms AS "createdAtMs",
  queued_at_ms AS "queuedAtMs", started_at_ms AS "startedAtMs",
  finished_at_ms AS "finishedAtMs",
  cancel_requested_at_ms AS "cancelRequestedAtMs",
  cancel_reason AS "cancelReason", error_code AS "errorCode",
  error_summary AS "errorSummary"
`.trim();

const STEP_RUN_SELECT = `
  id, run_id AS "runId", parent_step_run_id AS "parentStepRunId",
  step_key AS "stepKey", kind, definition_ref AS "definitionRef",
  definition_digest AS "definitionDigest", required, status, version,
  attempt_count AS "attemptCount", input_ref AS "inputRef",
  output_ref AS "outputRef", approval_request_id AS "approvalRequestId",
  ready_at_ms AS "readyAtMs", started_at_ms AS "startedAtMs",
  finished_at_ms AS "finishedAtMs", result_code AS "resultCode",
  error_summary AS "errorSummary", created_at_ms AS "createdAtMs",
  updated_at_ms AS "updatedAtMs", last_mutation_id AS "lastMutationId",
  step_run_digest AS "stepRunDigest", step_run_json AS "stepRunJson"
`.trim();

function unavailable(
  cause?: unknown,
): PluginPackageWorkflowTaskAttemptAdmissionUnavailableError {
  return new PluginPackageWorkflowTaskAttemptAdmissionUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function text(row: Row, key: string): string {
  return postgresRequiredString(row[key], unavailable);
}

function integer(row: Row, key: string): number {
  const value = postgresRequiredInteger(row[key], unavailable);
  if (value < 0) throw unavailable();
  return value;
}

function optionalText(row: Row, key: string): string | undefined {
  if (row[key] === null || row[key] === undefined) return undefined;
  return text(row, key);
}

function optionalInteger(row: Row, key: string): number | undefined {
  if (row[key] === null || row[key] === undefined) return undefined;
  return integer(row, key);
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw new InvalidPluginPackageWorkflowTaskAttemptAdmissionError(
      `${label} is invalid`,
    );
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw unavailable();
  return value;
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof
      InvalidPluginPackageWorkflowTaskAttemptAdmissionError ||
    error instanceof
      PluginPackageWorkflowTaskAttemptAdmissionConflictError ||
    error instanceof
      PluginPackageWorkflowTaskAttemptAdmissionUnavailableError
  ) {
    return error;
  }
  return ['23503', '23505', '23514'].includes(
    postgresSqlState(error) ?? '',
  )
    ? new PluginPackageWorkflowTaskAttemptAdmissionConflictError()
    : unavailable(error);
}

function pageLimit(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) >
      MAX_PLUGIN_PACKAGE_WORKFLOW_TASK_ATTEMPT_PAGE_SIZE
  ) {
    throw new InvalidPluginPackageWorkflowTaskAttemptAdmissionError(
      `page limit must be between 1 and ${MAX_PLUGIN_PACKAGE_WORKFLOW_TASK_ATTEMPT_PAGE_SIZE}`,
    );
  }
  return value as number;
}

function cursor(
  value:
    | Readonly<PluginPackageWorkflowTaskAttemptAdmissionCursor>
    | undefined,
):
  | Readonly<PluginPackageWorkflowTaskAttemptAdmissionCursor>
  | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    !Reflect.has(value, 'readyAtMs') ||
    !Reflect.has(value, 'stepRunId') ||
    !Number.isSafeInteger(value.readyAtMs) ||
    value.readyAtMs < 0 ||
    typeof value.stepRunId !== 'string' ||
    !IDENTITY.test(value.stepRunId)
  ) {
    throw new InvalidPluginPackageWorkflowTaskAttemptAdmissionError(
      'candidate cursor is invalid',
    );
  }
  return Object.freeze({
    readyAtMs: value.readyAtMs,
    stepRunId: value.stepRunId,
  });
}

function runFromRow(row: Row): Readonly<RunRecord> {
  const run: RunRecord = {
    id: text(row, 'id'),
    projectId: text(row, 'projectId'),
    taskId: text(row, 'taskId'),
    taskRevision: text(row, 'taskRevision'),
    triggerType: text(row, 'triggerType'),
    executionOrigin: text(
      row,
      'executionOrigin',
    ) as RunRecord['executionOrigin'],
    executionOwner: text(row, 'executionOwner') as RunRecord['executionOwner'],
    status: text(row, 'status') as RunRecord['status'],
    version: integer(row, 'version'),
    eventSequence: integer(row, 'eventSequence'),
    priority: integer(row, 'priority'),
    createdAtMs: integer(row, 'createdAtMs'),
  };
  const optionalTexts = [
    ['taskName', 'taskName'],
    ['taskSnapshotRef', 'taskSnapshotRef'],
    ['parentRunId', 'parentRunId'],
    ['retryOfRunId', 'retryOfRunId'],
    ['triggerId', 'triggerId'],
    ['triggeredBy', 'triggeredBy'],
    ['requestId', 'requestId'],
    ['idempotencyKey', 'idempotencyKey'],
    ['inputRef', 'inputRef'],
    ['outputRef', 'outputRef'],
    ['errorCode', 'errorCode'],
    ['errorSummary', 'errorSummary'],
  ] as const;
  for (const [property, key] of optionalTexts) {
    const value = optionalText(row, key);
    if (value !== undefined) {
      (run as unknown as Record<string, unknown>)[property] = value;
    }
  }
  const optionalIntegers = [
    ['legacyCronId', 'legacyCronId'],
    ['scheduledForMs', 'scheduledForMs'],
    ['queuedAtMs', 'queuedAtMs'],
    ['startedAtMs', 'startedAtMs'],
    ['finishedAtMs', 'finishedAtMs'],
    ['cancelRequestedAtMs', 'cancelRequestedAtMs'],
  ] as const;
  for (const [property, key] of optionalIntegers) {
    const value = optionalInteger(row, key);
    if (value !== undefined) {
      (run as unknown as Record<string, unknown>)[property] = value;
    }
  }
  const cancelReason = optionalText(row, 'cancelReason');
  if (cancelReason !== undefined) {
    run.cancelReason =
      cancelReason as NonNullable<RunRecord['cancelReason']>;
  }
  return Object.freeze(run);
}

function stepRunFromRow(row: Row): Readonly<StepRunRecord> {
  let stepRun: Readonly<StepRunRecord>;
  try {
    stepRun = normalizeStepRunRecord(
      postgresRequiredJsonObject(
        row.stepRunJson,
        unavailable,
      ) as unknown as StepRunRecord,
    );
  } catch {
    throw unavailable();
  }
  if (
    text(row, 'id') !== stepRun.id ||
    text(row, 'runId') !== stepRun.runId ||
    optionalText(row, 'parentStepRunId') !==
      (stepRun.parentStepRunId ?? undefined) ||
    text(row, 'stepKey') !== stepRun.stepKey ||
    text(row, 'kind') !== stepRun.kind ||
    text(row, 'definitionRef') !== stepRun.definitionRef ||
    text(row, 'definitionDigest') !== stepRun.definitionDigest ||
    postgresRequiredBoolean(row.required, unavailable) !== stepRun.required ||
    text(row, 'status') !== stepRun.status ||
    integer(row, 'version') !== stepRun.version ||
    integer(row, 'attemptCount') !== stepRun.attemptCount ||
    optionalText(row, 'inputRef') !== (stepRun.inputRef ?? undefined) ||
    optionalText(row, 'outputRef') !== (stepRun.outputRef ?? undefined) ||
    optionalText(row, 'approvalRequestId') !==
      (stepRun.approvalRequestId ?? undefined) ||
    optionalInteger(row, 'readyAtMs') !==
      (stepRun.readyAtMs ?? undefined) ||
    optionalInteger(row, 'startedAtMs') !==
      (stepRun.startedAtMs ?? undefined) ||
    optionalInteger(row, 'finishedAtMs') !==
      (stepRun.finishedAtMs ?? undefined) ||
    optionalText(row, 'resultCode') !==
      (stepRun.resultCode ?? undefined) ||
    optionalText(row, 'errorSummary') !==
      (stepRun.errorSummary ?? undefined) ||
    integer(row, 'createdAtMs') !== stepRun.createdAtMs ||
    integer(row, 'updatedAtMs') !== stepRun.updatedAtMs ||
    text(row, 'lastMutationId') !== stepRun.lastMutationId ||
    text(row, 'stepRunDigest') !== stepRun.stepRunDigest
  ) {
    throw unavailable();
  }
  return stepRun;
}

function planFromRow(row: Row): Readonly<PluginPackageWorkflowExecutionPlan> {
  try {
    return normalizePluginPackageWorkflowExecutionPlan(
      postgresRequiredJsonObject(
        row.planJson,
        unavailable,
      ) as unknown as PluginPackageWorkflowExecutionPlan,
    );
  } catch {
    throw unavailable();
  }
}

function reconciliationFromRow(
  row: Row,
): Readonly<PluginPackageTaskReconciliationReceipt> {
  try {
    return normalizePluginPackageTaskReconciliationReceipt(
      postgresRequiredJsonObject(
        row.reconciliationJson,
        unavailable,
      ) as unknown as PluginPackageTaskReconciliationReceipt,
    );
  } catch {
    throw unavailable();
  }
}

function executionFromRow(
  row: Row,
): Readonly<ClusterTaskExecutionRevision> {
  try {
    const plan = postgresRequiredJsonObject(row.executionPlanJson, unavailable);
    const keys = Object.keys(plan);
    if (
      !keys.includes('command') ||
      !keys.includes('environment') ||
      keys.some(
        (key) =>
          ![
            'command',
            'environment',
            'placement',
            'timeoutMs',
            'workingDirectory',
          ].includes(key),
      )
    ) {
      throw unavailable();
    }
    return normalizeClusterTaskExecutionRevision({
      projectId: text(row, 'executionProjectId'),
      taskId: text(row, 'executionTaskId'),
      sourceRevision: integer(row, 'executionSourceRevision'),
      taskRevision: text(row, 'executionTaskRevision'),
      sourceContentDigest: text(row, 'executionSourceContentDigest'),
      executorType: text(
        row,
        'executionExecutorType',
      ) as ClusterTaskExecutionRevision['executorType'],
      planSchema: text(
        row,
        'executionPlanSchema',
      ) as ClusterTaskExecutionRevision['planSchema'],
      command: plan.command as ClusterTaskExecutionRevision['command'],
      environment:
        plan.environment as ClusterTaskExecutionRevision['environment'],
      ...(plan.workingDirectory === undefined
        ? {}
        : { workingDirectory: plan.workingDirectory as string }),
      ...(plan.timeoutMs === undefined
        ? {}
        : { timeoutMs: plan.timeoutMs as number }),
      ...(plan.placement === undefined
        ? {}
        : {
            placement:
              plan.placement as unknown as NonNullable<
                ClusterTaskExecutionRevision['placement']
              >,
          }),
      contentDigest: text(row, 'executionContentDigest'),
      createdAtMs: integer(row, 'executionCreatedAtMs'),
    });
  } catch (error) {
    if (
      error instanceof
      PluginPackageWorkflowTaskAttemptAdmissionUnavailableError
    ) {
      throw error;
    }
    throw unavailable();
  }
}

function receiptFromRow(
  row: Row,
): Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt> {
  try {
    const receipt =
      normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt(
        postgresRequiredJsonObject(
          row.receiptJson,
          unavailable,
        ) as unknown as PluginPackageWorkflowTaskAttemptAdmissionReceipt,
      );
    if (
      row.receiptDigest !== undefined &&
      text(row, 'receiptDigest') !== receipt.receiptDigest
    ) {
      throw unavailable();
    }
    return receipt;
  } catch (error) {
    if (
      error instanceof
      PluginPackageWorkflowTaskAttemptAdmissionUnavailableError
    ) {
      throw error;
    }
    throw unavailable();
  }
}

export class PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository
  implements PluginPackageWorkflowTaskAttemptAdmissionRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError(
        'PostgreSQL Workflow Task Attempt admission pool is invalid',
      );
    }
  }

  async listCandidates(queryValue: Readonly<{
    limit: number;
    after?: Readonly<PluginPackageWorkflowTaskAttemptAdmissionCursor>;
  }>): Promise<
    Readonly<PluginPackageWorkflowTaskAttemptAdmissionPage>
  > {
    if (
      !queryValue ||
      typeof queryValue !== 'object' ||
      Array.isArray(queryValue) ||
      !Reflect.has(queryValue, 'limit') ||
      Reflect.ownKeys(queryValue).some(
        (key) => key !== 'limit' && key !== 'after',
      )
    ) {
      throw new InvalidPluginPackageWorkflowTaskAttemptAdmissionError(
        'page query is invalid',
      );
    }
    const limit = pageLimit(queryValue.limit);
    const after = cursor(queryValue.after);
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw unavailable(error);
    }
    try {
      const result = await client.query<Row>(
        `SELECT current.run_id AS "runId",
                current.id AS "stepRunId",
                current.ready_at_ms AS "readyAtMs",
                admission.plan_digest AS "planDigest"
         FROM "ql3"."step_runs" AS current
         JOIN "ql3"."plugin_package_workflow_admission_steps" AS source
           ON source.run_id = current.run_id
          AND source.step_run_id = current.id
         JOIN "ql3"."plugin_package_workflow_admissions" AS admission
           ON admission.plan_digest = source.plan_digest
          AND admission.run_id = source.run_id
         JOIN "ql3"."runs" AS run ON run.id = current.run_id
         WHERE run.status = 'running'
           AND run.cancel_requested_at_ms IS NULL
           AND current.kind = 'task'
           AND current.status = 'ready'
           AND current.ready_at_ms IS NOT NULL
           AND current.attempt_count < 64
           AND NOT EXISTS (
             SELECT 1
             FROM "ql3"."plugin_package_workflow_task_attempt_admissions"
               AS task_attempt
             WHERE task_attempt.run_id = current.run_id
               AND task_attempt.step_run_id = current.id
               AND task_attempt.step_run_version = current.version
           )
           AND (
             $1::varchar IS NULL OR current.ready_at_ms > $2 OR
             (current.ready_at_ms = $2 AND current.id > $1)
           )
         ORDER BY current.ready_at_ms, current.id
         LIMIT $3`,
        [
          after?.stepRunId ?? null,
          after?.readyAtMs ?? 0,
          limit + 1,
        ],
      );
      const mapped = result.rows.map(
        (row): Readonly<PluginPackageWorkflowTaskAttemptAdmissionCandidate> =>
          Object.freeze({
            runId: identity(text(row, 'runId'), 'candidate runId'),
            stepRunId: identity(
              text(row, 'stepRunId'),
              'candidate stepRunId',
            ),
            readyAtMs: integer(row, 'readyAtMs'),
            planDigest: digest(row.planDigest),
          }),
      );
      const truncated = mapped.length > limit;
      const candidates = Object.freeze(mapped.slice(0, limit));
      const last = candidates.at(-1);
      return Object.freeze({
        candidates,
        truncated,
        ...(truncated && last
          ? {
              next: Object.freeze({
                readyAtMs: last.readyAtMs,
                stepRunId: last.stepRunId,
              }),
            }
          : {}),
      });
    } catch (error) {
      throw mapStorageError(error);
    } finally {
      client.release();
    }
  }

  async admit(
    runIdValue: string,
    stepRunIdValue: string,
  ): Promise<
    Readonly<PluginPackageWorkflowTaskAttemptAdmissionResult>
  > {
    const runId = identity(runIdValue, 'runId');
    const stepRunId = identity(stepRunIdValue, 'stepRunId');
    for (
      let transactionAttempt = 0;
      transactionAttempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      transactionAttempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        throw unavailable(error);
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const runRows = await client.query<Row>(
          `SELECT ${RUN_SELECT}
           FROM "ql3"."runs" WHERE id = $1 LIMIT 2 FOR UPDATE`,
          [runId],
        );
        if (runRows.rows.length !== 1) {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        const run = runFromRow(runRows.rows[0]!);
        const stepRows = await client.query<Row>(
          `SELECT ${STEP_RUN_SELECT}
           FROM "ql3"."step_runs"
           WHERE run_id = $1 AND id = $2 LIMIT 2 FOR UPDATE`,
          [runId, stepRunId],
        );
        if (stepRows.rows.length !== 1) {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        const stepRun = stepRunFromRow(stepRows.rows[0]!);
        const existing = await client.query<Row>(
          `SELECT receipt_digest AS "receiptDigest",
                  receipt_json AS "receiptJson"
           FROM "ql3"."plugin_package_workflow_task_attempt_admissions"
           WHERE run_id = $1 AND step_run_id = $2
             AND step_run_version = $3
           LIMIT 2`,
          [runId, stepRunId, stepRun.version],
        );
        if (existing.rows.length > 1) throw unavailable();
        if (existing.rows.length === 1) {
          const receipt = receiptFromRow(existing.rows[0]!);
          if (
            receipt.runId !== runId ||
            receipt.stepRunId !== stepRunId ||
            receipt.stepRunVersion !== stepRun.version ||
            receipt.stepRunDigest !== stepRun.stepRunDigest
          ) {
            throw unavailable();
          }
          await client.query('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing' as const,
            receipt,
          });
        }
        if (stepRun.status !== 'ready') {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        const snapshot = await client.query<Row>(
          `SELECT plan_json AS "planJson",
                  reconciliation_json AS "reconciliationJson",
                  execution_project_id AS "executionProjectId",
                  execution_task_id AS "executionTaskId",
                  execution_source_revision AS "executionSourceRevision",
                  execution_task_revision AS "executionTaskRevision",
                  execution_source_content_digest
                    AS "executionSourceContentDigest",
                  execution_executor_type AS "executionExecutorType",
                  execution_plan_schema AS "executionPlanSchema",
                  execution_plan_json AS "executionPlanJson",
                  execution_content_digest AS "executionContentDigest",
                  execution_created_at_ms AS "executionCreatedAtMs"
           FROM "ql3"."plugin_package_workflow_task_attempt_snapshot"($1, $2)`,
          [runId, stepRunId],
        );
        if (snapshot.rows.length !== 1) {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        const snapshotRow = snapshot.rows[0]!;
        const plan = planFromRow(snapshotRow);
        const taskReconciliation = reconciliationFromRow(snapshotRow);
        const execution = executionFromRow(snapshotRow);
        const clock = await client.query<Row>(
          `SELECT floor(
             extract(epoch FROM transaction_timestamp()) * 1000
           )::bigint AS "admittedAtMs"`,
        );
        if (clock.rows.length !== 1) throw unavailable();
        const attemptNumberRows = await client.query<Row>(
          `SELECT COALESCE(MAX(attempt), 0) + 1 AS "attemptNumber"
           FROM "ql3"."run_attempts" WHERE run_id = $1`,
          [runId],
        );
        if (attemptNumberRows.rows.length !== 1) throw unavailable();
        const bundle = createPluginPackageWorkflowTaskAttemptAdmission({
          plan,
          run,
          stepRun,
          taskReconciliation,
          execution,
          attemptNumber: integer(
            attemptNumberRows.rows[0]!,
            'attemptNumber',
          ),
          admittedAtMs: integer(clock.rows[0]!, 'admittedAtMs'),
        });
        const updated = await client.query(
          `UPDATE "ql3"."runs"
           SET version = $1, event_sequence = $2
           WHERE id = $3 AND status = 'running'
             AND cancel_requested_at_ms IS NULL
             AND version = $4 AND event_sequence = $5`,
          [
            bundle.run.version,
            bundle.run.eventSequence,
            run.id,
            run.version,
            run.eventSequence,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        const attempt = bundle.attempt;
        await client.query(
          `INSERT INTO "ql3"."run_attempts" (
             id, run_id, step_run_id, attempt, status, executor_type,
             callback_sequence, created_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            attempt.id,
            attempt.runId,
            attempt.stepRunId ?? null,
            attempt.attempt,
            attempt.status,
            attempt.executorType,
            attempt.callbackSequence,
            attempt.createdAtMs,
          ],
        );
        const event = bundle.event;
        await client.query(
          `INSERT INTO "ql3"."run_events" (
             id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
             attempt_id, step_run_id, payload, created_at_ms
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11
           )`,
          [
            event.id,
            event.runId,
            event.sequence,
            event.type,
            event.dedupeKey ?? null,
            event.actorType,
            event.actorId ?? null,
            event.attemptId ?? null,
            event.stepRunId ?? null,
            JSON.stringify(event.payload),
            event.createdAtMs,
          ],
        );
        const receipt = bundle.receipt;
        await client.query(
          `INSERT INTO
             "ql3"."plugin_package_workflow_task_attempt_admissions" (
               receipt_digest, attempt_id, plan_digest, run_id,
               step_run_id, step_run_version, step_run_digest,
               generation_digest, resource_task_id,
               task_reconciliation_receipt_digest, project_id, task_id,
               source_revision, task_revision, task_definition_digest,
               executor_type, execution_digest, attempt_number, event_id,
               run_version, run_event_sequence, admitted_at_ms, receipt_json
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb
             )`,
          [
            receipt.receiptDigest,
            receipt.attemptId,
            receipt.planDigest,
            receipt.runId,
            receipt.stepRunId,
            receipt.stepRunVersion,
            receipt.stepRunDigest,
            plan.target.generationDigest,
            receipt.resourceTaskId,
            receipt.taskReconciliationReceiptDigest,
            execution.projectId,
            receipt.taskId,
            execution.sourceRevision,
            receipt.taskRevision,
            receipt.taskDefinitionDigest,
            receipt.executorType,
            receipt.executionDigest,
            receipt.attemptNumber,
            receipt.eventId,
            receipt.runVersion,
            receipt.runEventSequence,
            receipt.admittedAtMs,
            JSON.stringify(receipt),
          ],
        );
        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: 'created' as const,
          receipt,
        });
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          state &&
          POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) &&
          transactionAttempt + 1 <
            POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        throw mapStorageError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
