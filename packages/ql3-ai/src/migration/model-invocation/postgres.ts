import type { PostgresPool, PostgresQueryable } from '@qinglong/runtime-core';
import {
  MigrationStreamHistoryCorruptionError,
  runMigrationStream,
  type MigrationStreamDefinition,
  type MigrationStreamRecord,
  type MigrationStreamStore,
  type MigrationStreamTransaction,
} from '@qinglong/runtime-core/migration-stream';

import {
  POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID,
  POSTGRES_MODEL_INVOCATION_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_USAGE_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_PRICING_MIGRATION_ID,
  POSTGRES_MODEL_PRICE_CATALOG_MIGRATION_ID,
  POSTGRES_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_TEST_CONNECTION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_PRODUCT_AUTHORIZATION_MIGRATION_ID,
  POSTGRES_COPILOT_FAILURE_DIAGNOSIS_ADMISSION_MIGRATION_ID,
  POSTGRES_COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_MIGRATION_ID,
  POSTGRES_COPILOT_FAILURE_DIAGNOSIS_MODEL_EXECUTION_MIGRATION_ID,
  POSTGRES_COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_SCHEMA,
  POSTGRES_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE,
} from './identities';

import { postgresCatalogMigrations } from './postgres/catalog';
import { postgresCopilotMigrations } from './postgres/copilot';
import { postgresCoreMigrations } from './postgres/core';
import { postgresCredentialMigrations } from './postgres/credential';
import {
  postgresPromptBaseMigrations,
  postgresPromptExtensionMigrations,
} from './postgres/prompt';
import { postgresUsagePricingMigrations } from './postgres/usagePricing';
import { historyRecord, type HistoryRow } from './shared';

const POSTGRES_HISTORY_IDENTITY = Object.freeze({
  migrationIds: Object.freeze([
    POSTGRES_MODEL_INVOCATION_MIGRATION_ID,
    POSTGRES_MODEL_INVOCATION_USAGE_MIGRATION_ID,
    POSTGRES_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
    POSTGRES_MODEL_INVOCATION_PRICING_MIGRATION_ID,
    POSTGRES_MODEL_PRICE_CATALOG_MIGRATION_ID,
    POSTGRES_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
    POSTGRES_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
    POSTGRES_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
    POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
    POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
    POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
    POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_MIGRATION_ID,
    POSTGRES_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
    POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_MIGRATION_ID,
    POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_MIGRATION_ID,
    POSTGRES_MODEL_PROVIDER_CREDENTIAL_TEST_CONNECTION_MIGRATION_ID,
    POSTGRES_PLUGIN_PACKAGE_PROMPT_PRODUCT_AUTHORIZATION_MIGRATION_ID,
    POSTGRES_COPILOT_FAILURE_DIAGNOSIS_ADMISSION_MIGRATION_ID,
    POSTGRES_COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_MIGRATION_ID,
    POSTGRES_COPILOT_FAILURE_DIAGNOSIS_MODEL_EXECUTION_MIGRATION_ID,
    POSTGRES_COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_MIGRATION_ID,
  ]),
  streamId: POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID,
  dialect: 'postgresql' as const,
});

async function readPostgresHistory(
  queryable: PostgresQueryable,
  migrationId?: string,
): Promise<readonly MigrationStreamRecord[]> {
  const result = await queryable.query<HistoryRow>(
    `SELECT
       migration_id AS "migrationId",
     stream_id AS "streamId",
     dialect,
     checksum,
     applied_at_ms AS "appliedAtMs"
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${POSTGRES_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}"
     WHERE stream_id = $1
       ${migrationId === undefined ? '' : 'AND migration_id = $2'}
     ORDER BY migration_id`,
    migrationId === undefined
      ? [POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID]
      : [POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID, migrationId],
  );
  return result.rows.map((row) =>
    historyRecord(row, POSTGRES_HISTORY_IDENTITY),
  );
}

class PostgresModelInvocationMigrationStore
  implements MigrationStreamStore<PostgresQueryable>
{
  constructor(private readonly pool: PostgresPool) {}

  async ensureHistory(): Promise<void> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT
         to_regclass('ql3.schema_migrations') IS NOT NULL AS history,
         to_regclass('ql3.runs') IS NOT NULL AS runs,
         to_regclass('ql3.run_events') IS NOT NULL AS events,
         to_regclass('ql3.step_runs') IS NOT NULL AS steps,
         to_regclass('ql3.step_run_mutations') IS NOT NULL AS mutations`,
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      row?.history !== true ||
      row.runs !== true ||
      row.events !== true ||
      row.steps !== true ||
      row.mutations !== true
    ) {
      throw new TypeError(
        'PostgreSQL ModelInvocation feature requires the main migration stream',
      );
    }
    await this.pool.query(
      `CREATE SCHEMA IF NOT EXISTS "${POSTGRES_MODEL_INVOCATION_SCHEMA}"`,
    );
    await this.pool.query(
      `REVOKE ALL ON SCHEMA "${POSTGRES_MODEL_INVOCATION_SCHEMA}" FROM PUBLIC`,
    );
    await this.pool.query(`
CREATE TABLE IF NOT EXISTS "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${POSTGRES_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}" (
  migration_id varchar(128) PRIMARY KEY,
  stream_id varchar(64) NOT NULL
    CONSTRAINT ql3_ai_schema_migrations_stream_check
    CHECK (stream_id = '${POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID}'),
  dialect varchar(16) NOT NULL
    CONSTRAINT ql3_ai_schema_migrations_dialect_check
    CHECK (dialect = 'postgresql'),
  checksum char(64) NOT NULL
    CONSTRAINT ql3_ai_schema_migrations_checksum_check
    CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at_ms bigint NOT NULL
    CONSTRAINT ql3_ai_schema_migrations_applied_at_check
    CHECK (applied_at_ms >= 0)
)
    `);
    await this.pool.query(
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${POSTGRES_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}"
       FROM PUBLIC`,
    );
  }

  async listAll(): Promise<readonly MigrationStreamRecord[]> {
    return readPostgresHistory(this.pool);
  }

  async findById(migrationId: string): Promise<MigrationStreamRecord | null> {
    const rows = await readPostgresHistory(this.pool, migrationId);
    if (rows.length > 1) {
      throw new MigrationStreamHistoryCorruptionError(migrationId);
    }
    return rows[0] ?? null;
  }

  async transaction<T>(
    work: (
      transaction: MigrationStreamTransaction<PostgresQueryable>,
    ) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
        '15s',
      ]);
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, ['5s']);
      await client.query(
        `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
        ['15s'],
      );
      await client.query(
        'SELECT pg_advisory_xact_lock($1, $2)',
        [0x514c, 0x0301],
      );
      const result = await work({
        context: client,
        findById: async (migrationId) => {
          const rows = await readPostgresHistory(client, migrationId);
          return rows[0] ?? null;
        },
        insert: async (record) => {
          if (
            record.streamId !== POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID ||
            !POSTGRES_HISTORY_IDENTITY.migrationIds.includes(
              record.migrationId,
            ) ||
            record.dialect !== 'postgresql'
          ) {
            throw new TypeError(
              'PostgreSQL ModelInvocation migration identity is invalid',
            );
          }
          await client.query(
            `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."${POSTGRES_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}"
             (migration_id, stream_id, dialect, checksum, applied_at_ms)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              record.migrationId,
              record.streamId,
              record.dialect,
              record.checksum,
              record.appliedAtMs,
            ],
          );
        },
      });
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the migration failure.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export const postgresModelInvocationMigrationDefinition: MigrationStreamDefinition<PostgresQueryable> =
  Object.freeze({
    id: POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID,
    dialect: 'postgresql',
    migrationIdScheme: 'postgres-prefixed',
    checksumScheme: 'sha256',
    migrations: Object.freeze([
      ...postgresCoreMigrations,
      ...postgresUsagePricingMigrations,
      ...postgresCatalogMigrations,
      ...postgresPromptBaseMigrations,
      ...postgresCredentialMigrations,
      ...postgresPromptExtensionMigrations,
      ...postgresCopilotMigrations,
    ]),
  });

export async function migratePostgresModelInvocationFeature(
  pool: PostgresPool,
): Promise<void> {
  await runMigrationStream({
    stream: postgresModelInvocationMigrationDefinition,
    store: new PostgresModelInvocationMigrationStore(pool),
  });
}
