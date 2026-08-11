import type {
  RunAttemptRecord,
  RunEventRecord,
  RunRecord,
  RunRetryPolicyRecord,
} from '@qinglong/runtime-core/run-repository';
import {
  EXECUTION_ORIGINS,
  MAX_RUN_EVENT_PAYLOAD_BYTES,
  RUN_ATTEMPT_STATUSES,
  RUN_CANCELLATION_REASONS,
  RUN_EVENT_ACTOR_TYPES,
  RUN_RETRY_SAFETIES,
  RUN_STATUSES,
  RunEventPayloadTooLargeError,
  RunRepositoryBusyError,
  RunRepositoryConstraintError,
  RunRepositoryError,
  RunRepositoryOperationError,
  assertRunRetryPolicyRecord,
} from '@qinglong/runtime-core/run-repository';
import type { DatabaseSync } from 'node:sqlite';

import {
  createSqlitePersistencePrimitives,
  isSqliteDriverError,
  sqliteDriverErrorCode,
  sqliteDriverErrorMessage,
  sqliteDriverErrorNumber,
  type SqliteQueryRow,
} from '../storage/sqlitePersistence';

interface ColumnDefinition {
  readonly column: string;
  readonly property: string;
}

export type QueryRow = SqliteQueryRow;

const RUN_SQLITE_PERSISTENCE = createSqlitePersistencePrimitives({
  invalidRowValue: (property) =>
    new RunRepositoryConstraintError(
      `Local SQLite Run row has an invalid ${property}`,
    ),
  invalidJson: (property) =>
    new RunRepositoryConstraintError(
      `Local SQLite Run row has invalid ${property} JSON`,
    ),
  unsupportedRowValue: (property) =>
    new RunRepositoryConstraintError(
      `Local SQLite Run row has an unsupported ${property}`,
    ),
  duplicateIdentityRows: () =>
    new RunRepositoryConstraintError(
      'Local SQLite Run repository returned duplicate identity rows',
    ),
  mapDriverError: mapSqliteError,
});

export const RUN_COLUMNS: readonly ColumnDefinition[] = Object.freeze([
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

export const ATTEMPT_COLUMNS: readonly ColumnDefinition[] = Object.freeze([
  { column: 'id', property: 'id' },
  { column: 'run_id', property: 'runId' },
  { column: 'step_run_id', property: 'stepRunId' },
  { column: 'attempt', property: 'attempt' },
  { column: 'status', property: 'status' },
  { column: 'executor_type', property: 'executorType' },
  { column: 'worker_id', property: 'workerId' },
  { column: 'worker_session_id', property: 'workerSessionId' },
  { column: 'worker_generation', property: 'workerGeneration' },
  { column: 'executor_handle', property: 'executorHandle' },
  { column: 'pid', property: 'pid' },
  { column: 'log_artifact_id', property: 'logArtifactId' },
  { column: 'lease_token', property: 'leaseToken' },
  { column: 'lease_token_digest', property: 'leaseTokenDigest' },
  { column: 'lease_generation', property: 'leaseGeneration' },
  { column: 'lease_version', property: 'leaseVersion' },
  { column: 'lease_expires_at_ms', property: 'leaseExpiresAtMs' },
  { column: 'offer_id', property: 'offerId' },
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

export const EVENT_COLUMNS: readonly ColumnDefinition[] = Object.freeze([
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

export const RETRY_POLICY_COLUMNS: readonly ColumnDefinition[] = Object.freeze([
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
  return `INSERT INTO ${quoted(tableName)} (${columns
    .map(({ column }) => quoted(column))
    .join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
}

function updateSql(
  tableName: string,
  columns: readonly ColumnDefinition[],
  predicate: string,
): string {
  return `UPDATE ${quoted(tableName)} SET ${columns
    .slice(1)
    .map(({ column }) => `${quoted(column)} = ?`)
    .join(', ')} WHERE ${predicate}`;
}

export function writeValues(
  record: object,
  columns: readonly ColumnDefinition[],
): (string | number | bigint | Uint8Array | null)[] {
  const values = record as Record<string, unknown>;
  return columns.map(({ property }) => {
    const value = values[property];
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new RunRepositoryConstraintError(
      `Local SQLite write value ${property} is invalid`,
    );
  });
}

export function requiredString(row: QueryRow, property: string): string {
  return RUN_SQLITE_PERSISTENCE.requiredString(row, property);
}

export function optionalString(
  row: QueryRow,
  property: string,
): string | undefined {
  return RUN_SQLITE_PERSISTENCE.optionalString(row, property);
}

export function requiredInteger(row: QueryRow, property: string): number {
  return RUN_SQLITE_PERSISTENCE.requiredInteger(row, property);
}

export function requiredBlob(row: QueryRow, property: string): Buffer {
  try {
    return RUN_SQLITE_PERSISTENCE.requiredBlob(row, property);
  } catch (error) {
    if (error instanceof RunRepositoryConstraintError) {
      throw new RunRepositoryConstraintError(
        `Local SQLite row has an invalid ${property}`,
      );
    }
    throw error;
  }
}

export function optionalInteger(
  row: QueryRow,
  property: string,
): number | undefined {
  return RUN_SQLITE_PERSISTENCE.optionalInteger(row, property);
}

export function requiredBoolean(row: QueryRow, property: string): boolean {
  return RUN_SQLITE_PERSISTENCE.requiredBoolean(row, property);
}

export function requiredJson(row: QueryRow, property: string): unknown {
  return RUN_SQLITE_PERSISTENCE.requiredJson(row, property);
}

export function requiredEnum<T extends string>(
  row: QueryRow,
  property: string,
  allowed: readonly T[],
): T {
  return RUN_SQLITE_PERSISTENCE.requiredEnum(row, property, allowed);
}

function assignOptional<T extends object, K extends keyof T>(
  record: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) record[key] = value;
}

export function rowToRun(row: QueryRow): RunRecord {
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

export function rowToAttempt(row: QueryRow): RunAttemptRecord {
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
    'workerSessionId',
    optionalString(row, 'workerSessionId'),
  );
  assignOptional(
    attempt,
    'workerGeneration',
    optionalInteger(row, 'workerGeneration'),
  );
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
    'leaseTokenDigest',
    optionalString(row, 'leaseTokenDigest'),
  );
  assignOptional(
    attempt,
    'leaseGeneration',
    optionalInteger(row, 'leaseGeneration'),
  );
  assignOptional(attempt, 'leaseVersion', optionalInteger(row, 'leaseVersion'));
  assignOptional(
    attempt,
    'leaseExpiresAtMs',
    optionalInteger(row, 'leaseExpiresAtMs'),
  );
  assignOptional(attempt, 'offerId', optionalString(row, 'offerId'));
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
        'Local SQLite RunEvent payload is invalid JSON',
        error,
      );
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RunRepositoryConstraintError(
      'Local SQLite RunEvent payload is not a JSON object',
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

export function rowToEvent(row: QueryRow): RunEventRecord {
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

export function rowToRetryPolicy(row: QueryRow): RunRetryPolicyRecord {
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

function sqliteErrorCode(error: unknown): string | undefined {
  return sqliteDriverErrorCode(error);
}

function sqliteErrorNumber(error: unknown): number | undefined {
  return sqliteDriverErrorNumber(error);
}

export function sqliteErrorMessage(error: unknown): string {
  return sqliteDriverErrorMessage(error);
}

export function isSqliteError(error: unknown): boolean {
  return isSqliteDriverError(error);
}

export function mapSqliteError(error: unknown): RunRepositoryError {
  if (error instanceof RunRepositoryError) return error;
  const baseCode = (sqliteErrorNumber(error) ?? 0) & 0xff;
  if (baseCode === 5 || baseCode === 6) {
    return new RunRepositoryBusyError(error);
  }
  if (baseCode === 19 || sqliteErrorCode(error) === 'ERR_SQLITE_CONSTRAINT') {
    return new RunRepositoryConstraintError(
      'Local SQLite Run repository constraint violation',
      error,
    );
  }
  return new RunRepositoryOperationError(error);
}

export function assertEventPayloadSize(event: RunEventRecord): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(event.payload);
  } catch (error) {
    throw new RunRepositoryConstraintError(
      'RunEvent payload is not JSON serializable',
      error,
    );
  }
  if (serialized === undefined) {
    throw new RunRepositoryConstraintError(
      'RunEvent payload is not JSON serializable',
    );
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_RUN_EVENT_PAYLOAD_BYTES) {
    throw new RunEventPayloadTooLargeError(bytes, MAX_RUN_EVENT_PAYLOAD_BYTES);
  }
  return serialized;
}

export function queryRows(
  client: DatabaseSync,
  sql: string,
  values: readonly (string | number | bigint | Uint8Array | null)[] = [],
): QueryRow[] {
  return RUN_SQLITE_PERSISTENCE.queryRows(client, sql, values);
}

export function singleRow(rows: QueryRow[]): QueryRow | null {
  return RUN_SQLITE_PERSISTENCE.singleRow(rows);
}
export const RUN_SELECT = selectColumns(RUN_COLUMNS);
export const ATTEMPT_SELECT = selectColumns(ATTEMPT_COLUMNS);
export const EVENT_SELECT = selectColumns(EVENT_COLUMNS);
export const RETRY_POLICY_SELECT = selectColumns(RETRY_POLICY_COLUMNS);

export const INSERT_RUN_SQL = insertSql('Runs', RUN_COLUMNS);
export const INSERT_ATTEMPT_SQL = insertSql('RunAttempts', ATTEMPT_COLUMNS);
export const INSERT_EVENT_SQL = insertSql('RunEvents', EVENT_COLUMNS);
export const INSERT_RETRY_POLICY_SQL = insertSql(
  'RunRetryPolicies',
  RETRY_POLICY_COLUMNS,
);
export const UPDATE_RUN_SQL = updateSql(
  'Runs',
  RUN_COLUMNS,
  '"id" = ? AND "version" = ?',
);
export const UPDATE_ATTEMPT_SQL = updateSql(
  'RunAttempts',
  ATTEMPT_COLUMNS,
  '"id" = ? AND "status" = ? AND "callback_sequence" = ?',
);
export const UPDATE_RETRY_POLICY_SQL = updateSql(
  'RunRetryPolicies',
  RETRY_POLICY_COLUMNS,
  '"run_id" = ? AND "version" = ?',
);
