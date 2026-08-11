import type { DatabaseSync } from 'node:sqlite';

import {
  InvalidPluginPackageWorkflowFrontierError,
  MAX_PLUGIN_PACKAGE_WORKFLOW_FRONTIER_PAGE_SIZE,
  PluginPackageWorkflowFrontierConflictError,
  PluginPackageWorkflowFrontierUnavailableError,
  resolvePluginPackageWorkflowFrontier,
  type PluginPackageWorkflowFrontierAdvanceResult,
  type PluginPackageWorkflowFrontierCandidate,
  type PluginPackageWorkflowFrontierCursor,
  type PluginPackageWorkflowFrontierPage,
  type PluginPackageWorkflowFrontierRepository,
  type PluginPackageWorkflowTerminalStatus,
} from '@qinglong/runtime-core/plugin-package-workflow-frontier';
import {
  normalizePluginPackageWorkflowExecutionPlan,
  type PluginPackageWorkflowExecutionPlan,
} from '@qinglong/runtime-core/plugin-package-workflow-execution-plan';
import type { RunRecord } from '@qinglong/runtime-core';
import {
  normalizeStepRunRecord,
  type StepRunMutation,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';

import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';

type Row = Record<string, unknown>;

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TERMINAL_RUN_STATUSES = new Set<PluginPackageWorkflowTerminalStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

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

function unavailable(cause?: unknown): PluginPackageWorkflowFrontierUnavailableError {
  return new PluginPackageWorkflowFrontierUnavailableError({
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
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function optionalInteger(row: Row, key: string): number | undefined {
  if (row[key] === null || row[key] === undefined) return undefined;
  return integer(row, key);
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw new InvalidPluginPackageWorkflowFrontierError(
      `${label} is invalid`,
    );
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw unavailable();
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
    error instanceof InvalidPluginPackageWorkflowFrontierError ||
    error instanceof PluginPackageWorkflowFrontierConflictError ||
    error instanceof PluginPackageWorkflowFrontierUnavailableError
  ) {
    return error;
  }
  return sqliteConstraint(error)
    ? new PluginPackageWorkflowFrontierConflictError()
    : unavailable(error);
}

function pageLimit(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_PLUGIN_PACKAGE_WORKFLOW_FRONTIER_PAGE_SIZE
  ) {
    throw new InvalidPluginPackageWorkflowFrontierError(
      `page limit must be between 1 and ${MAX_PLUGIN_PACKAGE_WORKFLOW_FRONTIER_PAGE_SIZE}`,
    );
  }
  return value as number;
}

function cursor(
  value: Readonly<PluginPackageWorkflowFrontierCursor> | undefined,
): Readonly<PluginPackageWorkflowFrontierCursor> | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    !Reflect.has(value, 'admittedAtMs') ||
    !Reflect.has(value, 'planDigest') ||
    !Number.isSafeInteger(value.admittedAtMs) ||
    value.admittedAtMs < 0 ||
    !DIGEST.test(value.planDigest)
  ) {
    throw new InvalidPluginPackageWorkflowFrontierError(
      'frontier cursor is invalid',
    );
  }
  return Object.freeze({
    admittedAtMs: value.admittedAtMs,
    planDigest: value.planDigest,
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
      JSON.parse(text(row, 'stepRunJson')) as StepRunRecord,
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

function assertRunIdentity(
  run: Readonly<RunRecord>,
  plan: Readonly<PluginPackageWorkflowExecutionPlan>,
): void {
  if (
    run.id !== plan.runId ||
    run.projectId !== plan.target.projectId ||
    run.taskId !== plan.target.workflowId ||
    run.taskRevision !== plan.target.publicationDigest ||
    run.triggerType !== 'plugin_package_workflow' ||
    run.executionOrigin !== 'system' ||
    run.executionOwner !== 'runtime' ||
    run.requestId !== plan.planId ||
    run.idempotencyKey !== `plugin-package-workflow:${plan.planId}` ||
    run.version !== run.eventSequence
  ) {
    throw unavailable();
  }
}

function updateStepRun(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const stepRun = mutation.stepRun;
  const updated = client
    .prepare(
      `UPDATE "StepRuns"
       SET status = ?, version = ?, attempt_count = ?, output_ref = ?,
           approval_request_id = ?, ready_at_ms = ?, started_at_ms = ?,
           finished_at_ms = ?, result_code = ?, error_summary = ?,
           updated_at_ms = ?, last_mutation_id = ?, step_run_digest = ?,
           step_run_json = ?
       WHERE id = ? AND run_id = ? AND version = ?
         AND step_run_digest = ? AND status = ?`,
    )
    .run(
      stepRun.status,
      stepRun.version,
      stepRun.attemptCount,
      stepRun.outputRef,
      stepRun.approvalRequestId,
      stepRun.readyAtMs,
      stepRun.startedAtMs,
      stepRun.finishedAtMs,
      stepRun.resultCode,
      stepRun.errorSummary,
      stepRun.updatedAtMs,
      stepRun.lastMutationId,
      stepRun.stepRunDigest,
      JSON.stringify(stepRun),
      stepRun.id,
      stepRun.runId,
      mutation.expectedStepRunVersion,
      mutation.expectedStepRunDigest,
      mutation.previousStatus,
    );
  if (updated.changes !== 1) {
    throw new PluginPackageWorkflowFrontierConflictError();
  }
}

function insertStepMutation(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
  committedAtMs: number,
): void {
  const event = mutation.event;
  client
    .prepare(
      `INSERT INTO "RunEvents" (
         id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
         attempt_id, step_run_id, payload, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.runId,
      event.sequence,
      event.type,
      event.dedupeKey ?? null,
      event.actorType,
      event.actorId ?? null,
      mutation.stepRun.id,
      JSON.stringify(event.payload),
      event.createdAtMs,
    );
  client
    .prepare(
      `INSERT INTO "StepRunMutations" (
         mutation_id, mutation_digest, run_id, step_run_id,
         step_run_digest, event_id, event_sequence, run_version,
         step_run_json, committed_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      mutation.mutationId,
      mutation.mutationDigest,
      mutation.runId,
      mutation.stepRun.id,
      mutation.stepRun.stepRunDigest,
      event.id,
      event.sequence,
      mutation.expectedRunVersion + 1,
      JSON.stringify(mutation.stepRun),
      committedAtMs,
    );
}

export class LocalSqlitePluginPackageWorkflowFrontierRepository
  implements PluginPackageWorkflowFrontierRepository
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
    after?: Readonly<PluginPackageWorkflowFrontierCursor>;
  }>): Promise<Readonly<PluginPackageWorkflowFrontierPage>> {
    if (
      !queryValue ||
      typeof queryValue !== 'object' ||
      Array.isArray(queryValue) ||
      !Reflect.has(queryValue, 'limit') ||
      Reflect.ownKeys(queryValue).some(
        (key) => key !== 'limit' && key !== 'after',
      )
    ) {
      throw new InvalidPluginPackageWorkflowFrontierError(
        'page query is invalid',
      );
    }
    const limit = pageLimit(queryValue.limit);
    const after = cursor(queryValue.after);
    return this.#enqueue(() => {
      const rows = this.#authority.client
        .prepare(
          `SELECT admission.run_id AS "runId",
                  admission.plan_digest AS "planDigest",
                  admission.admitted_at_ms AS "admittedAtMs"
           FROM "QingLong3PluginPackageWorkflowAdmissions" AS admission
           JOIN "Runs" AS run ON run.id = admission.run_id
           WHERE run.status = 'running'
             AND run.cancel_requested_at_ms IS NULL
             AND (
               EXISTS (
                 SELECT 1
                 FROM "QingLong3PluginPackageWorkflowAdmissionSteps" AS step
                 JOIN "StepRuns" AS current
                   ON current.run_id = step.run_id
                  AND current.id = step.step_run_id
                 WHERE step.plan_digest = admission.plan_digest
                   AND current.status = 'pending'
                   AND (
                     NOT EXISTS (
                       SELECT 1
                       FROM json_each(step.needs_json) AS need
                       LEFT JOIN "QingLong3PluginPackageWorkflowAdmissionSteps"
                         AS dependency_step
                         ON dependency_step.plan_digest = step.plan_digest
                        AND dependency_step.step_key = need.value
                       LEFT JOIN "StepRuns" AS dependency
                         ON dependency.run_id = dependency_step.run_id
                        AND dependency.id = dependency_step.step_run_id
                       WHERE dependency.id IS NULL
                          OR dependency.status <> 'succeeded'
                     )
                     OR EXISTS (
                       SELECT 1
                       FROM json_each(step.needs_json) AS need
                       JOIN "QingLong3PluginPackageWorkflowAdmissionSteps"
                         AS dependency_step
                         ON dependency_step.plan_digest = step.plan_digest
                        AND dependency_step.step_key = need.value
                       JOIN "StepRuns" AS dependency
                         ON dependency.run_id = dependency_step.run_id
                        AND dependency.id = dependency_step.step_run_id
                       WHERE dependency.status IN (
                         'failed', 'skipped', 'cancelled', 'timed_out'
                       )
                     )
                   )
               )
               OR NOT EXISTS (
                 SELECT 1
                 FROM "QingLong3PluginPackageWorkflowAdmissionSteps" AS step
                 JOIN "StepRuns" AS current
                   ON current.run_id = step.run_id
                  AND current.id = step.step_run_id
                 WHERE step.plan_digest = admission.plan_digest
                   AND current.status NOT IN (
                     'succeeded', 'failed', 'skipped', 'cancelled', 'timed_out'
                   )
               )
             )
             AND (
               ? IS NULL OR admission.admitted_at_ms > ? OR
               (admission.admitted_at_ms = ? AND admission.plan_digest > ?)
             )
           ORDER BY admission.admitted_at_ms, admission.plan_digest
           LIMIT ?`,
        )
        .all(
          after?.planDigest ?? null,
          after?.admittedAtMs ?? 0,
          after?.admittedAtMs ?? 0,
          after?.planDigest ?? '',
          limit + 1,
        ) as Row[];
      const mapped = rows.map(
        (row): Readonly<PluginPackageWorkflowFrontierCandidate> =>
          Object.freeze({
            runId: identity(text(row, 'runId'), 'candidate runId'),
            planDigest: digest(row.planDigest),
            admittedAtMs: integer(row, 'admittedAtMs'),
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
                admittedAtMs: last.admittedAtMs,
                planDigest: last.planDigest,
              }),
            }
          : {}),
      });
    });
  }

  advance(
    runIdValue: string,
  ): Promise<Readonly<PluginPackageWorkflowFrontierAdvanceResult>> {
    const runId = identity(runIdValue, 'runId');
    return this.#enqueue(() => {
      let began = false;
      try {
        const client = this.#authority.client;
        client.exec('BEGIN IMMEDIATE');
        began = true;
        const admission = client
          .prepare(
            `SELECT plan_digest AS "planDigest", plan_json AS "planJson"
             FROM "QingLong3PluginPackageWorkflowAdmissions"
             WHERE run_id = ? LIMIT 2`,
          )
          .all(runId) as Row[];
        if (admission.length !== 1) {
          throw new PluginPackageWorkflowFrontierConflictError();
        }
        let plan: Readonly<PluginPackageWorkflowExecutionPlan>;
        try {
          plan = normalizePluginPackageWorkflowExecutionPlan(
            JSON.parse(
              text(admission[0]!, 'planJson'),
            ) as PluginPackageWorkflowExecutionPlan,
          );
        } catch {
          throw unavailable();
        }
        if (plan.planDigest !== digest(admission[0]!.planDigest)) {
          throw unavailable();
        }
        const runRows = client
          .prepare(`SELECT ${RUN_SELECT} FROM "Runs" WHERE id = ? LIMIT 2`)
          .all(runId) as Row[];
        if (runRows.length !== 1) {
          throw new PluginPackageWorkflowFrontierConflictError();
        }
        const run = runFromRow(runRows[0]!);
        assertRunIdentity(run, plan);
        const stepRows = client
          .prepare(
            `SELECT ${STEP_RUN_SELECT}
             FROM "StepRuns" WHERE run_id = ?
             ORDER BY step_key, id`,
          )
          .all(runId) as Row[];
        const stepRuns = stepRows.map(stepRunFromRow);
        const clock = client
          .prepare(
            `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)
               AS "observedAtMs"`,
          )
          .get() as Row | undefined;
        if (!clock) throw unavailable();
        const observedAtMs = integer(clock, 'observedAtMs');
        const currentStatus = run.status;
        const resolution = resolvePluginPackageWorkflowFrontier({
          plan,
          run: {
            ...run,
            ...(TERMINAL_RUN_STATUSES.has(
              currentStatus as PluginPackageWorkflowTerminalStatus,
            )
              ? { status: 'running' as const }
              : {}),
          },
          stepRuns,
          observedAtMs,
        });
        if (
          TERMINAL_RUN_STATUSES.has(
            currentStatus as PluginPackageWorkflowTerminalStatus,
          )
        ) {
          if (
            resolution.stepMutations.length !== 0 ||
            resolution.terminalStatus !== currentStatus
          ) {
            throw unavailable();
          }
          client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'settled' as const,
            runId,
            planDigest: plan.planDigest,
            stepMutationCount: 0,
            readyStepRunIds: Object.freeze([]),
            terminalStatus:
              currentStatus as PluginPackageWorkflowTerminalStatus,
            runVersion: run.version,
            runEventSequence: run.eventSequence,
            observedAtMs,
          });
        }
        if (currentStatus !== 'running') throw unavailable();
        const increment =
          resolution.stepMutations.length +
          (resolution.terminalTransition === null ? 0 : 1);
        if (increment === 0) {
          client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'unchanged' as const,
            runId,
            planDigest: plan.planDigest,
            stepMutationCount: 0,
            readyStepRunIds: resolution.readyStepRunIds,
            terminalStatus: null,
            runVersion: run.version,
            runEventSequence: run.eventSequence,
            observedAtMs,
          });
        }
        for (const mutation of resolution.stepMutations) {
          updateStepRun(client, mutation);
        }
        const terminal = resolution.terminalTransition;
        const updatedRun = client
          .prepare(
            `UPDATE "Runs"
             SET status = ?, version = version + ?,
                 event_sequence = event_sequence + ?,
                 finished_at_ms = ?, error_code = ?, error_summary = NULL
             WHERE id = ? AND status = 'running'
               AND version = ? AND event_sequence = ?`,
          )
          .run(
            terminal?.status ?? 'running',
            increment,
            increment,
            terminal?.finishedAtMs ?? null,
            terminal?.errorCode ?? null,
            runId,
            run.version,
            run.eventSequence,
          );
        if (updatedRun.changes !== 1) {
          throw new PluginPackageWorkflowFrontierConflictError();
        }
        for (const mutation of resolution.stepMutations) {
          insertStepMutation(client, mutation, observedAtMs);
        }
        if (terminal) {
          const event = terminal.event;
          client
            .prepare(
              `INSERT INTO "RunEvents" (
                 id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
                 attempt_id, step_run_id, payload, created_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
            )
            .run(
              event.id,
              event.runId,
              event.sequence,
              event.type,
              event.dedupeKey ?? null,
              event.actorType,
              event.actorId ?? null,
              JSON.stringify(event.payload),
              event.createdAtMs,
            );
        }
        client.exec('COMMIT');
        began = false;
        const runVersion = run.version + increment;
        return Object.freeze({
          status: terminal ? ('terminal' as const) : ('advanced' as const),
          runId,
          planDigest: plan.planDigest,
          stepMutationCount: resolution.stepMutations.length,
          readyStepRunIds: terminal
            ? Object.freeze([])
            : resolution.readyStepRunIds,
          terminalStatus: terminal?.status ?? null,
          runVersion,
          runEventSequence: run.eventSequence + increment,
          observedAtMs,
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
