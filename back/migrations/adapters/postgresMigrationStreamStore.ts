import {
  MigrationStreamHistoryCorruptionError,
  type MigrationStreamRecord,
  type MigrationStreamStore,
  type MigrationStreamTransaction,
} from '../core/migrationStream';
import type {
  PostgresClient as PostgresMigrationClient,
  PostgresPool as PostgresMigrationPool,
  PostgresQueryable as PostgresMigrationQueryable,
  PostgresQueryResult as PostgresMigrationQueryResult,
} from '@qinglong/runtime-core';

export type {
  PostgresClient as PostgresMigrationClient,
  PostgresPool as PostgresMigrationPool,
  PostgresQueryable as PostgresMigrationQueryable,
  PostgresQueryResult as PostgresMigrationQueryResult,
} from '@qinglong/runtime-core';

export const POSTGRESQL_MAIN_MIGRATION_STREAM_ID = 'postgresql-main';
export const POSTGRESQL_MIGRATION_SCHEMA = 'ql3';
export const POSTGRESQL_MIGRATION_HISTORY_TABLE = 'schema_migrations';

const POSTGRESQL_MIGRATION_LOCK_KEY = [0x514c, 0x0300] as const;
const POSTGRESQL_MIGRATION_STATEMENT_TIMEOUT_MS = 15_000;
const POSTGRESQL_MIGRATION_LOCK_TIMEOUT_MS = 5_000;
const POSTGRESQL_MIGRATION_IDLE_TRANSACTION_TIMEOUT_MS = 15_000;

export type PostgresMigrationContext = PostgresMigrationQueryable;

export class PostgresMigrationLeaderUnavailableError extends Error {
  constructor() {
    super('PostgreSQL migration leader lock is unavailable');
    this.name = 'PostgresMigrationLeaderUnavailableError';
  }
}

interface HistoryRow extends Record<string, unknown> {
  streamId: unknown;
  dialect: unknown;
  migrationId: unknown;
  checksum: unknown;
  appliedAtMs: unknown;
}

interface AdvisoryLockRow extends Record<string, unknown> {
  acquired: unknown;
}

const CREATE_HISTORY_SQL = `
CREATE TABLE IF NOT EXISTS "${POSTGRESQL_MIGRATION_SCHEMA}"."${POSTGRESQL_MIGRATION_HISTORY_TABLE}" (
  migration_id varchar(128) PRIMARY KEY,
  stream_id varchar(64) NOT NULL,
  dialect varchar(16) NOT NULL
    CONSTRAINT ql3_schema_migrations_dialect_check
    CHECK (dialect = 'postgresql'),
  checksum char(64) NOT NULL
    CONSTRAINT ql3_schema_migrations_checksum_check
    CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at_ms bigint NOT NULL
    CONSTRAINT ql3_schema_migrations_applied_at_check
    CHECK (applied_at_ms >= 0)
)`.trim();

const SELECT_HISTORY_SQL = `
SELECT
  stream_id AS "streamId",
  dialect,
  migration_id AS "migrationId",
  checksum,
  applied_at_ms AS "appliedAtMs"
FROM "${POSTGRESQL_MIGRATION_SCHEMA}"."${POSTGRESQL_MIGRATION_HISTORY_TABLE}"
WHERE migration_id = $1
`.trim();

const SELECT_ALL_HISTORY_SQL = `
SELECT
  stream_id AS "streamId",
  dialect,
  migration_id AS "migrationId",
  checksum,
  applied_at_ms AS "appliedAtMs"
FROM "${POSTGRESQL_MIGRATION_SCHEMA}"."${POSTGRESQL_MIGRATION_HISTORY_TABLE}"
ORDER BY applied_at_ms, migration_id
`.trim();

const INSERT_HISTORY_SQL = `
INSERT INTO "${POSTGRESQL_MIGRATION_SCHEMA}"."${POSTGRESQL_MIGRATION_HISTORY_TABLE}" (
  migration_id,
  stream_id,
  dialect,
  checksum,
  applied_at_ms
)
VALUES ($1, $2, $3, $4, $5)
`.trim();

function parseAppliedAtMs(value: unknown, migrationId: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new MigrationStreamHistoryCorruptionError(migrationId);
}

async function findHistoryRecord(
  queryable: PostgresMigrationQueryable,
  migrationId: string,
): Promise<MigrationStreamRecord | null> {
  const result = await queryable.query<HistoryRow>(SELECT_HISTORY_SQL, [
    migrationId,
  ]);
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) {
    throw new MigrationStreamHistoryCorruptionError(migrationId);
  }
  const row = result.rows[0];
  if (!row) {
    throw new MigrationStreamHistoryCorruptionError(migrationId);
  }
  return {
    streamId: row.streamId as string,
    dialect: row.dialect as 'postgresql',
    migrationId: row.migrationId as string,
    checksum: row.checksum as string,
    appliedAtMs: parseAppliedAtMs(row.appliedAtMs, migrationId),
  };
}

export async function readPostgresMigrationHistory(
  queryable: PostgresMigrationQueryable,
): Promise<readonly MigrationStreamRecord[]> {
  const result = await queryable.query<HistoryRow>(SELECT_ALL_HISTORY_SQL);
  return result.rows.map((row) => ({
    streamId: row.streamId as string,
    dialect: row.dialect as 'postgresql',
    migrationId: row.migrationId as string,
    checksum: row.checksum as string,
    appliedAtMs: parseAppliedAtMs(
      row.appliedAtMs,
      typeof row.migrationId === 'string' ? row.migrationId : 'unknown',
    ),
  }));
}

async function configureTransaction(
  client: PostgresMigrationClient,
): Promise<void> {
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
    `${POSTGRESQL_MIGRATION_STATEMENT_TIMEOUT_MS}ms`,
  ]);
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, [
    `${POSTGRESQL_MIGRATION_LOCK_TIMEOUT_MS}ms`,
  ]);
  await client.query(
    `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
    [`${POSTGRESQL_MIGRATION_IDLE_TRANSACTION_TIMEOUT_MS}ms`],
  );
}

async function acquireLeaderLock(
  client: PostgresMigrationClient,
): Promise<void> {
  const result = await client.query<AdvisoryLockRow>(
    'SELECT pg_try_advisory_xact_lock($1, $2) AS acquired',
    POSTGRESQL_MIGRATION_LOCK_KEY,
  );
  if (result.rows.length !== 1 || result.rows[0]?.acquired !== true) {
    throw new PostgresMigrationLeaderUnavailableError();
  }
}

/**
 * PostgreSQL migration history adapter without a runtime dependency on `pg`.
 * The cluster-only package owns the concrete Pool binding; edge and standalone
 * builds can compile this contract without installing or importing the driver.
 */
export class PostgresMigrationStreamStore
  implements MigrationStreamStore<PostgresMigrationContext>
{
  constructor(private readonly pool: PostgresMigrationPool) {}

  async ensureHistory(): Promise<void> {
    await this.withLeaderTransaction(async (client) => {
      await client.query(
        `CREATE SCHEMA IF NOT EXISTS "${POSTGRESQL_MIGRATION_SCHEMA}"`,
      );
      await client.query(CREATE_HISTORY_SQL);
    });
  }

  async findById(migrationId: string): Promise<MigrationStreamRecord | null> {
    return findHistoryRecord(this.pool, migrationId);
  }

  async listAll(): Promise<readonly MigrationStreamRecord[]> {
    return readPostgresMigrationHistory(this.pool);
  }

  async transaction<T>(
    work: (
      transaction: MigrationStreamTransaction<PostgresMigrationContext>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.withLeaderTransaction(async (client) =>
      work({
        context: client,
        findById: (migrationId) => findHistoryRecord(client, migrationId),
        insert: async (record) => {
          if (
            record.streamId !== POSTGRESQL_MAIN_MIGRATION_STREAM_ID ||
            record.dialect !== 'postgresql'
          ) {
            throw new TypeError(
              'PostgreSQL migration history record has the wrong stream or dialect',
            );
          }
          await client.query(INSERT_HISTORY_SQL, [
            record.migrationId,
            record.streamId,
            record.dialect,
            record.checksum,
            record.appliedAtMs,
          ]);
        },
      }),
    );
  }

  private async withLeaderTransaction<T>(
    work: (client: PostgresMigrationClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await configureTransaction(client);
      await acquireLeaderLock(client);
      const result = await work(client);
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the migration error. A broken connection is discarded by
          // the concrete driver when release() runs.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
