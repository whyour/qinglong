import type { DatabaseSync } from 'node:sqlite';

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

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
const STEP_RUN_SELECT = `
  "id" AS "id",
  "run_id" AS "runId",
  "parent_step_run_id" AS "parentStepRunId",
  "step_key" AS "stepKey",
  "kind" AS "kind",
  "definition_ref" AS "definitionRef",
  "definition_digest" AS "definitionDigest",
  "required" AS "required",
  "status" AS "status",
  "version" AS "version",
  "attempt_count" AS "attemptCount",
  "input_ref" AS "inputRef",
  "output_ref" AS "outputRef",
  "approval_request_id" AS "approvalRequestId",
  "ready_at_ms" AS "readyAtMs",
  "started_at_ms" AS "startedAtMs",
  "finished_at_ms" AS "finishedAtMs",
  "result_code" AS "resultCode",
  "error_summary" AS "errorSummary",
  "created_at_ms" AS "createdAtMs",
  "updated_at_ms" AS "updatedAtMs",
  "last_mutation_id" AS "lastMutationId",
  "step_run_digest" AS "stepRunDigest",
  "step_run_json" AS "stepRunJson"
`;

function requiredText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new StepRunRepositoryUnavailableError();
  }
  return value;
}

function requiredInteger(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StepRunRepositoryUnavailableError();
  }
  return value as number;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== 'string') {
    throw new StepRunRepositoryUnavailableError();
  }
  return value as string | null;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || (value as number) < 0)
  ) {
    throw new StepRunRepositoryUnavailableError();
  }
  return value as number | null;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new InvalidStepRunError(`${label} is invalid`);
  }
  return value;
}

function serializedRecordFromRow(row: Row): Readonly<StepRunRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredText(row, 'stepRunJson'));
  } catch {
    throw new StepRunRepositoryUnavailableError();
  }
  let record: Readonly<StepRunRecord>;
  try {
    record = normalizeStepRunRecord(parsed as StepRunRecord);
  } catch {
    throw new StepRunRepositoryUnavailableError();
  }
  return record;
}

function recordFromRow(row: Row): Readonly<StepRunRecord> {
  const record = serializedRecordFromRow(row);
  const requiredValue = requiredInteger(row, 'required');
  if (
    (requiredValue !== 0 && requiredValue !== 1) ||
    record.id !== requiredText(row, 'id') ||
    record.runId !== requiredText(row, 'runId') ||
    record.parentStepRunId !== nullableText(row, 'parentStepRunId') ||
    record.stepKey !== requiredText(row, 'stepKey') ||
    record.kind !== requiredText(row, 'kind') ||
    record.definitionRef !== requiredText(row, 'definitionRef') ||
    record.definitionDigest !== requiredText(row, 'definitionDigest') ||
    record.required !== (requiredValue === 1) ||
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
    throw new StepRunRepositoryUnavailableError();
  }
  return record;
}

function sqliteErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

function sqliteErrorNumber(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { errcode?: unknown }).errcode;
  return typeof value === 'number' ? value : undefined;
}

function sqliteErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
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
  const baseCode = (sqliteErrorNumber(error) ?? 0) & 0xff;
  const code = sqliteErrorCode(error);
  const message = sqliteErrorMessage(error);
  if (
    baseCode === 19 ||
    code === 'ERR_SQLITE_CONSTRAINT' ||
    code?.startsWith('ERR_SQLITE_CONSTRAINT') === true
  ) {
    if (
      message.includes('StepRuns.run_id, StepRuns.step_key') ||
      message.includes('ql3 StepRun reference mismatch')
    ) {
      return new StepRunStateConflictError();
    }
    return new StepRunFenceConflictError();
  }
  return new StepRunRepositoryUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

function exactStoredEvent(
  row: Row,
  mutation: Readonly<StepRunMutation>,
): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(requiredText(row, 'eventPayload'));
  } catch {
    throw new StepRunRepositoryUnavailableError();
  }
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
    JSON.stringify(payload) === JSON.stringify(event.payload)
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
    throw new StepRunRepositoryUnavailableError();
  }
  return Object.freeze({
    status: 'existing',
    stepRun,
    runVersion,
    runEventSequence,
  });
}

function insertStepRun(
  client: DatabaseSync,
  stepRun: Readonly<StepRunRecord>,
): void {
  client
    .prepare(
      `INSERT INTO "StepRuns" (
         "id", "run_id", "parent_step_run_id", "step_key", "kind",
         "definition_ref", "definition_digest", "required", "status",
         "version", "attempt_count", "input_ref", "output_ref",
         "approval_request_id", "ready_at_ms", "started_at_ms",
         "finished_at_ms", "result_code", "error_summary", "created_at_ms",
         "updated_at_ms", "last_mutation_id", "step_run_digest",
         "step_run_json"
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?
       )`,
    )
    .run(
      stepRun.id,
      stepRun.runId,
      stepRun.parentStepRunId,
      stepRun.stepKey,
      stepRun.kind,
      stepRun.definitionRef,
      stepRun.definitionDigest,
      stepRun.required ? 1 : 0,
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
    );
}

function updateStepRun(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const stepRun = mutation.stepRun;
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
  if (result.changes !== 1) throw new StepRunFenceConflictError();
}

function appendRunEvent(
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

export class LocalSqliteStepRunRepository implements StepRunRepository {
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
    return this.authority.enqueue(
      async () => {
        try {
          return work();
        } catch (error) {
          throw mapStorageError(error);
        }
      },
      () => new StepRunRepositoryUnavailableError(),
    );
  }

  private findStoredById(id: string): Readonly<StepRunRecord> | null {
    const row = this.client
      .prepare(
        `SELECT ${STEP_RUN_SELECT}
         FROM "StepRuns" WHERE "id" = ? LIMIT 2`,
      )
      .all(id) as Row[];
    if (row.length > 1) throw new StepRunRepositoryUnavailableError();
    return row[0] ? recordFromRow(row[0]) : null;
  }

  findById(idValue: string): Promise<Readonly<StepRunRecord> | null> {
    const id = identity(idValue, 'StepRun id');
    return this.enqueue(() => this.findStoredById(id));
  }

  findByRunAndStepKey(
    runIdValue: string,
    stepKeyValue: string,
  ): Promise<Readonly<StepRunRecord> | null> {
    const runId = identity(runIdValue, 'Run id');
    const stepKey = identity(stepKeyValue, 'step key');
    return this.enqueue(() => {
      const rows = this.client
        .prepare(
          `SELECT ${STEP_RUN_SELECT}
           FROM "StepRuns"
           WHERE "run_id" = ? AND "step_key" = ?
           LIMIT 2`,
        )
        .all(runId, stepKey) as Row[];
      if (rows.length > 1) throw new StepRunRepositoryUnavailableError();
      return rows[0] ? recordFromRow(rows[0]) : null;
    });
  }

  listByRun(queryValue: ListStepRunsQuery): Promise<ListStepRunsResult> {
    const query = normalizeListStepRunsQuery(queryValue);
    return this.enqueue(() => {
      const rows = this.client
        .prepare(
          `SELECT ${STEP_RUN_SELECT}
           FROM "StepRuns"
           WHERE "run_id" = ? AND (
             ? IS NULL OR "step_key" > ? OR
             ("step_key" = ? AND "id" > ?)
           )
           ORDER BY "step_key", "id"
           LIMIT ?`,
        )
        .all(
          query.runId,
          query.after?.id ?? null,
          query.after?.stepKey ?? '',
          query.after?.stepKey ?? '',
          query.after?.id ?? '',
          query.limit + 1,
        ) as Row[];
      const truncated = rows.length > query.limit;
      const stepRuns = rows.slice(0, query.limit).map(recordFromRow);
      const last = stepRuns.at(-1);
      return normalizeListStepRunsResult(
        {
          stepRuns,
          truncated,
          ...(truncated && last
            ? {
                next: {
                  stepKey: last.stepKey,
                  id: last.id,
                },
              }
            : {}),
        },
        query,
      );
    });
  }

  apply(
    mutationValue: StepRunMutation,
  ): Promise<Readonly<ApplyStepRunMutationResult>> {
    const mutation = normalizeStepRunMutation(mutationValue);
    return this.enqueue(() => {
      let began = false;
      try {
        this.client.exec('BEGIN IMMEDIATE');
        began = true;

        const stored = this.client
          .prepare(
            `SELECT
               mutation."mutation_id" AS "mutationId",
               mutation."mutation_digest" AS "mutationDigest",
               mutation."run_id" AS "storedRunId",
               mutation."step_run_id" AS "stepRunId",
               mutation."step_run_digest" AS "storedStepRunDigest",
               mutation."event_sequence" AS "eventSequence",
               mutation."run_version" AS "runVersion",
               mutation."step_run_json" AS "stepRunJson",
               event."id" AS "eventId",
               event."run_id" AS "eventRunId",
               event."sequence" AS "storedEventSequence",
               event."type" AS "eventType",
               event."dedupe_key" AS "eventDedupeKey",
               event."actor_type" AS "eventActorType",
               event."actor_id" AS "eventActorId",
               event."step_run_id" AS "eventStepRunId",
               event."payload" AS "eventPayload",
               event."created_at_ms" AS "eventCreatedAtMs"
             FROM "StepRunMutations" AS mutation
             JOIN "RunEvents" AS event
               ON event."id" = mutation."event_id"
             WHERE mutation."mutation_id" = ?
             LIMIT 2`,
          )
          .all(mutation.mutationId) as Row[];
        if (stored.length > 1) {
          throw new StepRunRepositoryUnavailableError();
        }
        if (stored[0]) {
          const result = storedMutationResult(stored[0], mutation);
          this.client.exec('COMMIT');
          began = false;
          return result;
        }

        const run = this.client
          .prepare(
            `SELECT "status", "version",
                    "event_sequence" AS "eventSequence"
             FROM "Runs" WHERE "id" = ? LIMIT 2`,
          )
          .all(mutation.runId) as Row[];
        if (
          run.length !== 1 ||
          requiredInteger(run[0]!, 'version') !==
            mutation.expectedRunVersion ||
          requiredInteger(run[0]!, 'eventSequence') !==
            mutation.expectedRunEventSequence
        ) {
          throw new StepRunFenceConflictError();
        }
        if (TERMINAL_RUN_STATUSES.has(requiredText(run[0]!, 'status'))) {
          throw new StepRunStateConflictError();
        }

        const current = this.findStoredById(mutation.stepRun.id);
        const resolution = resolveStepRunMutation(current, mutation);
        if (resolution === 'existing') {
          throw new StepRunRepositoryUnavailableError();
        }

        if (mutation.expectedStepRunVersion === null) {
          const count = this.client
            .prepare(
              `SELECT COUNT(*) AS "count"
               FROM "StepRuns" WHERE "run_id" = ?`,
            )
            .get(mutation.runId) as Row | undefined;
          if (
            !count ||
            requiredInteger(count, 'count') >= MAX_STEP_RUNS_PER_RUN
          ) {
            throw new StepRunStateConflictError();
          }
          if (mutation.stepRun.parentStepRunId !== null) {
            const parent = this.client
              .prepare(
                `SELECT 1 AS "present" FROM "StepRuns"
                 WHERE "id" = ? AND "run_id" = ? LIMIT 1`,
              )
              .get(
                mutation.stepRun.parentStepRunId,
                mutation.runId,
              ) as Row | undefined;
            if (!parent) throw new StepRunStateConflictError();
          }
          insertStepRun(this.client, mutation.stepRun);
        } else {
          updateStepRun(this.client, mutation);
        }

        const runResult = this.client
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
        if (runResult.changes !== 1) {
          throw new StepRunFenceConflictError();
        }

        appendRunEvent(this.client, mutation);
        this.client
          .prepare(
            `INSERT INTO "StepRunMutations" (
               "mutation_id", "mutation_digest", "run_id", "step_run_id",
               "step_run_digest", "event_id", "event_sequence",
               "run_version", "step_run_json", "committed_at_ms"
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
               CAST(unixepoch('subsec') * 1000 AS INTEGER))`,
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

        this.client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'applied',
          stepRun: mutation.stepRun,
          runVersion: mutation.expectedRunVersion + 1,
          runEventSequence: mutation.expectedRunEventSequence + 1,
        });
      } catch (error) {
        if (began && this.client.isTransaction) {
          try {
            this.client.exec('ROLLBACK');
          } catch {
            // Preserve the original failure; the shared authority owns close.
          }
        }
        throw error;
      }
    });
  }
}
