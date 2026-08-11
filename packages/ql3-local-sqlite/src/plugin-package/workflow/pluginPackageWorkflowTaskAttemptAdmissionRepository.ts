import type { DatabaseSync } from 'node:sqlite';

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
  normalizeLocalTaskExecutionRevision,
  type LocalTaskExecutionRevision,
} from '@qinglong/runtime-core/local-dispatch';
import {
  normalizePluginPackageTaskReconciliationReceipt,
  type PluginPackageTaskReconciliationReceipt,
} from '@qinglong/runtime-core/plugin-package-task-reconciliation';
import {
  normalizePluginPackageWorkflowExecutionPlan,
  type PluginPackageWorkflowExecutionPlan,
} from '@qinglong/runtime-core/plugin-package-workflow-execution-plan';
import type { RunRecord } from '@qinglong/runtime-core';
import {
  normalizeStepRunRecord,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';

import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';

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
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unavailable();
  }
  return value as number;
}

function optionalText(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return text(row, key);
}

function optionalInteger(row: Row, key: string): number | undefined {
  if (row[key] === null || row[key] === undefined) return undefined;
  return integer(row, key);
}

function json(row: Row, key: string): unknown {
  try {
    return JSON.parse(text(row, key));
  } catch {
    throw unavailable();
  }
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw new InvalidPluginPackageWorkflowTaskAttemptAdmissionError(
      `${label} is invalid`,
    );
  }
  return value;
}

function sqliteConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const errcode = (error as { errcode?: unknown }).errcode;
  return (
    (typeof code === 'string' &&
      (code === 'ERR_SQLITE_CONSTRAINT' ||
        code.startsWith('SQLITE_CONSTRAINT') ||
        code.startsWith('ERR_SQLITE_CONSTRAINT'))) ||
    (typeof errcode === 'number' && (errcode & 0xff) === 19)
  );
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
  return sqliteConstraint(error)
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
  return Object.freeze({
    id: text(row, 'id'),
    projectId: text(row, 'projectId'),
    taskId: text(row, 'taskId'),
    taskRevision: text(row, 'taskRevision'),
    ...(optionalText(row, 'taskName') === undefined
      ? {}
      : { taskName: optionalText(row, 'taskName')! }),
    ...(optionalText(row, 'taskSnapshotRef') === undefined
      ? {}
      : { taskSnapshotRef: optionalText(row, 'taskSnapshotRef')! }),
    ...(optionalInteger(row, 'legacyCronId') === undefined
      ? {}
      : { legacyCronId: optionalInteger(row, 'legacyCronId')! }),
    ...(optionalText(row, 'parentRunId') === undefined
      ? {}
      : { parentRunId: optionalText(row, 'parentRunId')! }),
    ...(optionalText(row, 'retryOfRunId') === undefined
      ? {}
      : { retryOfRunId: optionalText(row, 'retryOfRunId')! }),
    ...(optionalText(row, 'triggerId') === undefined
      ? {}
      : { triggerId: optionalText(row, 'triggerId')! }),
    triggerType: text(row, 'triggerType'),
    executionOrigin: text(
      row,
      'executionOrigin',
    ) as RunRecord['executionOrigin'],
    executionOwner: text(row, 'executionOwner') as RunRecord['executionOwner'],
    ...(optionalText(row, 'triggeredBy') === undefined
      ? {}
      : { triggeredBy: optionalText(row, 'triggeredBy')! }),
    ...(optionalText(row, 'requestId') === undefined
      ? {}
      : { requestId: optionalText(row, 'requestId')! }),
    ...(optionalInteger(row, 'scheduledForMs') === undefined
      ? {}
      : { scheduledForMs: optionalInteger(row, 'scheduledForMs')! }),
    status: text(row, 'status') as RunRecord['status'],
    version: integer(row, 'version'),
    eventSequence: integer(row, 'eventSequence'),
    priority: integer(row, 'priority'),
    ...(optionalText(row, 'idempotencyKey') === undefined
      ? {}
      : { idempotencyKey: optionalText(row, 'idempotencyKey')! }),
    ...(optionalText(row, 'inputRef') === undefined
      ? {}
      : { inputRef: optionalText(row, 'inputRef')! }),
    ...(optionalText(row, 'outputRef') === undefined
      ? {}
      : { outputRef: optionalText(row, 'outputRef')! }),
    createdAtMs: integer(row, 'createdAtMs'),
    ...(optionalInteger(row, 'queuedAtMs') === undefined
      ? {}
      : { queuedAtMs: optionalInteger(row, 'queuedAtMs')! }),
    ...(optionalInteger(row, 'startedAtMs') === undefined
      ? {}
      : { startedAtMs: optionalInteger(row, 'startedAtMs')! }),
    ...(optionalInteger(row, 'finishedAtMs') === undefined
      ? {}
      : { finishedAtMs: optionalInteger(row, 'finishedAtMs')! }),
    ...(optionalInteger(row, 'cancelRequestedAtMs') === undefined
      ? {}
      : {
          cancelRequestedAtMs: optionalInteger(row, 'cancelRequestedAtMs')!,
        }),
    ...(optionalText(row, 'cancelReason') === undefined
      ? {}
      : {
          cancelReason: optionalText(
            row,
            'cancelReason',
          )! as NonNullable<RunRecord['cancelReason']>,
        }),
    ...(optionalText(row, 'errorCode') === undefined
      ? {}
      : { errorCode: optionalText(row, 'errorCode')! }),
    ...(optionalText(row, 'errorSummary') === undefined
      ? {}
      : { errorSummary: optionalText(row, 'errorSummary')! }),
  });
}

function stepRunFromRow(row: Row): Readonly<StepRunRecord> {
  let stepRun: Readonly<StepRunRecord>;
  try {
    stepRun = normalizeStepRunRecord(
      json(row, 'stepRunJson') as StepRunRecord,
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
    integer(row, 'required') !== (stepRun.required ? 1 : 0) ||
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

function executionFromRow(row: Row): Readonly<LocalTaskExecutionRevision> {
  try {
    return normalizeLocalTaskExecutionRevision({
      projectId: text(row, 'projectId'),
      taskId: text(row, 'taskId'),
      taskRevision: text(row, 'taskRevision'),
      executorType: 'local_process',
      command: json(
        row,
        'commandJson',
      ) as LocalTaskExecutionRevision['command'],
      ...(optionalText(row, 'workingDirectory') === undefined
        ? {}
        : { workingDirectory: optionalText(row, 'workingDirectory')! }),
      ...(optionalInteger(row, 'timeoutMs') === undefined
        ? {}
        : { timeoutMs: optionalInteger(row, 'timeoutMs')! }),
      contextRef: text(row, 'contextRef'),
      contentDigest: text(row, 'contentDigest'),
      createdAtMs: integer(row, 'createdAtMs'),
    });
  } catch {
    throw unavailable();
  }
}

function receiptFromRow(
  row: Row,
): Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt> {
  try {
    const receipt =
      normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt(
        json(
          row,
          'receiptJson',
        ) as PluginPackageWorkflowTaskAttemptAdmissionReceipt,
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

export class LocalSqlitePluginPackageWorkflowTaskAttemptAdmissionRepository
  implements PluginPackageWorkflowTaskAttemptAdmissionRepository
{
  readonly #authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.#authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  #enqueue<T>(work: () => T): Promise<T> {
    return this.#authority.enqueue(
      async () => {
        try {
          return work();
        } catch (error) {
          throw mapStorageError(error);
        }
      },
      () => unavailable(),
    );
  }

  listCandidates(queryValue: Readonly<{
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
    return this.#enqueue(() => {
      const rows = this.#authority.client
        .prepare(
          `SELECT current.run_id AS "runId",
                  current.id AS "stepRunId",
                  current.ready_at_ms AS "readyAtMs",
                  admission.plan_digest AS "planDigest"
           FROM "StepRuns" AS current
           JOIN "QingLong3PluginPackageWorkflowAdmissionSteps" AS source
             ON source.run_id = current.run_id
            AND source.step_run_id = current.id
           JOIN "QingLong3PluginPackageWorkflowAdmissions" AS admission
             ON admission.plan_digest = source.plan_digest
            AND admission.run_id = source.run_id
           JOIN "Runs" AS run ON run.id = current.run_id
           WHERE run.status = 'running'
             AND run.cancel_requested_at_ms IS NULL
             AND current.kind = 'task'
             AND current.status = 'ready'
             AND current.ready_at_ms IS NOT NULL
             AND current.attempt_count < 64
             AND NOT EXISTS (
               SELECT 1
               FROM "QingLong3PluginPackageWorkflowTaskAttemptAdmissions"
                 AS task_attempt
               WHERE task_attempt.run_id = current.run_id
                 AND task_attempt.step_run_id = current.id
                 AND task_attempt.step_run_version = current.version
             )
             AND (
               ? IS NULL OR current.ready_at_ms > ? OR
               (current.ready_at_ms = ? AND current.id > ?)
             )
           ORDER BY current.ready_at_ms, current.id
           LIMIT ?`,
        )
        .all(
          after?.stepRunId ?? null,
          after?.readyAtMs ?? 0,
          after?.readyAtMs ?? 0,
          after?.stepRunId ?? '',
          limit + 1,
        ) as Row[];
      const mapped = rows.map(
        (row): Readonly<PluginPackageWorkflowTaskAttemptAdmissionCandidate> =>
          Object.freeze({
            runId: identity(text(row, 'runId'), 'candidate runId'),
            stepRunId: identity(
              text(row, 'stepRunId'),
              'candidate stepRunId',
            ),
            readyAtMs: integer(row, 'readyAtMs'),
            planDigest: text(row, 'planDigest'),
          }),
      );
      if (mapped.some(({ planDigest }) => !DIGEST.test(planDigest))) {
        throw unavailable();
      }
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
    });
  }

  admit(
    runIdValue: string,
    stepRunIdValue: string,
  ): Promise<
    Readonly<PluginPackageWorkflowTaskAttemptAdmissionResult>
  > {
    const runId = identity(runIdValue, 'runId');
    const stepRunId = identity(stepRunIdValue, 'stepRunId');
    return this.#enqueue(() => {
      let began = false;
      try {
        const client = this.#authority.client;
        client.exec('BEGIN IMMEDIATE');
        began = true;
        const stepRows = client
          .prepare(
            `SELECT ${STEP_RUN_SELECT}
             FROM "StepRuns"
             WHERE run_id = ? AND id = ? LIMIT 2`,
          )
          .all(runId, stepRunId) as Row[];
        if (stepRows.length !== 1) {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        const stepRun = stepRunFromRow(stepRows[0]!);
        const existingRows = client
          .prepare(
            `SELECT receipt_digest AS "receiptDigest",
                    receipt_json AS "receiptJson"
             FROM "QingLong3PluginPackageWorkflowTaskAttemptAdmissions"
             WHERE run_id = ? AND step_run_id = ?
               AND step_run_version = ?
             LIMIT 2`,
          )
          .all(runId, stepRunId, stepRun.version) as Row[];
        if (existingRows.length > 1) throw unavailable();
        if (existingRows.length === 1) {
          const receipt = receiptFromRow(existingRows[0]!);
          if (
            receipt.runId !== runId ||
            receipt.stepRunId !== stepRunId ||
            receipt.stepRunVersion !== stepRun.version ||
            receipt.stepRunDigest !== stepRun.stepRunDigest
          ) {
            throw unavailable();
          }
          client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing' as const,
            receipt,
          });
        }
        if (stepRun.status !== 'ready') {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        const admissionRows = client
          .prepare(
            `SELECT plan_json AS "planJson"
             FROM "QingLong3PluginPackageWorkflowAdmissions"
             WHERE run_id = ? LIMIT 2`,
          )
          .all(runId) as Row[];
        if (admissionRows.length !== 1) {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        let plan: Readonly<PluginPackageWorkflowExecutionPlan>;
        try {
          plan = normalizePluginPackageWorkflowExecutionPlan(
            json(
              admissionRows[0]!,
              'planJson',
            ) as PluginPackageWorkflowExecutionPlan,
          );
        } catch {
          throw unavailable();
        }
        const runRows = client
          .prepare(`SELECT ${RUN_SELECT} FROM "Runs" WHERE id = ? LIMIT 2`)
          .all(runId) as Row[];
        if (runRows.length !== 1) {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        const run = runFromRow(runRows[0]!);
        const reconciliationRows = client
          .prepare(
            `SELECT receipt_json AS "receiptJson"
             FROM "QingLong3PluginPackageTaskReconciliations"
             WHERE generation_digest = ? LIMIT 2`,
          )
          .all(plan.target.generationDigest) as Row[];
        if (reconciliationRows.length !== 1) {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        let taskReconciliation:
          Readonly<PluginPackageTaskReconciliationReceipt>;
        try {
          taskReconciliation =
            normalizePluginPackageTaskReconciliationReceipt(
              json(
                reconciliationRows[0]!,
                'receiptJson',
              ) as PluginPackageTaskReconciliationReceipt,
            );
        } catch {
          throw unavailable();
        }
        const planStep = plan.steps.find(
          (candidate) => candidate.stepRunId === stepRun.id,
        );
        if (!planStep) {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        const runtimeTaskId =
          `pkg:${plan.target.packageName}:${planStep.taskId}`;
        const item = taskReconciliation.items.find(
          ({ taskId }) => taskId === runtimeTaskId,
        );
        if (!item) {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        const taskRevision =
          `qltd:v1:${item.revision}:${item.contentDigest}`;
        const executionRows = client
          .prepare(
            `SELECT project_id AS "projectId", task_id AS "taskId",
                    task_revision AS "taskRevision",
                    command_json AS "commandJson",
                    working_directory AS "workingDirectory",
                    timeout_ms AS "timeoutMs", context_ref AS "contextRef",
                    content_digest AS "contentDigest",
                    created_at_ms AS "createdAtMs"
             FROM "QingLong3LocalTaskExecutionRevisions"
             WHERE project_id = ? AND task_id = ? AND task_revision = ?
             LIMIT 2`,
          )
          .all(plan.target.projectId, runtimeTaskId, taskRevision) as Row[];
        if (executionRows.length !== 1) {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        const execution = executionFromRow(executionRows[0]!);
        const clock = client
          .prepare(
            `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)
               AS "admittedAtMs"`,
          )
          .get() as Row | undefined;
        if (!clock) throw unavailable();
        const attemptNumberRow = client
          .prepare(
            `SELECT COALESCE(MAX(attempt), 0) + 1 AS "attemptNumber"
             FROM "RunAttempts" WHERE run_id = ?`,
          )
          .get(runId) as Row | undefined;
        if (!attemptNumberRow) throw unavailable();
        const bundle = createPluginPackageWorkflowTaskAttemptAdmission({
          plan,
          run,
          stepRun,
          taskReconciliation,
          execution,
          attemptNumber: integer(attemptNumberRow, 'attemptNumber'),
          admittedAtMs: integer(clock, 'admittedAtMs'),
        });
        const updated = client
          .prepare(
            `UPDATE "Runs"
             SET version = ?, event_sequence = ?
             WHERE id = ? AND status = 'running'
               AND cancel_requested_at_ms IS NULL
               AND version = ? AND event_sequence = ?`,
          )
          .run(
            bundle.run.version,
            bundle.run.eventSequence,
            run.id,
            run.version,
            run.eventSequence,
          );
        if (updated.changes !== 1) {
          throw new PluginPackageWorkflowTaskAttemptAdmissionConflictError();
        }
        const attempt = bundle.attempt;
        client
          .prepare(
            `INSERT INTO "RunAttempts" (
               id, run_id, step_run_id, attempt, status, executor_type,
               callback_sequence, created_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            attempt.id,
            attempt.runId,
            attempt.stepRunId ?? null,
            attempt.attempt,
            attempt.status,
            attempt.executorType,
            attempt.callbackSequence,
            attempt.createdAtMs,
          );
        const event = bundle.event;
        client
          .prepare(
            `INSERT INTO "RunEvents" (
               id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
               attempt_id, step_run_id, payload, created_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
          );
        const receipt = bundle.receipt;
        client
          .prepare(
            `INSERT INTO
               "QingLong3PluginPackageWorkflowTaskAttemptAdmissions" (
                 receipt_digest, attempt_id, plan_digest, run_id,
                 step_run_id, step_run_version, step_run_digest,
                 generation_digest, resource_task_id,
                 task_reconciliation_receipt_digest, project_id, task_id,
                 task_revision, task_definition_digest, executor_type,
                 execution_digest, attempt_number, event_id, run_version,
                 run_event_sequence, admitted_at_ms, receipt_json
               ) VALUES (
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?
               )`,
          )
          .run(
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
          );
        client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'created' as const,
          receipt,
        });
      } finally {
        if (began && this.#authority.client.isTransaction) {
          try {
            this.#authority.client.exec('ROLLBACK');
          } catch {
            // Preserve the original fail-closed error.
          }
        }
      }
    });
  }
}
