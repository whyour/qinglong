import type {
  RunAttemptRecord,
  RunAttemptStatus,
  RunEventRecord,
  RunRecord,
} from '../../domain/run';
import {
  EXECUTION_ORIGINS,
  RUN_ATTEMPT_STATUSES,
  RUN_CANCELLATION_REASONS,
  RUN_EVENT_ACTOR_TYPES,
  RUN_STATUSES,
} from '../../domain/run';
import {
  assertRunRetryPolicyRecord,
  RUN_RETRY_SAFETIES,
  type RunRetryPolicyRecord,
} from '../../domain/runRetryPolicy';
import {
  DuplicateIdempotencyKeyError,
  DuplicateRunAttemptError,
  DuplicateRunEventError,
  RunEventPayloadTooLargeError,
  RunRepositoryBusyError,
  RunRepositoryConstraintError,
  RunRepositoryError,
  RunRepositoryOperationError,
} from '../../domain/repositoryErrors';
import type {
  RunRepository,
  RunRepositoryReader,
  RunRepositoryTransaction,
} from '../../ports/runRepository';
import type {
  PostgresClient as PostgresRunClient,
  PostgresPool as PostgresRunPool,
  PostgresQueryable as PostgresRunQueryable,
  PostgresQueryResult as PostgresRunQueryResult,
} from '@qinglong/runtime-core';

export type {
  PostgresClient as PostgresRunClient,
  PostgresPool as PostgresRunPool,
  PostgresQueryable as PostgresRunQueryable,
  PostgresQueryResult as PostgresRunQueryResult,
} from '@qinglong/runtime-core';
import {
  MAX_CANCELLATION_RECOVERY_PAGE_SIZE,
  MAX_RUN_EVENT_PAGE_SIZE,
  MAX_RUN_EVENT_PAYLOAD_BYTES,
} from '../../ports/runRepository';

interface ColumnDefinition {
  readonly column: string;
  readonly property: string;
}

type QueryRow = Record<string, unknown>;

const POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS = 5_000;
const POSTGRES_RUNTIME_LOCK_TIMEOUT_MS = 1_000;
const POSTGRES_RUNTIME_IDLE_TRANSACTION_TIMEOUT_MS = 10_000;

const RUN_COLUMNS: readonly ColumnDefinition[] = Object.freeze([
  { column: 'id', property: 'id' },
  { column: 'project_id', property: 'projectId' },
  { column: 'task_id', property: 'taskId' },
  { column: 'task_revision', property: 'taskRevision' },
  { column: 'task_name', property: 'taskName' },
  { column: 'task_snapshot_ref', property: 'taskSnapshotRef' },
  { column: 'legacy_cron_id', property: 'legacyCronId' },
  { column: 'parent_run_id', property: 'parentRunId' },
  { column: 'retry_of_run_id', property: 'retryOfRunId' },
  { column: 'trigger_id', property: 'triggerId' },
  { column: 'trigger_type', property: 'triggerType' },
  { column: 'execution_origin', property: 'executionOrigin' },
  { column: 'execution_owner', property: 'executionOwner' },
  { column: 'triggered_by', property: 'triggeredBy' },
  { column: 'request_id', property: 'requestId' },
  { column: 'scheduled_for_ms', property: 'scheduledForMs' },
  { column: 'status', property: 'status' },
  { column: 'version', property: 'version' },
  { column: 'event_sequence', property: 'eventSequence' },
  { column: 'priority', property: 'priority' },
  { column: 'idempotency_key', property: 'idempotencyKey' },
  { column: 'input_ref', property: 'inputRef' },
  { column: 'output_ref', property: 'outputRef' },
  { column: 'created_at_ms', property: 'createdAtMs' },
  { column: 'queued_at_ms', property: 'queuedAtMs' },
  { column: 'started_at_ms', property: 'startedAtMs' },
  { column: 'finished_at_ms', property: 'finishedAtMs' },
  { column: 'cancel_requested_at_ms', property: 'cancelRequestedAtMs' },
  { column: 'cancel_reason', property: 'cancelReason' },
  { column: 'error_code', property: 'errorCode' },
  { column: 'error_summary', property: 'errorSummary' },
]);

const ATTEMPT_COLUMNS: readonly ColumnDefinition[] = Object.freeze([
  { column: 'id', property: 'id' },
  { column: 'run_id', property: 'runId' },
  { column: 'step_run_id', property: 'stepRunId' },
  { column: 'attempt', property: 'attempt' },
  { column: 'status', property: 'status' },
  { column: 'executor_type', property: 'executorType' },
  { column: 'worker_id', property: 'workerId' },
  { column: 'executor_handle', property: 'executorHandle' },
  { column: 'pid', property: 'pid' },
  { column: 'log_artifact_id', property: 'logArtifactId' },
  { column: 'lease_token', property: 'leaseToken' },
  { column: 'lease_expires_at_ms', property: 'leaseExpiresAtMs' },
  { column: 'deadline_at_ms', property: 'deadlineAtMs' },
  { column: 'callback_token_hash', property: 'callbackTokenHash' },
  { column: 'callback_sequence', property: 'callbackSequence' },
  { column: 'created_at_ms', property: 'createdAtMs' },
  { column: 'started_at_ms', property: 'startedAtMs' },
  { column: 'finished_at_ms', property: 'finishedAtMs' },
  { column: 'exit_code', property: 'exitCode' },
  { column: 'error_code', property: 'errorCode' },
  { column: 'error_summary', property: 'errorSummary' },
]);

const EVENT_COLUMNS: readonly ColumnDefinition[] = Object.freeze([
  { column: 'id', property: 'id' },
  { column: 'run_id', property: 'runId' },
  { column: 'sequence', property: 'sequence' },
  { column: 'type', property: 'type' },
  { column: 'dedupe_key', property: 'dedupeKey' },
  { column: 'actor_type', property: 'actorType' },
  { column: 'actor_id', property: 'actorId' },
  { column: 'attempt_id', property: 'attemptId' },
  { column: 'step_run_id', property: 'stepRunId' },
  { column: 'payload', property: 'payload' },
  { column: 'created_at_ms', property: 'createdAtMs' },
]);

const RETRY_POLICY_COLUMNS: readonly ColumnDefinition[] = Object.freeze([
  { column: 'run_id', property: 'runId' },
  { column: 'max_attempts', property: 'maxAttempts' },
  { column: 'retry_on_lost', property: 'retryOnLost' },
  { column: 'safety', property: 'safety' },
  { column: 'backoff_base_ms', property: 'backoffBaseMs' },
  { column: 'backoff_max_ms', property: 'backoffMaxMs' },
  { column: 'next_attempt_at_ms', property: 'nextAttemptAtMs' },
  { column: 'version', property: 'version' },
  { column: 'created_at_ms', property: 'createdAtMs' },
  { column: 'updated_at_ms', property: 'updatedAtMs' },
]);

const TERMINAL_RUN_STATUSES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

const BUSY_SQL_STATES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '40001',
  '40P01',
  '55P03',
  '57014',
  '57P01',
  '57P02',
  '57P03',
]);

const RUN_IDEMPOTENCY_CONSTRAINT = 'ql3_runs_project_idempotency_uidx';
const ATTEMPT_NUMBER_CONSTRAINT = 'ql3_run_attempts_run_attempt_uidx';
const EVENT_SEQUENCE_CONSTRAINT = 'ql3_run_events_run_sequence_uidx';
const EVENT_DEDUPE_CONSTRAINT = 'ql3_run_events_run_dedupe_uidx';

function quoted(identifier: string): string {
  return `"${identifier}"`;
}

function selectColumns(columns: readonly ColumnDefinition[]): string {
  return columns
    .map(({ column, property }) => `${quoted(column)} AS ${quoted(property)}`)
    .join(', ');
}

function insertSql(
  tableName: string,
  columns: readonly ColumnDefinition[],
): string {
  return `INSERT INTO "ql3".${quoted(tableName)} (${columns
    .map(({ column }) => quoted(column))
    .join(', ')}) VALUES (${columns
    .map((_, index) => `$${index + 1}`)
    .join(', ')})`;
}

function updateSql(
  tableName: string,
  columns: readonly ColumnDefinition[],
  predicate: string,
): string {
  const mutableColumns = columns.slice(1);
  return `UPDATE "ql3".${quoted(tableName)} SET ${mutableColumns
    .map(({ column }, index) => `${quoted(column)} = $${index + 2}`)
    .join(', ')} WHERE ${predicate} RETURNING ${quoted(columns[0].column)}`;
}

function writeValues(
  record: object,
  columns: readonly ColumnDefinition[],
): unknown[] {
  const values = record as Record<string, unknown>;
  return columns.map(({ property }) => values[property] ?? null);
}

function requiredString(row: QueryRow, property: string): string {
  const value = row[property];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RunRepositoryConstraintError(
      `PostgreSQL Run row has an invalid ${property}`,
    );
  }
  return value;
}

function optionalString(row: QueryRow, property: string): string | undefined {
  const value = row[property];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new RunRepositoryConstraintError(
      `PostgreSQL Run row has an invalid ${property}`,
    );
  }
  return value;
}

function requiredInteger(row: QueryRow, property: string): number {
  const value = row[property];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new RunRepositoryConstraintError(
    `PostgreSQL Run row has an invalid ${property}`,
  );
}

function optionalInteger(row: QueryRow, property: string): number | undefined {
  if (row[property] === null || row[property] === undefined) return undefined;
  return requiredInteger(row, property);
}

function requiredBoolean(row: QueryRow, property: string): boolean {
  const value = row[property];
  if (typeof value !== 'boolean') {
    throw new RunRepositoryConstraintError(
      `PostgreSQL Run row has an invalid ${property}`,
    );
  }
  return value;
}

function requiredEnum<T extends string>(
  row: QueryRow,
  property: string,
  allowed: readonly T[],
): T {
  const value = requiredString(row, property);
  if (!allowed.includes(value as T)) {
    throw new RunRepositoryConstraintError(
      `PostgreSQL Run row has an unsupported ${property}`,
    );
  }
  return value as T;
}

function assignOptional<T extends object, K extends keyof T>(
  record: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) record[key] = value;
}

function rowToRun(row: QueryRow): RunRecord {
  const run: RunRecord = {
    id: requiredString(row, 'id'),
    projectId: requiredString(row, 'projectId'),
    taskId: requiredString(row, 'taskId'),
    taskRevision: requiredString(row, 'taskRevision'),
    triggerType: requiredString(row, 'triggerType'),
    executionOrigin: requiredEnum(row, 'executionOrigin', EXECUTION_ORIGINS),
    executionOwner: requiredEnum(row, 'executionOwner', [
      'legacy',
      'runtime',
    ] as const),
    status: requiredEnum(row, 'status', RUN_STATUSES),
    version: requiredInteger(row, 'version'),
    eventSequence: requiredInteger(row, 'eventSequence'),
    priority: requiredInteger(row, 'priority'),
    createdAtMs: requiredInteger(row, 'createdAtMs'),
  };
  assignOptional(run, 'taskName', optionalString(row, 'taskName'));
  assignOptional(
    run,
    'taskSnapshotRef',
    optionalString(row, 'taskSnapshotRef'),
  );
  assignOptional(run, 'legacyCronId', optionalInteger(row, 'legacyCronId'));
  assignOptional(run, 'parentRunId', optionalString(row, 'parentRunId'));
  assignOptional(run, 'retryOfRunId', optionalString(row, 'retryOfRunId'));
  assignOptional(run, 'triggerId', optionalString(row, 'triggerId'));
  assignOptional(run, 'triggeredBy', optionalString(row, 'triggeredBy'));
  assignOptional(run, 'requestId', optionalString(row, 'requestId'));
  assignOptional(run, 'scheduledForMs', optionalInteger(row, 'scheduledForMs'));
  assignOptional(run, 'idempotencyKey', optionalString(row, 'idempotencyKey'));
  assignOptional(run, 'inputRef', optionalString(row, 'inputRef'));
  assignOptional(run, 'outputRef', optionalString(row, 'outputRef'));
  assignOptional(run, 'queuedAtMs', optionalInteger(row, 'queuedAtMs'));
  assignOptional(run, 'startedAtMs', optionalInteger(row, 'startedAtMs'));
  assignOptional(run, 'finishedAtMs', optionalInteger(row, 'finishedAtMs'));
  assignOptional(
    run,
    'cancelRequestedAtMs',
    optionalInteger(row, 'cancelRequestedAtMs'),
  );
  if (row.cancelReason !== null && row.cancelReason !== undefined) {
    run.cancelReason = requiredEnum(
      row,
      'cancelReason',
      RUN_CANCELLATION_REASONS,
    );
  }
  assignOptional(run, 'errorCode', optionalString(row, 'errorCode'));
  assignOptional(run, 'errorSummary', optionalString(row, 'errorSummary'));
  return run;
}

function rowToAttempt(row: QueryRow): RunAttemptRecord {
  const attempt: RunAttemptRecord = {
    id: requiredString(row, 'id'),
    runId: requiredString(row, 'runId'),
    attempt: requiredInteger(row, 'attempt'),
    status: requiredEnum(row, 'status', RUN_ATTEMPT_STATUSES),
    executorType: requiredString(row, 'executorType'),
    callbackSequence: requiredInteger(row, 'callbackSequence'),
    createdAtMs: requiredInteger(row, 'createdAtMs'),
  };
  assignOptional(attempt, 'stepRunId', optionalString(row, 'stepRunId'));
  assignOptional(attempt, 'workerId', optionalString(row, 'workerId'));
  assignOptional(
    attempt,
    'executorHandle',
    optionalString(row, 'executorHandle'),
  );
  assignOptional(attempt, 'pid', optionalInteger(row, 'pid'));
  assignOptional(
    attempt,
    'logArtifactId',
    optionalString(row, 'logArtifactId'),
  );
  assignOptional(attempt, 'leaseToken', optionalString(row, 'leaseToken'));
  assignOptional(
    attempt,
    'leaseExpiresAtMs',
    optionalInteger(row, 'leaseExpiresAtMs'),
  );
  assignOptional(attempt, 'deadlineAtMs', optionalInteger(row, 'deadlineAtMs'));
  assignOptional(
    attempt,
    'callbackTokenHash',
    optionalString(row, 'callbackTokenHash'),
  );
  assignOptional(attempt, 'startedAtMs', optionalInteger(row, 'startedAtMs'));
  assignOptional(attempt, 'finishedAtMs', optionalInteger(row, 'finishedAtMs'));
  assignOptional(attempt, 'exitCode', optionalInteger(row, 'exitCode'));
  assignOptional(attempt, 'errorCode', optionalString(row, 'errorCode'));
  assignOptional(attempt, 'errorSummary', optionalString(row, 'errorSummary'));
  return attempt;
}

function normalizePayload(payload: unknown): Readonly<Record<string, unknown>> {
  let value = payload;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new RunRepositoryConstraintError(
        'PostgreSQL RunEvent payload is invalid JSON',
        error,
      );
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunRepositoryConstraintError(
      'PostgreSQL RunEvent payload is not a JSON object',
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function rowToEvent(row: QueryRow): RunEventRecord {
  const event: RunEventRecord = {
    id: requiredString(row, 'id'),
    runId: requiredString(row, 'runId'),
    sequence: requiredInteger(row, 'sequence'),
    type: requiredString(row, 'type'),
    actorType: requiredEnum(row, 'actorType', RUN_EVENT_ACTOR_TYPES),
    payload: normalizePayload(row.payload),
    createdAtMs: requiredInteger(row, 'createdAtMs'),
  };
  assignOptional(event, 'dedupeKey', optionalString(row, 'dedupeKey'));
  assignOptional(event, 'actorId', optionalString(row, 'actorId'));
  assignOptional(event, 'attemptId', optionalString(row, 'attemptId'));
  assignOptional(event, 'stepRunId', optionalString(row, 'stepRunId'));
  return event;
}

function rowToRetryPolicy(row: QueryRow): RunRetryPolicyRecord {
  const policy: RunRetryPolicyRecord = {
    runId: requiredString(row, 'runId'),
    maxAttempts: requiredInteger(row, 'maxAttempts'),
    retryOnLost: requiredBoolean(row, 'retryOnLost'),
    safety: requiredEnum(row, 'safety', RUN_RETRY_SAFETIES),
    backoffBaseMs: requiredInteger(row, 'backoffBaseMs'),
    backoffMaxMs: requiredInteger(row, 'backoffMaxMs'),
    version: requiredInteger(row, 'version'),
    createdAtMs: requiredInteger(row, 'createdAtMs'),
    updatedAtMs: requiredInteger(row, 'updatedAtMs'),
  };
  assignOptional(
    policy,
    'nextAttemptAtMs',
    optionalInteger(row, 'nextAttemptAtMs'),
  );
  assertRunRetryPolicyRecord(policy);
  return policy;
}

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

function constraintName(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { constraint?: unknown }).constraint;
  return typeof value === 'string' ? value : undefined;
}

function mapPostgresError(error: unknown): RunRepositoryError {
  if (error instanceof RunRepositoryError) return error;
  const state = sqlState(error);
  if (state && BUSY_SQL_STATES.has(state)) {
    return new RunRepositoryBusyError(error);
  }
  if (state?.startsWith('23')) {
    return new RunRepositoryConstraintError(
      'PostgreSQL Run repository constraint violation',
      error,
    );
  }
  return new RunRepositoryOperationError(error);
}

function affectedOneOrNone(result: PostgresRunQueryResult): boolean {
  const count = result.rowCount ?? result.rows.length;
  if (count === 0) return false;
  if (count === 1) return true;
  throw new RunRepositoryConstraintError(
    'PostgreSQL compare-and-set affected more than one row',
  );
}

function assertEventPayloadSize(event: RunEventRecord): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(event.payload);
  } catch (error) {
    throw new RunRepositoryConstraintError(
      'RunEvent payload is not JSON serializable',
      error,
    );
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_RUN_EVENT_PAYLOAD_BYTES) {
    throw new RunEventPayloadTooLargeError(bytes, MAX_RUN_EVENT_PAYLOAD_BYTES);
  }
}

async function queryMapped<TRow extends QueryRow = QueryRow>(
  queryable: PostgresRunQueryable,
  text: string,
  values?: readonly unknown[],
): Promise<PostgresRunQueryResult<TRow>> {
  try {
    return await queryable.query<TRow>(text, values);
  } catch (error) {
    throw mapPostgresError(error);
  }
}

function singleRow<TRow extends QueryRow>(
  result: PostgresRunQueryResult<TRow>,
): TRow | null {
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) {
    throw new RunRepositoryConstraintError(
      'PostgreSQL Run repository returned duplicate identity rows',
    );
  }
  return result.rows[0];
}

const RUN_SELECT = selectColumns(RUN_COLUMNS);
const ATTEMPT_SELECT = selectColumns(ATTEMPT_COLUMNS);
const EVENT_SELECT = selectColumns(EVENT_COLUMNS);
const RETRY_POLICY_SELECT = selectColumns(RETRY_POLICY_COLUMNS);

const INSERT_RUN_SQL = insertSql('runs', RUN_COLUMNS);
const INSERT_ATTEMPT_SQL = insertSql('run_attempts', ATTEMPT_COLUMNS);
const INSERT_EVENT_SQL = insertSql('run_events', EVENT_COLUMNS);
const INSERT_RETRY_POLICY_SQL = insertSql(
  'run_retry_policies',
  RETRY_POLICY_COLUMNS,
);
const UPDATE_RUN_SQL = updateSql(
  'runs',
  RUN_COLUMNS,
  `"id" = $1 AND "version" = $${RUN_COLUMNS.length + 1}`,
);
const UPDATE_ATTEMPT_SQL = updateSql(
  'run_attempts',
  ATTEMPT_COLUMNS,
  `"id" = $1 AND "status" = $${
    ATTEMPT_COLUMNS.length + 1
  } AND "callback_sequence" = $${ATTEMPT_COLUMNS.length + 2}`,
);
const UPDATE_RETRY_POLICY_SQL = updateSql(
  'run_retry_policies',
  RETRY_POLICY_COLUMNS,
  `"run_id" = $1 AND "version" = $${RETRY_POLICY_COLUMNS.length + 1}`,
);

class PostgresRunReader implements RunRepositoryReader {
  constructor(protected readonly queryable: PostgresRunQueryable) {}

  async findRunById(runId: string): Promise<RunRecord | null> {
    const row = singleRow(
      await queryMapped(
        this.queryable,
        `SELECT ${RUN_SELECT} FROM "ql3"."runs" WHERE "id" = $1`,
        [runId],
      ),
    );
    return row ? rowToRun(row) : null;
  }

  async findAttemptById(attemptId: string): Promise<RunAttemptRecord | null> {
    const row = singleRow(
      await queryMapped(
        this.queryable,
        `SELECT ${ATTEMPT_SELECT} FROM "ql3"."run_attempts" WHERE "id" = $1`,
        [attemptId],
      ),
    );
    return row ? rowToAttempt(row) : null;
  }

  async findLatestAttemptByRunId(
    runId: string,
  ): Promise<RunAttemptRecord | null> {
    const row = singleRow(
      await queryMapped(
        this.queryable,
        `SELECT ${ATTEMPT_SELECT} FROM "ql3"."run_attempts" WHERE "run_id" = $1 ORDER BY "attempt" DESC, "id" DESC LIMIT 1`,
        [runId],
      ),
    );
    return row ? rowToAttempt(row) : null;
  }

  async findRetryPolicyByRunId(
    runId: string,
  ): Promise<RunRetryPolicyRecord | null> {
    const row = singleRow(
      await queryMapped(
        this.queryable,
        `SELECT ${RETRY_POLICY_SELECT} FROM "ql3"."run_retry_policies" WHERE "run_id" = $1`,
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
    const result = await queryMapped(
      this.queryable,
      `SELECT ${EVENT_SELECT} FROM "ql3"."run_events" WHERE "run_id" = $1 AND "sequence" > $2 ORDER BY "sequence", "id" LIMIT $3`,
      [runId, afterSequence, limit],
    );
    return result.rows.map(rowToEvent);
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
    const result = await queryMapped(
      this.queryable,
      `SELECT ${RUN_SELECT} FROM "ql3"."runs" WHERE "status" <> ALL($1::text[]) AND "cancel_requested_at_ms" IS NOT NULL AND ($2::bigint IS NULL OR "cancel_requested_at_ms" <= $2) ORDER BY "cancel_requested_at_ms", "id" LIMIT $3`,
      [TERMINAL_RUN_STATUSES, beforeMs ?? null, limit],
    );
    return result.rows.map(rowToRun);
  }
}

export class PostgresRunTransaction
  extends PostgresRunReader
  implements RunRepositoryTransaction
{
  async insertRun(run: RunRecord): Promise<void> {
    try {
      await this.queryable.query(INSERT_RUN_SQL, writeValues(run, RUN_COLUMNS));
    } catch (error) {
      if (
        sqlState(error) === '23505' &&
        constraintName(error) === RUN_IDEMPOTENCY_CONSTRAINT &&
        run.idempotencyKey
      ) {
        throw new DuplicateIdempotencyKeyError(
          run.projectId,
          run.idempotencyKey,
        );
      }
      throw mapPostgresError(error);
    }
  }

  async insertAttempt(attempt: RunAttemptRecord): Promise<void> {
    try {
      await this.queryable.query(
        INSERT_ATTEMPT_SQL,
        writeValues(attempt, ATTEMPT_COLUMNS),
      );
    } catch (error) {
      if (
        sqlState(error) === '23505' &&
        constraintName(error) === ATTEMPT_NUMBER_CONSTRAINT
      ) {
        throw new DuplicateRunAttemptError(attempt.runId, attempt.attempt);
      }
      throw mapPostgresError(error);
    }
  }

  async insertRetryPolicy(policy: RunRetryPolicyRecord): Promise<void> {
    assertRunRetryPolicyRecord(policy);
    try {
      await this.queryable.query(
        INSERT_RETRY_POLICY_SQL,
        writeValues(policy, RETRY_POLICY_COLUMNS),
      );
    } catch (error) {
      throw mapPostgresError(error);
    }
  }

  async compareAndSetRun(
    run: RunRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    if (run.version !== expectedVersion + 1) {
      throw new RunRepositoryConstraintError(
        'A compare-and-set Run write must increment version exactly once',
      );
    }
    const result = await queryMapped(this.queryable, UPDATE_RUN_SQL, [
      ...writeValues(run, RUN_COLUMNS),
      expectedVersion,
    ]);
    return affectedOneOrNone(result);
  }

  async compareAndSetAttempt(
    attempt: RunAttemptRecord,
    expected: {
      status: RunAttemptStatus;
      callbackSequence: number;
    },
  ): Promise<boolean> {
    const result = await queryMapped(this.queryable, UPDATE_ATTEMPT_SQL, [
      ...writeValues(attempt, ATTEMPT_COLUMNS),
      expected.status,
      expected.callbackSequence,
    ]);
    return affectedOneOrNone(result);
  }

  async compareAndSetRetryPolicy(
    policy: RunRetryPolicyRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    if (policy.version !== expectedVersion + 1) {
      throw new RunRepositoryConstraintError(
        'A compare-and-set retry policy write must increment version exactly once',
      );
    }
    assertRunRetryPolicyRecord(policy);
    const result = await queryMapped(this.queryable, UPDATE_RETRY_POLICY_SQL, [
      ...writeValues(policy, RETRY_POLICY_COLUMNS),
      expectedVersion,
    ]);
    return affectedOneOrNone(result);
  }

  async appendEvent(event: RunEventRecord): Promise<void> {
    assertEventPayloadSize(event);
    try {
      await this.queryable.query(
        INSERT_EVENT_SQL,
        writeValues(event, EVENT_COLUMNS),
      );
    } catch (error) {
      if (
        sqlState(error) === '23505' &&
        (constraintName(error) === EVENT_SEQUENCE_CONSTRAINT ||
          constraintName(error) === EVENT_DEDUPE_CONSTRAINT)
      ) {
        throw new DuplicateRunEventError(event.runId, event.dedupeKey);
      }
      throw mapPostgresError(error);
    }
  }
}

/**
 * Driver-neutral PostgreSQL Run Repository. The cluster-only package owns the
 * concrete pg.Pool binding; edge/standalone builds never import the driver.
 */
export class PostgresRunRepository
  extends PostgresRunReader
  implements RunRepository
{
  constructor(private readonly pool: PostgresRunPool) {
    super(pool);
  }

  async transaction<T>(
    work: (transaction: RunRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    let client: PostgresRunClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw mapPostgresError(error);
    }
    let began = false;
    let phase: 'begin' | 'work' | 'commit' = 'begin';
    try {
      await client.query('BEGIN');
      began = true;
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
        `${POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS}ms`,
      ]);
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [
        `${POSTGRES_RUNTIME_LOCK_TIMEOUT_MS}ms`,
      ]);
      await client.query(
        `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
        [`${POSTGRES_RUNTIME_IDLE_TRANSACTION_TIMEOUT_MS}ms`],
      );
      phase = 'work';
      const result = await work(new PostgresRunTransaction(client));
      phase = 'commit';
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the work/commit failure; release discards broken clients.
        }
      }
      if (phase === 'work') throw error;
      throw mapPostgresError(error);
    } finally {
      client.release();
    }
  }
}
