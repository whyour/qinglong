// Owns PostgreSQL StepRun persistence under the parent Run aggregate authority.
import {
  InvalidStepRunError,
  MAX_STEP_RUNS_PER_RUN,
  StepRunFenceConflictError,
  StepRunMutationConflictError,
  StepRunRepositoryUnavailableError,
  StepRunStateConflictError,
  normalizeListStepRunsQuery,
  normalizeListStepRunsResult,
  normalizeStepRunMutation,
  normalizeStepRunRecord,
  resolveStepRunMutation,
  type ApplyStepRunMutationResult,
  type ListStepRunsQuery,
  type ListStepRunsResult,
  type StepRunMutation,
  type StepRunRecord,
  type StepRunRepository,
} from '@qinglong/runtime-core/step-run';
import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';
import { isDeepStrictEqual } from 'node:util';

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
} from '../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
const STEP_RUN_SELECT = `
  id,
  run_id AS "runId",
  parent_step_run_id AS "parentStepRunId",
  step_key AS "stepKey",
  kind,
  definition_ref AS "definitionRef",
  definition_digest AS "definitionDigest",
  required,
  status,
  version,
  attempt_count AS "attemptCount",
  input_ref AS "inputRef",
  output_ref AS "outputRef",
  approval_request_id AS "approvalRequestId",
  ready_at_ms AS "readyAtMs",
  started_at_ms AS "startedAtMs",
  finished_at_ms AS "finishedAtMs",
  result_code AS "resultCode",
  error_summary AS "errorSummary",
  created_at_ms AS "createdAtMs",
  updated_at_ms AS "updatedAtMs",
  last_mutation_id AS "lastMutationId",
  step_run_digest AS "stepRunDigest",
  step_run_json AS "stepRunJson"
`;

function unavailable(cause?: unknown): StepRunRepositoryUnavailableError {
  return new StepRunRepositoryUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new InvalidStepRunError(`${label} is invalid`);
  }
  return value;
}

function requiredText(row: Row, key: string): string {
  return postgresRequiredString(row[key], unavailable);
}

function requiredInteger(row: Row, key: string): number {
  const value = postgresRequiredInteger(row[key], unavailable);
  if (value < 0) throw unavailable();
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return postgresRequiredString(value, unavailable);
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  const parsed = postgresRequiredInteger(value, unavailable);
  if (parsed < 0) throw unavailable();
  return parsed;
}

function serializedRecordFromRow(row: Row): Readonly<StepRunRecord> {
  try {
    return normalizeStepRunRecord(
      postgresRequiredJsonObject(row.stepRunJson, unavailable) as unknown as
        StepRunRecord,
    );
  } catch (error) {
    if (error instanceof StepRunRepositoryUnavailableError) throw error;
    throw unavailable(error);
  }
}

function recordFromRow(row: Row): Readonly<StepRunRecord> {
  const record = serializedRecordFromRow(row);
  const requiredValue = postgresRequiredBoolean(row.required, unavailable);
  if (
    record.id !== requiredText(row, 'id') ||
    record.runId !== requiredText(row, 'runId') ||
    record.parentStepRunId !== nullableText(row, 'parentStepRunId') ||
    record.stepKey !== requiredText(row, 'stepKey') ||
    record.kind !== requiredText(row, 'kind') ||
    record.definitionRef !== requiredText(row, 'definitionRef') ||
    record.definitionDigest !== requiredText(row, 'definitionDigest') ||
    record.required !== requiredValue ||
    record.status !== requiredText(row, 'status') ||
    record.version !== requiredInteger(row, 'version') ||
    record.attemptCount !== requiredInteger(row, 'attemptCount') ||
    record.inputRef !== nullableText(row, 'inputRef') ||
    record.outputRef !== nullableText(row, 'outputRef') ||
    record.approvalRequestId !== nullableText(row, 'approvalRequestId') ||
    record.readyAtMs !== nullableInteger(row, 'readyAtMs') ||
    record.startedAtMs !== nullableInteger(row, 'startedAtMs') ||
    record.finishedAtMs !== nullableInteger(row, 'finishedAtMs') ||
    record.resultCode !== nullableText(row, 'resultCode') ||
    record.errorSummary !== nullableText(row, 'errorSummary') ||
    record.createdAtMs !== requiredInteger(row, 'createdAtMs') ||
    record.updatedAtMs !== requiredInteger(row, 'updatedAtMs') ||
    record.lastMutationId !== requiredText(row, 'lastMutationId') ||
    record.stepRunDigest !== requiredText(row, 'stepRunDigest')
  ) {
    throw unavailable();
  }
  return record;
}

function exactStoredEvent(
  row: Row,
  mutation: Readonly<StepRunMutation>,
): boolean {
  const payload = postgresRequiredJsonObject(row.eventPayload, unavailable);
  const event = mutation.event;
  return (
    requiredText(row, 'eventId') === event.id &&
    requiredText(row, 'eventRunId') === event.runId &&
    requiredInteger(row, 'storedEventSequence') === event.sequence &&
    requiredText(row, 'eventType') === event.type &&
    requiredText(row, 'eventDedupeKey') === event.dedupeKey &&
    requiredText(row, 'eventActorType') === event.actorType &&
    (row.eventActorId === null ? undefined : row.eventActorId) ===
      event.actorId &&
    requiredText(row, 'eventStepRunId') === event.stepRunId &&
    requiredInteger(row, 'eventCreatedAtMs') === event.createdAtMs &&
    isDeepStrictEqual(payload, event.payload)
  );
}

function storedMutationResult(
  row: Row,
  mutation: Readonly<StepRunMutation>,
): Readonly<ApplyStepRunMutationResult> {
  const stepRun = serializedRecordFromRow(row);
  if (
    requiredText(row, 'mutationId') !== mutation.mutationId ||
    requiredText(row, 'mutationDigest') !== mutation.mutationDigest ||
    requiredText(row, 'storedRunId') !== mutation.runId ||
    requiredText(row, 'stepRunId') !== mutation.stepRun.id ||
    requiredText(row, 'storedStepRunDigest') !==
      mutation.stepRun.stepRunDigest ||
    JSON.stringify(stepRun) !== JSON.stringify(mutation.stepRun) ||
    !exactStoredEvent(row, mutation)
  ) {
    throw new StepRunMutationConflictError();
  }
  const runVersion = requiredInteger(row, 'runVersion');
  const runEventSequence = requiredInteger(row, 'eventSequence');
  if (
    runVersion !== mutation.expectedRunVersion + 1 ||
    runEventSequence !== mutation.expectedRunEventSequence + 1 ||
    runEventSequence !== mutation.event.sequence
  ) {
    throw unavailable();
  }
  return Object.freeze({
    status: 'existing',
    stepRun,
    runVersion,
    runEventSequence,
  });
}

function constraintName(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = (error as { constraint?: unknown }).constraint;
  return typeof value === 'string' ? value : '';
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidStepRunError ||
    error instanceof StepRunFenceConflictError ||
    error instanceof StepRunMutationConflictError ||
    error instanceof StepRunRepositoryUnavailableError ||
    error instanceof StepRunStateConflictError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  const constraint = constraintName(error);
  if (
    state === '23503' ||
    state === '23505' ||
    state === '23514'
  ) {
    if (
      constraint === 'ql3_step_runs_parent_fk' ||
      constraint === 'ql3_step_runs_run_step_uidx' ||
      constraint === 'ql3_run_attempts_step_run_fk' ||
      constraint === 'ql3_run_events_step_run_fk'
    ) {
      return new StepRunStateConflictError();
    }
    return new StepRunFenceConflictError();
  }
  return unavailable(error);
}

async function findStoredById(
  queryable: PostgresQueryable,
  id: string,
  forUpdate = false,
): Promise<Readonly<StepRunRecord> | null> {
  const result = await queryable.query<Row>(
    `SELECT ${STEP_RUN_SELECT}
     FROM "ql3"."step_runs"
     WHERE id = $1
     LIMIT 2${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  if (result.rows.length > 1) throw unavailable();
  return result.rows[0] ? recordFromRow(result.rows[0]) : null;
}

async function insertStepRun(
  client: PostgresClient,
  stepRun: Readonly<StepRunRecord>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3"."step_runs" (
       id, run_id, parent_step_run_id, step_key, kind, definition_ref,
       definition_digest, required, status, version, attempt_count,
       input_ref, output_ref, approval_request_id, ready_at_ms, started_at_ms,
       finished_at_ms, result_code, error_summary, created_at_ms,
       updated_at_ms, last_mutation_id, step_run_digest, step_run_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb
     )`,
    [
      stepRun.id,
      stepRun.runId,
      stepRun.parentStepRunId,
      stepRun.stepKey,
      stepRun.kind,
      stepRun.definitionRef,
      stepRun.definitionDigest,
      stepRun.required,
      stepRun.status,
      stepRun.version,
      stepRun.attemptCount,
      stepRun.inputRef,
      stepRun.outputRef,
      stepRun.approvalRequestId,
      stepRun.readyAtMs,
      stepRun.startedAtMs,
      stepRun.finishedAtMs,
      stepRun.resultCode,
      stepRun.errorSummary,
      stepRun.createdAtMs,
      stepRun.updatedAtMs,
      stepRun.lastMutationId,
      stepRun.stepRunDigest,
      JSON.stringify(stepRun),
    ],
  );
}

async function updateStepRun(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  const stepRun = mutation.stepRun;
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
    ],
  );
  if (result.rowCount !== 1) throw new StepRunFenceConflictError();
}

async function appendRunEvent(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  const event = mutation.event;
  await client.query(
    `INSERT INTO "ql3"."run_events" (
       id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
       attempt_id, step_run_id, payload, created_at_ms
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9::jsonb, $10)`,
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

export class PostgresStepRunRepository implements StepRunRepository {
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw unavailable();
    }
  }

  async findById(idValue: string): Promise<Readonly<StepRunRecord> | null> {
    const id = identity(idValue, 'StepRun id');
    try {
      return await findStoredById(this.pool, id);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findByRunAndStepKey(
    runIdValue: string,
    stepKeyValue: string,
  ): Promise<Readonly<StepRunRecord> | null> {
    const runId = identity(runIdValue, 'Run id');
    const stepKey = identity(stepKeyValue, 'step key');
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${STEP_RUN_SELECT}
         FROM "ql3"."step_runs"
         WHERE run_id = $1 AND step_key = $2
         LIMIT 2`,
        [runId, stepKey],
      );
      if (result.rows.length > 1) throw unavailable();
      return result.rows[0] ? recordFromRow(result.rows[0]) : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async listByRun(queryValue: ListStepRunsQuery): Promise<ListStepRunsResult> {
    const query = normalizeListStepRunsQuery(queryValue);
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${STEP_RUN_SELECT}
         FROM "ql3"."step_runs"
         WHERE run_id = $1 AND (
           $2::varchar IS NULL OR step_key > $3 OR
           (step_key = $3 AND id > $2)
         )
         ORDER BY step_key, id
         LIMIT $4`,
        [
          query.runId,
          query.after?.id ?? null,
          query.after?.stepKey ?? '',
          query.limit + 1,
        ],
      );
      const truncated = result.rows.length > query.limit;
      const stepRuns = result.rows.slice(0, query.limit).map(recordFromRow);
      const last = stepRuns.at(-1);
      return normalizeListStepRunsResult(
        {
          stepRuns,
          truncated,
          ...(truncated && last
            ? { next: { stepKey: last.stepKey, id: last.id } }
            : {}),
        },
        query,
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async apply(
    mutationValue: StepRunMutation,
  ): Promise<Readonly<ApplyStepRunMutationResult>> {
    const mutation = normalizeStepRunMutation(mutationValue);
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

        const run = await client.query<Row>(
          `SELECT status, version, event_sequence AS "eventSequence"
           FROM "ql3"."runs"
           WHERE id = $1
           LIMIT 2
           FOR UPDATE`,
          [mutation.runId],
        );
        if (run.rows.length !== 1) throw new StepRunFenceConflictError();

        const stored = await client.query<Row>(
          `SELECT
             mutation.mutation_id AS "mutationId",
             mutation.mutation_digest AS "mutationDigest",
             mutation.run_id AS "storedRunId",
             mutation.step_run_id AS "stepRunId",
             mutation.step_run_digest AS "storedStepRunDigest",
             mutation.event_sequence AS "eventSequence",
             mutation.run_version AS "runVersion",
             mutation.step_run_json AS "stepRunJson",
             event.id AS "eventId",
             event.run_id AS "eventRunId",
             event.sequence AS "storedEventSequence",
             event.type AS "eventType",
             event.dedupe_key AS "eventDedupeKey",
             event.actor_type AS "eventActorType",
             event.actor_id AS "eventActorId",
             event.step_run_id AS "eventStepRunId",
             event.payload AS "eventPayload",
             event.created_at_ms AS "eventCreatedAtMs"
           FROM "ql3"."step_run_mutations" AS mutation
           JOIN "ql3"."run_events" AS event
             ON event.id = mutation.event_id
           WHERE mutation.mutation_id = $1
           LIMIT 2`,
          [mutation.mutationId],
        );
        if (stored.rows.length > 1) throw unavailable();
        if (stored.rows[0]) {
          const result = storedMutationResult(stored.rows[0], mutation);
          await client.query('COMMIT');
          began = false;
          return result;
        }

        const runRow = run.rows[0]!;
        if (
          requiredInteger(runRow, 'version') !== mutation.expectedRunVersion ||
          requiredInteger(runRow, 'eventSequence') !==
            mutation.expectedRunEventSequence
        ) {
          throw new StepRunFenceConflictError();
        }
        if (TERMINAL_RUN_STATUSES.has(requiredText(runRow, 'status'))) {
          throw new StepRunStateConflictError();
        }

        const current = await findStoredById(
          client,
          mutation.stepRun.id,
          true,
        );
        const resolution = resolveStepRunMutation(current, mutation);
        if (resolution === 'existing') throw unavailable();

        if (mutation.expectedStepRunVersion === null) {
          const count = await client.query<Row>(
            `SELECT COUNT(*) AS count
             FROM "ql3"."step_runs"
             WHERE run_id = $1`,
            [mutation.runId],
          );
          if (
            count.rows.length !== 1 ||
            requiredInteger(count.rows[0]!, 'count') >= MAX_STEP_RUNS_PER_RUN
          ) {
            throw new StepRunStateConflictError();
          }
          if (mutation.stepRun.parentStepRunId !== null) {
            const parent = await client.query(
              `SELECT 1
               FROM "ql3"."step_runs"
               WHERE id = $1 AND run_id = $2
               LIMIT 1`,
              [mutation.stepRun.parentStepRunId, mutation.runId],
            );
            if (parent.rows.length !== 1) {
              throw new StepRunStateConflictError();
            }
          }
          await insertStepRun(client, mutation.stepRun);
        } else {
          await updateStepRun(client, mutation);
        }

        const updatedRun = await client.query(
          `UPDATE "ql3"."runs"
           SET version = version + 1, event_sequence = event_sequence + 1
           WHERE id = $1 AND version = $2 AND event_sequence = $3`,
          [
            mutation.runId,
            mutation.expectedRunVersion,
            mutation.expectedRunEventSequence,
          ],
        );
        if (updatedRun.rowCount !== 1) {
          throw new StepRunFenceConflictError();
        }

        await appendRunEvent(client, mutation);
        await client.query(
          `INSERT INTO "ql3"."step_run_mutations" (
             mutation_id, mutation_digest, run_id, step_run_id,
             step_run_digest, event_id, event_sequence, run_version,
             step_run_json, committed_at_ms
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
             floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
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

        await client.query('COMMIT');
        began = false;
        return Object.freeze({
          status: 'applied',
          stepRun: mutation.stepRun,
          runVersion: mutation.expectedRunVersion + 1,
          runEventSequence: mutation.expectedRunEventSequence + 1,
        });
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
