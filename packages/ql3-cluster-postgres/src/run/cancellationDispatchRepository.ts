import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  CancellationDispatchBindingConflictError,
  CancellationDispatchError,
  CancellationDispatchFenceRejectedError,
  CancellationDispatchRepositoryError,
  cancellationDispatchResultState,
  digestCancellationDispatchLeaseToken,
  normalizeCancellationDispatchRecord,
  normalizeCancellationDispatchRunId,
  normalizeClaimCancellationDispatchCommand,
  normalizeRecordCancellationDispatchResultCommand,
  type CancellationDispatchRecord,
  type CancellationDispatchRepository,
  type ClaimCancellationDispatchCommand,
  type ClaimCancellationDispatchResult,
  type RecordCancellationDispatchResult,
  type RecordCancellationDispatchResultCommand,
} from '@qinglong/runtime-core/cancellation-dispatch';
import type { RunEventRecord } from '@qinglong/runtime-core/run';

type Row = Record<string, unknown>;

const ACTIVE_RUN_STATUSES = new Set([
  'created',
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'retry_wait',
  'lost',
]);
const ACTIVE_ATTEMPT_STATUSES = new Set(['claimed', 'starting', 'running']);
const CONTROLLER_NOT_INVOKED_RESULTS = new Set([
  'controller_missing',
  'handle_missing',
]);

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new TypeError(`PostgreSQL cancellation dispatch ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const raw = row[key];
  const value =
    typeof raw === 'string' && /^(0|[1-9]\d*)$/u.test(raw)
      ? Number(raw)
      : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`PostgreSQL cancellation dispatch ${key} is invalid`);
  }
  return value;
}

function optionalText(row: Row, key: string): string | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : text(row, key);
}

function optionalInteger(row: Row, key: string): number | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : integer(row, key);
}

function dispatchFromRow(row: Row): Readonly<CancellationDispatchRecord> {
  const nextAttemptAtMs = optionalInteger(row, 'nextAttemptAtMs');
  const leaseOwner = optionalText(row, 'leaseOwner');
  const leaseTokenDigest = optionalText(row, 'leaseTokenDigest');
  const leaseExpiresAtMs = optionalInteger(row, 'leaseExpiresAtMs');
  const lastResult = optionalText(row, 'lastResult');
  const lastDispatchedAtMs = optionalInteger(row, 'lastDispatchedAtMs');
  return normalizeCancellationDispatchRecord({
    runId: text(row, 'runId'),
    attemptId: text(row, 'attemptId'),
    status: text(row, 'status') as CancellationDispatchRecord['status'],
    version: integer(row, 'version'),
    dispatchCount: integer(row, 'dispatchCount'),
    ...(nextAttemptAtMs === undefined ? {} : { nextAttemptAtMs }),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseTokenDigest === undefined ? {} : { leaseTokenDigest }),
    ...(leaseExpiresAtMs === undefined ? {} : { leaseExpiresAtMs }),
    ...(lastResult === undefined
      ? {}
      : {
          lastResult:
            lastResult as NonNullable<CancellationDispatchRecord['lastResult']>,
        }),
    ...(lastDispatchedAtMs === undefined ? {} : { lastDispatchedAtMs }),
    createdAtMs: integer(row, 'createdAtMs'),
    updatedAtMs: integer(row, 'updatedAtMs'),
  });
}

const DISPATCH_COLUMNS = `
  run_id AS "runId", attempt_id AS "attemptId", status,
  version, dispatch_count AS "dispatchCount",
  next_attempt_at_ms AS "nextAttemptAtMs", lease_owner AS "leaseOwner",
  lease_token_digest AS "leaseTokenDigest",
  lease_expires_at_ms AS "leaseExpiresAtMs", last_result AS "lastResult",
  last_dispatched_at_ms AS "lastDispatchedAtMs",
  created_at_ms AS "createdAtMs", updated_at_ms AS "updatedAtMs"
`;

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
    '5000ms',
  ]);
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, ['1000ms']);
  await client.query(
    `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
    ['10000ms'],
  );
}

async function databaseNow(client: PostgresClient): Promise<number> {
  const result = await client.query<Row>(`
    SELECT floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
      AS "nowMs"
  `);
  if (result.rows.length !== 1) {
    throw new TypeError('PostgreSQL cancellation dispatch clock is invalid');
  }
  return integer(result.rows[0]!, 'nowMs');
}

async function rollback(client: PostgresClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the transaction failure.
  }
}

function repositoryFailure(error: unknown): never {
  if (error instanceof CancellationDispatchError) throw error;
  throw new CancellationDispatchRepositoryError(error);
}

export class PostgresCancellationDispatchRepository
  implements CancellationDispatchRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL cancellation dispatch pool is invalid');
    }
  }

  async findByRunId(
    runId: string,
  ): Promise<Readonly<CancellationDispatchRecord> | null> {
    try {
      const normalizedRunId = normalizeCancellationDispatchRunId(runId);
      const result = await this.pool.query<Row>(
        `SELECT ${DISPATCH_COLUMNS}
           FROM "ql3"."run_cancellation_dispatches"
          WHERE run_id = $1`,
        [normalizedRunId],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) {
        throw new TypeError('PostgreSQL cancellation dispatch is not unique');
      }
      return dispatchFromRow(result.rows[0]!);
    } catch (error) {
      return repositoryFailure(error);
    }
  }

  async claim(
    value: Readonly<ClaimCancellationDispatchCommand>,
  ): Promise<ClaimCancellationDispatchResult> {
    const command = normalizeClaimCancellationDispatchCommand(value);
    return this.transaction(async (client) => {
      const nowMs = await databaseNow(client);
      const run = await client.query<Row>(
        `SELECT project_id AS "projectId", execution_owner AS "executionOwner", status,
                cancel_requested_at_ms AS "cancelRequestedAtMs"
           FROM "ql3"."runs" WHERE id = $1 FOR UPDATE`,
        [command.runId],
      );
      if (run.rows.length > 1) {
        throw new TypeError('PostgreSQL cancellation dispatch Run is invalid');
      }
      const attempt = await client.query<Row>(
        `SELECT run_id AS "runId", status
           FROM "ql3"."run_attempts" WHERE id = $1 FOR UPDATE`,
        [command.attemptId],
      );
      if (attempt.rows.length > 1) {
        throw new TypeError(
          'PostgreSQL cancellation dispatch Attempt is invalid',
        );
      }
      const runRow = run.rows[0];
      const attemptRow = attempt.rows[0];
      if (
        !runRow ||
        !attemptRow ||
        runRow.executionOwner !== 'runtime' ||
        !ACTIVE_RUN_STATUSES.has(runRow.status as string) ||
        optionalInteger(runRow, 'cancelRequestedAtMs') !==
          command.requestedAtMs ||
        attemptRow.runId !== command.runId ||
        !ACTIVE_ATTEMPT_STATUSES.has(attemptRow.status as string)
      ) {
        return Object.freeze({ status: 'not_eligible' as const });
      }

      let dispatchResult = await client.query<Row>(
        `SELECT ${DISPATCH_COLUMNS}
           FROM "ql3"."run_cancellation_dispatches"
          WHERE run_id = $1 FOR UPDATE`,
        [command.runId],
      );
      if (dispatchResult.rows.length === 0) {
        dispatchResult = await client.query<Row>(
          `INSERT INTO "ql3"."run_cancellation_dispatches" (
             project_id, run_id, attempt_id, status, version, dispatch_count,
             next_attempt_at_ms, created_at_ms, updated_at_ms
           ) VALUES ($5, $1, $2, 'pending', 0, 0, $3, $4, $4)
           RETURNING ${DISPATCH_COLUMNS}`,
          [
            command.runId,
            command.attemptId,
            command.requestedAtMs,
            nowMs,
            text(runRow, 'projectId'),
          ],
        );
      }
      if (dispatchResult.rows.length !== 1) {
        throw new TypeError('PostgreSQL cancellation dispatch is invalid');
      }
      const current = dispatchFromRow(dispatchResult.rows[0]!);
      if (current.attemptId !== command.attemptId) {
        throw new CancellationDispatchBindingConflictError(
          command.runId,
          command.attemptId,
        );
      }
      if (current.status === 'dispatched' || current.status === 'blocked') {
        return Object.freeze({ status: current.status, dispatch: current });
      }
      if (
        current.status === 'leased' &&
        current.leaseExpiresAtMs! > nowMs
      ) {
        return Object.freeze({ status: 'leased' as const, dispatch: current });
      }
      if (
        current.status !== 'leased' &&
        current.nextAttemptAtMs! > nowMs
      ) {
        return Object.freeze({ status: 'not_due' as const, dispatch: current });
      }
      if (
        current.version >= 2_147_483_647 ||
        current.dispatchCount >= 2_147_483_647
      ) {
        throw new TypeError('PostgreSQL cancellation dispatch counter overflowed');
      }
      const leaseExpiresAtMs = nowMs + command.leaseDurationMs;
      if (!Number.isSafeInteger(leaseExpiresAtMs)) {
        throw new TypeError('PostgreSQL cancellation dispatch lease overflowed');
      }
      const leaseTokenDigest = digestCancellationDispatchLeaseToken(
        command.leaseToken,
      );
      const claimed = await client.query<Row>(
        `UPDATE "ql3"."run_cancellation_dispatches"
            SET status = 'leased', version = version + 1,
                dispatch_count = dispatch_count + 1,
                next_attempt_at_ms = NULL, lease_owner = $3,
                lease_token_digest = $4, lease_expires_at_ms = $5,
                updated_at_ms = $6
          WHERE run_id = $1 AND attempt_id = $2 AND version = $7
          RETURNING ${DISPATCH_COLUMNS}`,
        [
          command.runId,
          command.attemptId,
          command.owner,
          leaseTokenDigest,
          leaseExpiresAtMs,
          nowMs,
          current.version,
        ],
      );
      if (claimed.rows.length !== 1) {
        throw new CancellationDispatchFenceRejectedError(command.runId);
      }
      return Object.freeze({
        status: 'claimed' as const,
        dispatch: dispatchFromRow(claimed.rows[0]!),
        leaseToken: command.leaseToken,
      });
    });
  }

  async recordResult(
    value: Readonly<RecordCancellationDispatchResultCommand>,
  ): Promise<Readonly<RecordCancellationDispatchResult>> {
    const command = normalizeRecordCancellationDispatchResultCommand(value);
    return this.transaction(async (client) => {
      const atMs = await databaseNow(client);
      const run = await client.query<Row>(
        `SELECT version, event_sequence AS "eventSequence"
           FROM "ql3"."runs" WHERE id = $1 FOR UPDATE`,
        [command.runId],
      );
      if (run.rows.length !== 1) {
        throw new TypeError(
          'PostgreSQL cancellation dispatch Run disappeared',
        );
      }
      const dispatchResult = await client.query<Row>(
        `SELECT ${DISPATCH_COLUMNS}
           FROM "ql3"."run_cancellation_dispatches"
          WHERE run_id = $1 FOR UPDATE`,
        [command.runId],
      );
      if (dispatchResult.rows.length !== 1) {
        throw new CancellationDispatchFenceRejectedError(command.runId);
      }
      const current = dispatchFromRow(dispatchResult.rows[0]!);
      if (
        current.attemptId !== command.attemptId ||
        current.status !== 'leased' ||
        current.version !== command.expectedVersion ||
        current.leaseOwner !== command.owner ||
        current.leaseTokenDigest !==
          digestCancellationDispatchLeaseToken(command.leaseToken)
      ) {
        throw new CancellationDispatchFenceRejectedError(command.runId);
      }
      const runVersion = integer(run.rows[0]!, 'version');
      const eventSequence = integer(run.rows[0]!, 'eventSequence');
      if (
        current.version >= 2_147_483_647 ||
        runVersion >= 2_147_483_647 ||
        eventSequence >= 2_147_483_647
      ) {
        throw new TypeError('PostgreSQL cancellation dispatch counter overflowed');
      }
      const nextAttemptAtMs =
        command.retryDelayMs === undefined
          ? undefined
          : atMs + command.retryDelayMs;
      if (
        nextAttemptAtMs !== undefined &&
        !Number.isSafeInteger(nextAttemptAtMs)
      ) {
        throw new TypeError('PostgreSQL cancellation dispatch retry overflowed');
      }
      const state = cancellationDispatchResultState(command.result);
      const nextSequence = eventSequence + 1;
      const runUpdated = await client.query(
        `UPDATE "ql3"."runs"
            SET version = version + 1, event_sequence = $2
          WHERE id = $1 AND version = $3`,
        [command.runId, nextSequence, runVersion],
      );
      if (runUpdated.rowCount !== 1) {
        throw new CancellationDispatchFenceRejectedError(command.runId);
      }
      const dispatchUpdated = await client.query<Row>(
        `UPDATE "ql3"."run_cancellation_dispatches"
            SET status = $6, version = version + 1,
                next_attempt_at_ms = $7, lease_owner = NULL,
                lease_token_digest = NULL, lease_expires_at_ms = NULL,
                last_result = $8,
                last_dispatched_at_ms = CASE
                  WHEN $9::boolean THEN last_dispatched_at_ms ELSE $10 END,
                updated_at_ms = $10
          WHERE run_id = $1 AND attempt_id = $2 AND status = 'leased'
            AND version = $3 AND lease_owner = $4
            AND lease_token_digest = $5
          RETURNING ${DISPATCH_COLUMNS}`,
        [
          command.runId,
          command.attemptId,
          command.expectedVersion,
          command.owner,
          current.leaseTokenDigest,
          state.status,
          nextAttemptAtMs ?? null,
          command.result,
          CONTROLLER_NOT_INVOKED_RESULTS.has(command.result),
          atMs,
        ],
      );
      if (dispatchUpdated.rows.length !== 1) {
        throw new CancellationDispatchFenceRejectedError(command.runId);
      }
      const event: Readonly<RunEventRecord> = Object.freeze({
        id: command.eventId,
        runId: command.runId,
        sequence: nextSequence,
        type: state.eventType,
        dedupeKey: `cancel-dispatch:${command.attemptId}:${current.dispatchCount}`,
        actorType: 'worker',
        actorId: command.owner,
        attemptId: command.attemptId,
        payload: Object.freeze({
          attempt_id: command.attemptId,
          dispatch_count: current.dispatchCount,
          result: command.result,
        }),
        createdAtMs: atMs,
      });
      await client.query(
        `INSERT INTO "ql3"."run_events" (
           id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
           attempt_id, step_run_id, payload, created_at_ms
         ) VALUES ($1, $2, $3, $4, $5, 'worker', $6, $7, NULL, $8::jsonb, $9)`,
        [
          event.id,
          event.runId,
          event.sequence,
          event.type,
          event.dedupeKey,
          event.actorId,
          event.attemptId,
          JSON.stringify(event.payload),
          event.createdAtMs,
        ],
      );
      return Object.freeze({
        dispatch: dispatchFromRow(dispatchUpdated.rows[0]!),
        event,
      });
    });
  }

  private async transaction<T>(
    operation: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    let client: PostgresClient | undefined;
    try {
      client = await this.pool.connect();
      await begin(client);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await rollback(client);
      return repositoryFailure(error);
    } finally {
      client?.release();
    }
  }
}
