import type { DatabaseSync } from 'node:sqlite';

import {
  InvalidToolExecutionFailureCompletionError,
  MAX_TOOL_EXECUTION_FAILURE_COMPLETION_JSON_BYTES,
  ToolExecutionFailureCompletionConflictError,
  ToolExecutionFailureCompletionUnavailableError,
  normalizeToolExecutionFailureCompletionCommand,
  normalizeToolExecutionFailureCompletionRecord,
  toolExecutionFailureCompletionRecord,
  type CommitToolExecutionFailureCompletionResult,
  type ToolExecutionFailureCompletionCommand,
  type ToolExecutionFailureCompletionRecord,
  type ToolExecutionFailureCompletionRepository,
} from '@qinglong/runtime-core/tool-execution-failure-completion';
import type { StepRunMutation } from '@qinglong/runtime-core/step-run';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
const COMPLETION_SELECT = `
  completion.completion_json AS "completionJson",
  completion.start_id AS "storedStartId",
  completion.project_id AS "storedProjectId",
  completion.run_id AS "storedRunId",
  completion.step_run_id AS "storedStepRunId",
  completion.started_step_run_version AS "storedStartedStepRunVersion",
  completion.completed_step_run_version AS "storedCompletedStepRunVersion",
  completion.barrier_digest AS "storedBarrierDigest",
  completion.adapter_digest AS "storedAdapterDigest",
  completion.outcome AS "storedOutcome",
  completion.result_code AS "storedResultCode",
  completion.error_summary AS "storedErrorSummary",
  completion.step_run_mutation_id AS "storedMutationId",
  completion.step_run_mutation_digest AS "storedMutationDigest",
  completion.completed_step_run_digest AS "storedCompletedStepRunDigest",
  completion.run_event_id AS "storedRunEventId",
  completion.completed_at_ms AS "storedCompletedAtMs",
  completion.completion_digest AS "storedCompletionDigest",
  barrier.barrier_digest AS "joinedBarrierDigest",
  mutation.mutation_digest AS "joinedMutationDigest",
  mutation.step_run_digest AS "joinedCompletedStepRunDigest",
  event.id AS "joinedRunEventId"
`;

function unavailable(
  cause?: unknown,
): ToolExecutionFailureCompletionUnavailableError {
  return new ToolExecutionFailureCompletionUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function requiredText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function requiredInteger(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unavailable();
  }
  return value as number;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new InvalidToolExecutionFailureCompletionError(`${label} is invalid`);
  }
  return value;
}

function sqliteConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const number = (error as { errcode?: unknown }).errcode;
  return (
    (typeof code === 'string' && code.startsWith('ERR_SQLITE_CONSTRAINT')) ||
    (typeof number === 'number' && (number & 0xff) === 19)
  );
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidToolExecutionFailureCompletionError ||
    error instanceof ToolExecutionFailureCompletionConflictError ||
    error instanceof ToolExecutionFailureCompletionUnavailableError
  ) {
    return error;
  }
  return sqliteConstraint(error)
    ? new ToolExecutionFailureCompletionConflictError()
    : unavailable(error);
}

function valuesFromRow(
  row: Row,
): Readonly<ToolExecutionFailureCompletionRecord> {
  const json = requiredText(row, 'completionJson');
  if (
    Buffer.byteLength(json, 'utf8') >
    MAX_TOOL_EXECUTION_FAILURE_COMPLETION_JSON_BYTES
  ) {
    throw unavailable();
  }
  let completion: Readonly<ToolExecutionFailureCompletionRecord>;
  try {
    completion = normalizeToolExecutionFailureCompletionRecord(
      JSON.parse(json) as ToolExecutionFailureCompletionRecord,
    );
  } catch {
    throw unavailable();
  }
  if (
    completion.startId !== requiredText(row, 'storedStartId') ||
    completion.projectId !== requiredText(row, 'storedProjectId') ||
    completion.runId !== requiredText(row, 'storedRunId') ||
    completion.stepRunId !== requiredText(row, 'storedStepRunId') ||
    completion.startedStepRunVersion !==
      requiredInteger(row, 'storedStartedStepRunVersion') ||
    completion.completedStepRunVersion !==
      requiredInteger(row, 'storedCompletedStepRunVersion') ||
    completion.barrierDigest !== requiredText(row, 'storedBarrierDigest') ||
    completion.adapterDigest !== requiredText(row, 'storedAdapterDigest') ||
    completion.outcome !== requiredText(row, 'storedOutcome') ||
    completion.resultCode !== requiredText(row, 'storedResultCode') ||
    completion.errorSummary !== requiredText(row, 'storedErrorSummary') ||
    completion.stepRunMutationId !== requiredText(row, 'storedMutationId') ||
    completion.stepRunMutationDigest !==
      requiredText(row, 'storedMutationDigest') ||
    completion.completedStepRunDigest !==
      requiredText(row, 'storedCompletedStepRunDigest') ||
    completion.runEventId !== requiredText(row, 'storedRunEventId') ||
    completion.completedAtMs !== requiredInteger(row, 'storedCompletedAtMs') ||
    completion.completionDigest !==
      requiredText(row, 'storedCompletionDigest') ||
    completion.barrierDigest !== requiredText(row, 'joinedBarrierDigest') ||
    completion.stepRunMutationDigest !==
      requiredText(row, 'joinedMutationDigest') ||
    completion.completedStepRunDigest !==
      requiredText(row, 'joinedCompletedStepRunDigest') ||
    completion.runEventId !== requiredText(row, 'joinedRunEventId') ||
    JSON.stringify(completion) !== json
  ) {
    throw unavailable();
  }
  return completion;
}

function updateStepRun(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const step = mutation.stepRun;
  const result = client
    .prepare(
      `UPDATE "StepRuns"
       SET "status" = ?, "version" = ?, "attempt_count" = ?,
           "output_ref" = ?, "approval_request_id" = ?, "ready_at_ms" = ?,
           "started_at_ms" = ?, "finished_at_ms" = ?, "result_code" = ?,
           "error_summary" = ?, "updated_at_ms" = ?,
           "last_mutation_id" = ?, "step_run_digest" = ?,
           "step_run_json" = ?
       WHERE "id" = ? AND "run_id" = ? AND "version" = ?
         AND "step_run_digest" = ? AND "status" = ?`,
    )
    .run(
      step.status,
      step.version,
      step.attemptCount,
      step.outputRef,
      step.approvalRequestId,
      step.readyAtMs,
      step.startedAtMs,
      step.finishedAtMs,
      step.resultCode,
      step.errorSummary,
      step.updatedAtMs,
      step.lastMutationId,
      step.stepRunDigest,
      JSON.stringify(step),
      step.id,
      step.runId,
      mutation.expectedStepRunVersion,
      mutation.expectedStepRunDigest,
      mutation.previousStatus,
    );
  if (result.changes !== 1) {
    throw new ToolExecutionFailureCompletionConflictError();
  }
}

function updateRun(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const result = client
    .prepare(
      `UPDATE "Runs"
       SET "version" = "version" + 1,
           "event_sequence" = "event_sequence" + 1
       WHERE "id" = ? AND "version" = ? AND "event_sequence" = ?`,
    )
    .run(
      mutation.runId,
      mutation.expectedRunVersion,
      mutation.expectedRunEventSequence,
    );
  if (result.changes !== 1) {
    throw new ToolExecutionFailureCompletionConflictError();
  }
}

function insertRunEvent(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const event = mutation.event;
  client
    .prepare(
      `INSERT INTO "RunEvents" (
         "id", "run_id", "sequence", "type", "dedupe_key", "actor_type",
         "actor_id", "attempt_id", "step_run_id", "payload", "created_at_ms"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.runId,
      event.sequence,
      event.type,
      event.dedupeKey!,
      event.actorType,
      event.actorId ?? null,
      mutation.stepRun.id,
      JSON.stringify(event.payload),
      event.createdAtMs,
    );
}

function insertMutation(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  client
    .prepare(
      `INSERT INTO "StepRunMutations" (
         "mutation_id", "mutation_digest", "run_id", "step_run_id",
         "step_run_digest", "event_id", "event_sequence",
         "run_version", "step_run_json", "committed_at_ms"
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?,
         CAST(unixepoch('subsec') * 1000 AS INTEGER)
       )`,
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
    );
}

function insertCompletion(
  client: DatabaseSync,
  completion: Readonly<ToolExecutionFailureCompletionRecord>,
): void {
  client
    .prepare(
      `INSERT INTO "ToolExecutionFailureCompletions" (
         start_id, project_id, run_id, step_run_id,
         started_step_run_version, completed_step_run_version,
         barrier_digest, adapter_digest, outcome, result_code,
         error_summary, step_run_mutation_id, step_run_mutation_digest,
         completed_step_run_digest, run_event_id, completed_at_ms,
         completion_digest, completion_json
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    )
    .run(
      completion.startId,
      completion.projectId,
      completion.runId,
      completion.stepRunId,
      completion.startedStepRunVersion,
      completion.completedStepRunVersion,
      completion.barrierDigest,
      completion.adapterDigest,
      completion.outcome,
      completion.resultCode,
      completion.errorSummary,
      completion.stepRunMutationId,
      completion.stepRunMutationDigest,
      completion.completedStepRunDigest,
      completion.runEventId,
      completion.completedAtMs,
      completion.completionDigest,
      JSON.stringify(completion),
    );
}

export class LocalSqliteToolExecutionFailureCompletionRepository
  implements ToolExecutionFailureCompletionRepository
{
  private readonly authority: LocalSqliteOperationAuthority;
  private readonly client: DatabaseSync;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.client = this.authority.client;
  }

  private enqueue<T>(work: () => T): Promise<T> {
    return this.authority.enqueue(async () => {
      try {
        return work();
      } catch (error) {
        throw mapStorageError(error);
      }
    }, unavailable);
  }

  private findRows(
    where: string,
    values: readonly (string | number)[],
  ): readonly Row[] {
    return this.client
      .prepare(
        `SELECT ${COMPLETION_SELECT}
         FROM "ToolExecutionFailureCompletions" AS completion
         JOIN "ToolExecutionStartBarriers" AS barrier
           ON barrier.start_id = completion.start_id
         JOIN "StepRunMutations" AS mutation
           ON mutation.mutation_id = completion.step_run_mutation_id
         JOIN "RunEvents" AS event
           ON event.id = completion.run_event_id
         WHERE ${where}
         LIMIT 2`,
      )
      .all(...values) as Row[];
  }

  findByStartId(
    startIdValue: string,
  ): Promise<Readonly<ToolExecutionFailureCompletionRecord> | null> {
    const startId = identity(startIdValue, 'start id');
    return this.enqueue(() => {
      const rows = this.findRows('completion.start_id = ?', [startId]);
      if (rows.length > 1) throw unavailable();
      return rows[0] ? valuesFromRow(rows[0]) : null;
    });
  }

  commit(
    commandValue: ToolExecutionFailureCompletionCommand,
  ): Promise<Readonly<CommitToolExecutionFailureCompletionResult>> {
    const command =
      normalizeToolExecutionFailureCompletionCommand(commandValue);
    const completion = toolExecutionFailureCompletionRecord(command);
    return this.enqueue(() => {
      let began = false;
      try {
        this.client.exec('BEGIN IMMEDIATE');
        began = true;
        const existing = this.findRows(
          `completion.start_id = ?
           OR completion.step_run_mutation_id = ?
           OR completion.run_event_id = ?
           OR (
             completion.run_id = ? AND completion.step_run_id = ?
             AND completion.completed_step_run_version = ?
           )`,
          [
            completion.startId,
            completion.stepRunMutationId,
            completion.runEventId,
            completion.runId,
            completion.stepRunId,
            completion.completedStepRunVersion,
          ],
        );
        if (existing.length > 1) {
          throw new ToolExecutionFailureCompletionConflictError();
        }
        if (existing[0]) {
          const stored = valuesFromRow(existing[0]);
          if (JSON.stringify(stored) !== JSON.stringify(completion)) {
            throw new ToolExecutionFailureCompletionConflictError();
          }
          this.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing' as const,
            completion: stored,
          });
        }

        const successConflict = this.client
          .prepare(
            `SELECT 1
             FROM "ToolExecutionCompletions"
             WHERE start_id = ? OR step_run_mutation_id = ?
               OR run_event_id = ?
               OR (
                 run_id = ? AND step_run_id = ?
                 AND completed_step_run_version = ?
               )
             LIMIT 1`,
          )
          .get(
            completion.startId,
            completion.stepRunMutationId,
            completion.runEventId,
            completion.runId,
            completion.stepRunId,
            completion.completedStepRunVersion,
          );
        if (successConflict) {
          throw new ToolExecutionFailureCompletionConflictError();
        }

        const mutation = command.stepRunMutation;
        const current = this.client
          .prepare(
            `SELECT
               barrier.barrier_json AS "barrierJson",
               start_mutation.run_version AS "startedRunVersion",
               start_mutation.event_sequence AS "startedEventSequence",
               step.kind AS "stepKind", step.status AS "stepStatus",
               step.version AS "stepVersion",
               step.step_run_digest AS "stepDigest",
               run.project_id AS "projectId", run.status AS "runStatus",
               run.version AS "runVersion",
               run.event_sequence AS "runEventSequence"
             FROM "ToolExecutionStartBarriers" AS barrier
             JOIN "StepRunMutations" AS start_mutation
               ON start_mutation.mutation_id = barrier.step_run_mutation_id
             JOIN "StepRuns" AS step
               ON step.id = barrier.step_run_id
              AND step.run_id = barrier.run_id
             JOIN "Runs" AS run ON run.id = barrier.run_id
             WHERE barrier.start_id = ?
             LIMIT 2`,
          )
          .all(completion.startId) as Row[];
        const row = current[0];
        if (
          current.length !== 1 ||
          !row ||
          requiredText(row, 'barrierJson') !==
            JSON.stringify(command.barrier) ||
          requiredInteger(row, 'startedRunVersion') !==
            mutation.expectedRunVersion ||
          requiredInteger(row, 'startedEventSequence') !==
            mutation.expectedRunEventSequence ||
          requiredText(row, 'stepKind') !== 'tool' ||
          requiredText(row, 'stepStatus') !== 'running' ||
          requiredInteger(row, 'stepVersion') !==
            mutation.expectedStepRunVersion ||
          requiredText(row, 'stepDigest') !== mutation.expectedStepRunDigest ||
          requiredText(row, 'projectId') !== completion.projectId ||
          requiredInteger(row, 'runVersion') !== mutation.expectedRunVersion ||
          requiredInteger(row, 'runEventSequence') !==
            mutation.expectedRunEventSequence ||
          TERMINAL_RUN_STATUSES.has(requiredText(row, 'runStatus'))
        ) {
          throw new ToolExecutionFailureCompletionConflictError();
        }

        updateStepRun(this.client, mutation);
        updateRun(this.client, mutation);
        insertRunEvent(this.client, mutation);
        insertMutation(this.client, mutation);
        insertCompletion(this.client, completion);
        this.client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'created' as const,
          completion,
        });
      } catch (error) {
        if (began && this.client.isTransaction) {
          try {
            this.client.exec('ROLLBACK');
          } catch {
            // Preserve the original failure; shared authority owns close.
          }
        }
        throw error;
      }
    });
  }
}
