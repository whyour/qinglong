import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';
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
import { normalizeToolExecutionStartBarrierRecord } from '@qinglong/runtime-core/tool-execution-start-barrier';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresQueryable, 'query'>;

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
  return postgresRequiredString(row[key], unavailable);
}

function requiredInteger(row: Row, key: string): number {
  return postgresRequiredInteger(row[key], unavailable);
}

function requiredJson(row: Row, key: string): Record<string, unknown> {
  return postgresRequiredJsonObject(row[key], unavailable);
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new InvalidToolExecutionFailureCompletionError(`${label} is invalid`);
  }
  return value;
}

function constraintError(error: unknown): boolean {
  const state = postgresSqlState(error);
  return state === '23503' || state === '23505' || state === '23514';
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidToolExecutionFailureCompletionError ||
    error instanceof ToolExecutionFailureCompletionConflictError ||
    error instanceof ToolExecutionFailureCompletionUnavailableError
  ) {
    return error;
  }
  return constraintError(error)
    ? new ToolExecutionFailureCompletionConflictError()
    : unavailable(error);
}

function valuesFromRow(
  row: Row,
): Readonly<ToolExecutionFailureCompletionRecord> {
  let completion: Readonly<ToolExecutionFailureCompletionRecord>;
  try {
    completion = normalizeToolExecutionFailureCompletionRecord(
      requiredJson(
        row,
        'completionJson',
      ) as unknown as ToolExecutionFailureCompletionRecord,
    );
  } catch {
    throw unavailable();
  }
  if (
    Buffer.byteLength(JSON.stringify(completion), 'utf8') >
      MAX_TOOL_EXECUTION_FAILURE_COMPLETION_JSON_BYTES ||
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
    completion.runEventId !== requiredText(row, 'joinedRunEventId')
  ) {
    throw unavailable();
  }
  return completion;
}

async function findRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT ${COMPLETION_SELECT}
     FROM "ql3"."tool_execution_failure_completions" AS completion
     JOIN "ql3"."tool_execution_start_barriers" AS barrier
       ON barrier.start_id = completion.start_id
     JOIN "ql3"."step_run_mutations" AS mutation
       ON mutation.mutation_id = completion.step_run_mutation_id
     JOIN "ql3"."run_events" AS event
       ON event.id = completion.run_event_id
     WHERE ${where}
     LIMIT 2`,
    values,
  );
  return result.rows;
}

async function updateStepRun(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  const step = mutation.stepRun;
  const result = await client.query(
    `UPDATE "ql3"."step_runs"
     SET status = $1, version = $2, attempt_count = $3,
         output_ref = $4, approval_request_id = $5, ready_at_ms = $6,
         started_at_ms = $7, finished_at_ms = $8, result_code = $9,
         error_summary = $10, updated_at_ms = $11,
         last_mutation_id = $12, step_run_digest = $13,
         step_run_json = $14::jsonb
     WHERE id = $15 AND run_id = $16 AND version = $17
       AND step_run_digest = $18 AND status = $19`,
    [
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
    ],
  );
  if (result.rowCount !== 1) {
    throw new ToolExecutionFailureCompletionConflictError();
  }
}

async function updateRun(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  const result = await client.query(
    `UPDATE "ql3"."runs"
     SET version = version + 1, event_sequence = event_sequence + 1
     WHERE id = $1 AND version = $2 AND event_sequence = $3`,
    [
      mutation.runId,
      mutation.expectedRunVersion,
      mutation.expectedRunEventSequence,
    ],
  );
  if (result.rowCount !== 1) {
    throw new ToolExecutionFailureCompletionConflictError();
  }
}

async function insertRunEvent(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  const event = mutation.event;
  await client.query(
    `INSERT INTO "ql3"."run_events" (
       id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
       attempt_id, step_run_id, payload, created_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, NULL, $8, $9::jsonb, $10
     )`,
    [
      event.id,
      event.runId,
      event.sequence,
      event.type,
      event.dedupeKey,
      event.actorType,
      event.actorId ?? null,
      mutation.stepRun.id,
      JSON.stringify(event.payload),
      event.createdAtMs,
    ],
  );
}

async function insertMutation(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3"."step_run_mutations" (
       mutation_id, mutation_digest, run_id, step_run_id,
       step_run_digest, event_id, event_sequence, run_version,
       step_run_json, committed_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
       floor(
         extract(epoch FROM transaction_timestamp()) * 1000
       )::bigint
     )`,
    [
      mutation.mutationId,
      mutation.mutationDigest,
      mutation.runId,
      mutation.stepRun.id,
      mutation.stepRun.stepRunDigest,
      mutation.event.id,
      mutation.event.sequence,
      mutation.expectedRunVersion + 1,
      JSON.stringify(mutation.stepRun),
    ],
  );
}

async function insertCompletion(
  client: PostgresClient,
  completion: Readonly<ToolExecutionFailureCompletionRecord>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3"."tool_execution_failure_completions" (
       start_id, project_id, run_id, step_run_id,
       started_step_run_version, completed_step_run_version,
       barrier_digest, adapter_digest, outcome, result_code,
       error_summary, step_run_mutation_id, step_run_mutation_digest,
       completed_step_run_digest, run_event_id, completed_at_ms,
       completion_digest, completion_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18::jsonb
     )`,
    [
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
    ],
  );
}

export class PostgresToolExecutionFailureCompletionRepository
  implements ToolExecutionFailureCompletionRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw unavailable();
    }
  }

  async findByStartId(
    startIdValue: string,
  ): Promise<Readonly<ToolExecutionFailureCompletionRecord> | null> {
    const startId = identity(startIdValue, 'start id');
    try {
      const rows = await findRows(this.pool, 'completion.start_id = $1', [
        startId,
      ]);
      if (rows.length > 1) throw unavailable();
      return rows[0] ? valuesFromRow(rows[0]) : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async commit(
    commandValue: ToolExecutionFailureCompletionCommand,
  ): Promise<Readonly<CommitToolExecutionFailureCompletionResult>> {
    const command =
      normalizeToolExecutionFailureCompletionCommand(commandValue);
    const completion = toolExecutionFailureCompletionRecord(command);
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
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
        const existing = await findRows(
          client,
          `completion.start_id = $1
           OR completion.step_run_mutation_id = $2
           OR completion.run_event_id = $3
           OR (
             completion.run_id = $4 AND completion.step_run_id = $5
             AND completion.completed_step_run_version = $6
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
          await client.query('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing',
            completion: stored,
          });
        }

        const successConflict = await client.query(
          `SELECT 1
           FROM "ql3"."tool_execution_completions"
           WHERE start_id = $1 OR step_run_mutation_id = $2
             OR run_event_id = $3
             OR (
               run_id = $4 AND step_run_id = $5
               AND completed_step_run_version = $6
             )
           LIMIT 1`,
          [
            completion.startId,
            completion.stepRunMutationId,
            completion.runEventId,
            completion.runId,
            completion.stepRunId,
            completion.completedStepRunVersion,
          ],
        );
        if (successConflict.rows.length > 0) {
          throw new ToolExecutionFailureCompletionConflictError();
        }

        const mutation = command.stepRunMutation;
        const current = await client.query<Row>(
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
           FROM "ql3"."tool_execution_start_barriers" AS barrier
           JOIN "ql3"."step_run_mutations" AS start_mutation
             ON start_mutation.mutation_id = barrier.step_run_mutation_id
           JOIN "ql3"."step_runs" AS step
             ON step.id = barrier.step_run_id
            AND step.run_id = barrier.run_id
           JOIN "ql3"."runs" AS run ON run.id = barrier.run_id
           WHERE barrier.start_id = $1
           LIMIT 2
           FOR UPDATE OF step, run`,
          [completion.startId],
        );
        const row = current.rows[0];
        let storedBarrier;
        try {
          storedBarrier = row
            ? normalizeToolExecutionStartBarrierRecord(
                requiredJson(
                  row,
                  'barrierJson',
                ) as unknown as ToolExecutionFailureCompletionCommand['barrier'],
              )
            : null;
        } catch {
          throw unavailable();
        }
        if (
          current.rows.length !== 1 ||
          !row ||
          !storedBarrier ||
          JSON.stringify(storedBarrier) !== JSON.stringify(command.barrier) ||
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

        await updateStepRun(client, mutation);
        await updateRun(client, mutation);
        await insertRunEvent(client, mutation);
        await insertMutation(client, mutation);
        await insertCompletion(client, completion);
        await client.query('COMMIT');
        began = false;
        return Object.freeze({ status: 'created', completion });
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          state &&
          POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) &&
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
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
