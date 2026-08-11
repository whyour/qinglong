import type { DatabaseSync } from 'node:sqlite';

import type {
  RunAttemptRecord,
  RunEventRecord,
  RunRecord,
} from '@qinglong/runtime-core';
import {
  ClusterRunCancellationConvergenceUnavailableError,
  normalizeClusterRunCancellationConvergencePageCommand,
  normalizeClusterRunCancellationConvergencePageResult,
  type ClusterRunCancellationConvergencePageCommand,
  type ClusterRunCancellationConvergencePageResult,
  type ClusterRunCancellationConvergenceRepository,
} from '@qinglong/runtime-core/cluster-run-cancellation-convergence';
import {
  resolvePluginPackageWorkflowCancellation,
  type PluginPackageWorkflowCancellationActiveAttempt,
} from '@qinglong/runtime-core/plugin-package-workflow-cancellation-convergence';
import type {
  PluginPackageWorkflowTaskAttemptAdmissionReceipt,
} from '@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission';
import {
  normalizeStepRunRecord,
  type StepRunMutation,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';

import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';

type Row = Record<string, unknown>;

function unavailable(
  cause?: unknown,
): ClusterRunCancellationConvergenceUnavailableError {
  return new ClusterRunCancellationConvergenceUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) throw unavailable();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unavailable();
  }
  return value as number;
}

function optionalInteger(row: Row, key: string): number | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : integer(row, key);
}

function json(row: Row, key: string): Readonly<Record<string, unknown>> {
  try {
    const value = JSON.parse(text(row, key)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw unavailable();
    }
    return Object.freeze({ ...(value as Record<string, unknown>) });
  } catch (error) {
    if (error instanceof ClusterRunCancellationConvergenceUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

function runFromRow(row: Row): Readonly<RunRecord> {
  return Object.freeze({
    id: text(row, 'id'),
    projectId: text(row, 'projectId'),
    taskId: text(row, 'taskId'),
    taskRevision: text(row, 'taskRevision'),
    triggerType: text(row, 'triggerType'),
    executionOrigin: text(
      row,
      'executionOrigin',
    ) as RunRecord['executionOrigin'],
    executionOwner: text(
      row,
      'executionOwner',
    ) as RunRecord['executionOwner'],
    requestId: text(row, 'requestId'),
    status: text(row, 'status') as RunRecord['status'],
    version: integer(row, 'version'),
    eventSequence: integer(row, 'eventSequence'),
    priority: integer(row, 'priority'),
    idempotencyKey: text(row, 'idempotencyKey'),
    createdAtMs: integer(row, 'createdAtMs'),
    ...(optionalInteger(row, 'startedAtMs') === undefined
      ? {}
      : { startedAtMs: optionalInteger(row, 'startedAtMs')! }),
    cancelRequestedAtMs: integer(row, 'cancelRequestedAtMs'),
    cancelReason: text(
      row,
      'cancelReason',
    ) as NonNullable<RunRecord['cancelReason']>,
  });
}

function attemptFromRow(row: Row): Readonly<RunAttemptRecord> {
  return Object.freeze({
    id: text(row, 'attemptId'),
    runId: text(row, 'attemptRunId'),
    stepRunId: text(row, 'attemptStepRunId'),
    attempt: integer(row, 'attemptNumber'),
    status: text(row, 'attemptStatus') as RunAttemptRecord['status'],
    executorType: text(row, 'executorType'),
    callbackSequence: integer(row, 'callbackSequence'),
    createdAtMs: integer(row, 'attemptCreatedAtMs'),
    ...(optionalInteger(row, 'attemptStartedAtMs') === undefined
      ? {}
      : {
          startedAtMs: optionalInteger(row, 'attemptStartedAtMs')!,
        }),
  });
}

function insertEvent(client: DatabaseSync, event: Readonly<RunEventRecord>): void {
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
  if (updated.changes !== 1) throw unavailable();
}

function insertStepMutation(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
  committedAtMs: number,
): void {
  insertEvent(client, mutation.event);
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
      mutation.event.id,
      mutation.event.sequence,
      mutation.expectedRunVersion + 1,
      JSON.stringify(mutation.stepRun),
      committedAtMs,
    );
}

/**
 * Edge/standalone adapter for the shared Workflow cancellation state machine.
 * It uses the existing single SQLite operation authority and one
 * `BEGIN IMMEDIATE` transaction per Workflow, so page size does not lengthen a
 * single write lock on low-memory router-class devices.
 */
export class LocalSqlitePluginPackageWorkflowCancellationConvergenceRepository
  implements ClusterRunCancellationConvergenceRepository
{
  readonly #authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.#authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  convergePage(
    value: Readonly<ClusterRunCancellationConvergencePageCommand>,
  ): Promise<Readonly<ClusterRunCancellationConvergencePageResult>> {
    const command =
      normalizeClusterRunCancellationConvergencePageCommand(value);
    return this.#authority.enqueue(
      async () => {
        try {
          const client = this.#authority.client;
          const candidates = client
            .prepare(
              `SELECT id AS "runId"
               FROM "Runs"
               WHERE execution_owner = 'runtime'
                 AND trigger_type = 'plugin_package_workflow'
                 AND status = 'running'
                 AND cancel_requested_at_ms IS NOT NULL
               ORDER BY cancel_requested_at_ms, id
               LIMIT ?`,
            )
            .all(command.limit) as Row[];
          let settledRuns = 0;
          let settledAttempts = 0;
          let blocked = 0;
          for (const candidate of candidates) {
            const result = this.#convergeOne(text(candidate, 'runId'));
            settledRuns += result.settledRuns;
            settledAttempts += result.settledAttempts;
            blocked += result.blocked;
          }
          const continuation = client
            .prepare(
              `SELECT EXISTS (
                 SELECT 1 FROM "Runs"
                 WHERE execution_owner = 'runtime'
                   AND trigger_type = 'plugin_package_workflow'
                   AND status = 'running'
                   AND cancel_requested_at_ms IS NOT NULL
                 LIMIT 1
               ) AS "hasMore"`,
            )
            .get() as Row | undefined;
          if (!continuation) throw unavailable();
          return normalizeClusterRunCancellationConvergencePageResult({
            scanned: candidates.length,
            settledRuns,
            settledAttempts,
            blocked,
            hasMore: integer(continuation, 'hasMore') === 1,
          }, command.limit);
        } catch (error) {
          if (
            error instanceof
              ClusterRunCancellationConvergenceUnavailableError
          ) {
            throw error;
          }
          throw unavailable(error);
        }
      },
      () => unavailable(),
    );
  }

  #convergeOne(runId: string): Readonly<{
    settledRuns: number;
    settledAttempts: number;
    blocked: number;
  }> {
    const client = this.#authority.client;
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
      const runRows = client
        .prepare(
          `SELECT id, project_id AS "projectId", task_id AS "taskId",
                  task_revision AS "taskRevision",
                  trigger_type AS "triggerType",
                  execution_origin AS "executionOrigin",
                  execution_owner AS "executionOwner",
                  request_id AS "requestId", status, version,
                  event_sequence AS "eventSequence", priority,
                  idempotency_key AS "idempotencyKey",
                  created_at_ms AS "createdAtMs",
                  started_at_ms AS "startedAtMs",
                  cancel_requested_at_ms AS "cancelRequestedAtMs",
                  cancel_reason AS "cancelReason"
           FROM "Runs"
           WHERE id = ? AND execution_owner = 'runtime'
             AND trigger_type = 'plugin_package_workflow'
             AND status = 'running'
             AND cancel_requested_at_ms IS NOT NULL
           LIMIT 2`,
        )
        .all(runId) as Row[];
      if (runRows.length === 0) {
        client.exec('COMMIT');
        began = false;
        return Object.freeze({
          settledRuns: 0,
          settledAttempts: 0,
          blocked: 0,
        });
      }
      if (runRows.length !== 1) throw unavailable();
      const run = runFromRow(runRows[0]!);
      const stepRuns = (
        client
          .prepare(
            `SELECT step_run_json AS "stepRunJson"
             FROM "StepRuns"
             WHERE run_id = ?
             ORDER BY step_key, id`,
          )
          .all(runId) as Row[]
      ).map((row) => {
        try {
          return normalizeStepRunRecord(
            json(row, 'stepRunJson') as unknown as StepRunRecord,
          );
        } catch {
          throw unavailable();
        }
      });
      const activeRows = client
        .prepare(
          `SELECT admission.receipt_json AS "admissionJson",
                  attempt.id AS "attemptId",
                  attempt.run_id AS "attemptRunId",
                  attempt.step_run_id AS "attemptStepRunId",
                  attempt.attempt AS "attemptNumber",
                  attempt.status AS "attemptStatus",
                  attempt.executor_type AS "executorType",
                  attempt.callback_sequence AS "callbackSequence",
                  attempt.created_at_ms AS "attemptCreatedAtMs",
                  attempt.started_at_ms AS "attemptStartedAtMs"
           FROM
             "QingLong3PluginPackageWorkflowTaskAttemptAdmissions"
               AS admission
           JOIN "RunAttempts" AS attempt
             ON attempt.id = admission.attempt_id
            AND attempt.run_id = admission.run_id
           WHERE admission.run_id = ?
             AND attempt.status IN ('claimed', 'starting', 'running')
           ORDER BY attempt.id`,
        )
        .all(runId) as Row[];
      const activeTaskAttempts =
        activeRows.map(
          (row): Readonly<
            PluginPackageWorkflowCancellationActiveAttempt
          > =>
            Object.freeze({
              admission:
                json(row, 'admissionJson') as unknown as
                  Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>,
              attempt: attemptFromRow(row),
              leaseStatus: null,
            }),
        );
      const clock = client
        .prepare(
          `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)
             AS "observedAtMs"`,
        )
        .get() as Row | undefined;
      if (!clock) throw unavailable();
      const resolution = resolvePluginPackageWorkflowCancellation({
        run,
        stepRuns,
        activeTaskAttempts,
        observedAtMs: integer(clock, 'observedAtMs'),
      });
      for (const transition of resolution.attemptTransitions) {
        const updated = client
          .prepare(
            `UPDATE "RunAttempts"
             SET status = ?, finished_at_ms = ?,
                 error_code = ?, error_summary = ?
             WHERE id = ? AND run_id = ?
               AND status = ? AND callback_sequence = ?`,
          )
          .run(
            transition.attempt.status,
            transition.attempt.finishedAtMs ?? null,
            transition.attempt.errorCode ?? null,
            transition.attempt.errorSummary ?? null,
            transition.attempt.id,
            transition.attempt.runId,
            transition.previousStatus,
            transition.attempt.callbackSequence,
          );
        if (updated.changes !== 1) throw unavailable();
        insertEvent(client, transition.event);
      }
      for (const mutation of resolution.stepMutations) {
        updateStepRun(client, mutation);
        insertStepMutation(client, mutation, resolution.observedAtMs);
      }
      if (resolution.terminalTransition) {
        insertEvent(client, resolution.terminalTransition.event);
      }
      if (
        resolution.run.version !== run.version ||
        resolution.run.eventSequence !== run.eventSequence ||
        resolution.run.status !== run.status
      ) {
        const updated = client
          .prepare(
            `UPDATE "Runs"
             SET status = ?, finished_at_ms = ?,
                 error_code = ?, error_summary = ?,
                 version = ?, event_sequence = ?
             WHERE id = ? AND status = 'running'
               AND execution_owner = 'runtime'
               AND trigger_type = 'plugin_package_workflow'
               AND cancel_requested_at_ms = ? AND cancel_reason = ?
               AND version = ? AND event_sequence = ?`,
          )
          .run(
            resolution.run.status,
            resolution.run.finishedAtMs ?? null,
            resolution.run.errorCode ?? null,
            resolution.run.errorSummary ?? null,
            resolution.run.version,
            resolution.run.eventSequence,
            run.id,
            run.cancelRequestedAtMs!,
            run.cancelReason!,
            run.version,
            run.eventSequence,
          );
        if (updated.changes !== 1) throw unavailable();
      }
      client.exec('COMMIT');
      began = false;
      return Object.freeze({
        settledRuns: resolution.terminalTransition === null ? 0 : 1,
        settledAttempts: resolution.attemptTransitions.length,
        blocked: resolution.blockedStepRunIds.length === 0 ? 0 : 1,
      });
    } finally {
      if (began && client.isTransaction) {
        try {
          client.exec('ROLLBACK');
        } catch {
          // Preserve the fail-closed convergence error.
        }
      }
    }
  }
}
