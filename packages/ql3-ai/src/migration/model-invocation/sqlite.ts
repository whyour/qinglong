import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  MigrationStreamHistoryCorruptionError,
  auditMigrationStreamHistory,
  runMigrationStream,
  type MigrationStreamDefinition,
  type MigrationStreamRecord,
  type MigrationStreamStore,
  type MigrationStreamTransaction,
} from '@qinglong/runtime-core/migration-stream';

import {
  LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
  LOCAL_MODEL_INVOCATION_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_USAGE_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_PRICING_MIGRATION_ID,
  LOCAL_MODEL_PRICE_CATALOG_MIGRATION_ID,
  LOCAL_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_FEATURE_ACTIVATION_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
  LOCAL_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE,
} from './identities';

import { historyRecord, type HistoryRow } from './shared';
import { sqliteCatalogMigrations } from './sqlite/catalog';
import type { LocalMigrationContext } from './sqlite/context';
import { sqliteCoreMigrations } from './sqlite/core';
import { sqliteCredentialMigrations } from './sqlite/credential';
import { sqlitePromptMigrations } from './sqlite/prompt';
import { sqliteUsagePricingMigrations } from './sqlite/usagePricing';

const LOCAL_HISTORY_IDENTITY = Object.freeze({
  migrationIds: Object.freeze([
    LOCAL_MODEL_INVOCATION_MIGRATION_ID,
    LOCAL_MODEL_INVOCATION_USAGE_MIGRATION_ID,
    LOCAL_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
    LOCAL_MODEL_INVOCATION_PRICING_MIGRATION_ID,
    LOCAL_MODEL_PRICE_CATALOG_MIGRATION_ID,
    LOCAL_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
    LOCAL_MODEL_INVOCATION_FEATURE_ACTIVATION_MIGRATION_ID,
    LOCAL_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
    LOCAL_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
    LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
    LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
    LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
    LOCAL_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
  ]),
  streamId: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
  dialect: 'sqlite' as const,
});

function readLocalHistory(
  client: DatabaseSync,
  migrationId?: string,
): readonly MigrationStreamRecord[] {
  const rows = client
    .prepare(
      `SELECT
         migration_id AS "migrationId",
       stream_id AS "streamId",
       dialect,
       checksum,
       applied_at_ms AS "appliedAtMs"
       FROM "${LOCAL_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}"
       WHERE stream_id = ?
         ${migrationId === undefined ? '' : 'AND migration_id = ?'}
       ORDER BY migration_id`,
    )
    .all(
      LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      ...(migrationId === undefined ? [] : [migrationId]),
    ) as unknown as HistoryRow[];
  return rows.map((row) => historyRecord(row, LOCAL_HISTORY_IDENTITY));
}

class LocalModelInvocationMigrationStore
  implements MigrationStreamStore<LocalMigrationContext>
{
  constructor(private readonly client: DatabaseSync) {}

  async ensureHistory(): Promise<void> {
    const required = [
      'QingLong3SchemaMigrations',
      'Runs',
      'RunEvents',
      'StepRuns',
      'StepRunMutations',
    ];
    const rows = this.client
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name IN (${required
           .map(() => '?')
           .join(', ')})`,
      )
      .all(...required) as unknown as { name?: unknown }[];
    const names = new Set(
      rows
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string'),
    );
    if (required.some((name) => !names.has(name))) {
      throw new TypeError(
        'Local ModelInvocation feature requires the main SQLite migration stream',
      );
    }
    this.client.exec(`
CREATE TABLE IF NOT EXISTS "${LOCAL_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}" (
  migration_id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL
    CONSTRAINT ql3_ai_migrations_stream_check
    CHECK (stream_id = '${LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID}'),
  dialect TEXT NOT NULL
    CONSTRAINT ql3_ai_migrations_dialect_check CHECK (dialect = 'sqlite'),
  checksum TEXT NOT NULL
    CONSTRAINT ql3_ai_migrations_checksum_check
    CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  applied_at_ms INTEGER NOT NULL
    CONSTRAINT ql3_ai_migrations_applied_at_check CHECK (applied_at_ms >= 0)
)
    `);
  }

  async listAll(): Promise<readonly MigrationStreamRecord[]> {
    return readLocalHistory(this.client);
  }

  async findById(migrationId: string): Promise<MigrationStreamRecord | null> {
    const rows = readLocalHistory(this.client, migrationId);
    if (rows.length > 1) {
      throw new MigrationStreamHistoryCorruptionError(migrationId);
    }
    return rows[0] ?? null;
  }

  async transaction<T>(
    work: (
      transaction: MigrationStreamTransaction<LocalMigrationContext>,
    ) => Promise<T>,
  ): Promise<T> {
    this.client.exec('BEGIN IMMEDIATE');
    try {
      const result = await work({
        context: { client: this.client },
        findById: (migrationId) => this.findById(migrationId),
        insert: async (record) => {
          if (
            record.streamId !== LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID ||
            !LOCAL_HISTORY_IDENTITY.migrationIds.includes(record.migrationId) ||
            record.dialect !== 'sqlite'
          ) {
            throw new TypeError(
              'Local ModelInvocation migration identity is invalid',
            );
          }
          this.client
            .prepare(
              `INSERT INTO "${LOCAL_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE}"
               (migration_id, stream_id, dialect, checksum, applied_at_ms)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              record.migrationId,
              record.streamId,
              record.dialect,
              record.checksum,
              record.appliedAtMs,
            );
        },
      });
      this.client.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.client.isTransaction) this.client.exec('ROLLBACK');
      throw error;
    }
  }
}

export const localModelInvocationMigrationDefinition: MigrationStreamDefinition<LocalMigrationContext> =
  Object.freeze({
    id: LOCAL_MODEL_INVOCATION_MIGRATION_STREAM_ID,
    dialect: 'sqlite',
    migrationIdScheme: 'sqlite-numbered',
    checksumScheme: 'sha256',
    migrations: Object.freeze([
      ...sqliteCoreMigrations,
      ...sqliteUsagePricingMigrations,
      ...sqliteCatalogMigrations,
      ...sqlitePromptMigrations,
      ...sqliteCredentialMigrations,
    ]),
  });

export const LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST = createHash('sha256')
  .update(
    Buffer.from('qinglong/local-model-invocation-migration-plan@v1\0', 'utf8'),
  )
  .update(
    JSON.stringify(
      localModelInvocationMigrationDefinition.migrations.map(
        ({ id, checksum: migrationChecksum }) => ({
          id,
          checksum: migrationChecksum,
        }),
      ),
    ),
    'utf8',
  )
  .digest('hex');

export class LocalModelInvocationFeatureNotReadyError extends Error {
  readonly code = 'LOCAL_MODEL_INVOCATION_FEATURE_NOT_READY';

  constructor(options?: ErrorOptions) {
    super('The local ModelInvocation feature schema is not ready', options);
    this.name = 'LocalModelInvocationFeatureNotReadyError';
  }
}

const LOCAL_MODEL_INVOCATION_FEATURE_TABLES = Object.freeze([
  'ModelInvocationCompletions',
  'ModelInvocationFeatureHead',
  'ModelInvocationFeatureTransitions',
  'ModelInvocationPriceQuotes',
  'ModelInvocationPriceSettlements',
  'ModelInvocationPromptAdmissions',
  'ModelInvocationPromptFinalizations',
  'ModelInvocationPromptOutputArtifactTombstones',
  'ModelInvocationPromptOutputArtifacts',
  'ModelInvocationPromptOutputKeyRetirementCompletions',
  'ModelInvocationPromptOutputKeyRetirementPreparations',
  'ModelInvocationProviderCredentialAudits',
  'ModelInvocationProviderCredentialBindings',
  'ModelInvocationProviderCredentialTransitions',
  'ModelInvocationQuotaReservations',
  'ModelInvocationQuotaSettlements',
  'ModelInvocationResolutions',
  'ModelInvocationStarts',
  'ModelInvocationUsageLedger',
  'ModelPriceCatalogAuthorizations',
  'ModelPriceCatalogHeads',
  'ModelPriceCatalogPublications',
  LOCAL_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE,
]);

export function assertLocalModelInvocationFeatureReady(
  client: DatabaseSync,
): void {
  try {
    if (
      !client ||
      typeof client !== 'object' ||
      !client.isOpen ||
      typeof client.prepare !== 'function'
    ) {
      throw new LocalModelInvocationFeatureNotReadyError();
    }
    const tables = (
      client
        .prepare(
          `SELECT name
             FROM sqlite_schema
            WHERE type = 'table'
              AND (
                name = ?
                OR name LIKE 'ModelInvocation%'
                OR name LIKE 'ModelPriceCatalog%'
              )
            ORDER BY name`,
        )
        .all(LOCAL_MODEL_INVOCATION_MIGRATION_HISTORY_TABLE) as {
        readonly name?: unknown;
      }[]
    ).map(({ name }) => name);
    if (
      tables.length !== LOCAL_MODEL_INVOCATION_FEATURE_TABLES.length ||
      tables.some(
        (table, index) =>
          table !== LOCAL_MODEL_INVOCATION_FEATURE_TABLES[index],
      )
    ) {
      throw new LocalModelInvocationFeatureNotReadyError();
    }
    const applied = auditMigrationStreamHistory(
      readLocalHistory(client),
      localModelInvocationMigrationDefinition,
    );
    if (
      applied.size !== localModelInvocationMigrationDefinition.migrations.length
    ) {
      throw new LocalModelInvocationFeatureNotReadyError();
    }
  } catch (error) {
    if (error instanceof LocalModelInvocationFeatureNotReadyError) {
      throw error;
    }
    throw new LocalModelInvocationFeatureNotReadyError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}

export async function migrateLocalModelInvocationFeature(
  client: DatabaseSync,
): Promise<void> {
  await runMigrationStream({
    stream: localModelInvocationMigrationDefinition,
    store: new LocalModelInvocationMigrationStore(client),
  });
}
