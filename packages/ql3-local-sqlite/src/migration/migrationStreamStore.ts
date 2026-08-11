import type {
  MigrationStreamRecord,
  MigrationStreamStore,
  MigrationStreamTransaction,
} from '@qinglong/runtime-core/migration-stream';
import type { DatabaseSync } from 'node:sqlite';
import type { LocalSqliteMigrationContext } from '../migrations/sqlMigration';

export const LOCAL_SQLITE_MIGRATION_STREAM_ID = 'ql3-local-sqlite';

interface HistoryRow {
  migration_id: unknown;
  stream_id: unknown;
  dialect: unknown;
  checksum: unknown;
  applied_at_ms: unknown;
}

function record(row: HistoryRow): MigrationStreamRecord {
  if (
    typeof row.migration_id !== 'string' ||
    typeof row.stream_id !== 'string' ||
    row.dialect !== 'sqlite' ||
    typeof row.checksum !== 'string' ||
    typeof row.applied_at_ms !== 'number' ||
    !Number.isSafeInteger(row.applied_at_ms) ||
    row.applied_at_ms < 0
  ) {
    throw new TypeError('Local SQLite migration history row is invalid');
  }
  return {
    migrationId: row.migration_id,
    streamId: row.stream_id,
    dialect: row.dialect,
    checksum: row.checksum,
    appliedAtMs: row.applied_at_ms,
  };
}

export class LocalSqliteMigrationStreamStore
  implements MigrationStreamStore<LocalSqliteMigrationContext>
{
  constructor(private readonly client: DatabaseSync) {}

  async ensureHistory(): Promise<void> {
    this.client.exec(`
CREATE TABLE IF NOT EXISTS "QingLong3SchemaMigrations" (
  migration_id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  dialect TEXT NOT NULL
    CONSTRAINT ql3_local_migrations_dialect_check CHECK (dialect = 'sqlite'),
  checksum TEXT NOT NULL
    CONSTRAINT ql3_local_migrations_checksum_check
    CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  applied_at_ms INTEGER NOT NULL
    CONSTRAINT ql3_local_migrations_applied_at_check CHECK (applied_at_ms >= 0)
)
    `);
  }

  async listAll(): Promise<readonly MigrationStreamRecord[]> {
    return (
      this.client
        .prepare(
          `SELECT migration_id, stream_id, dialect, checksum, applied_at_ms
           FROM "QingLong3SchemaMigrations"
           ORDER BY migration_id`,
        )
        .all() as unknown as HistoryRow[]
    ).map(record);
  }

  async findById(
    migrationId: string,
  ): Promise<MigrationStreamRecord | null> {
    const row = this.client
      .prepare(
        `SELECT migration_id, stream_id, dialect, checksum, applied_at_ms
         FROM "QingLong3SchemaMigrations"
         WHERE migration_id = ?`,
      )
      .get(migrationId) as HistoryRow | undefined;
    return row ? record(row) : null;
  }

  async transaction<T>(
    work: (
      transaction: MigrationStreamTransaction<LocalSqliteMigrationContext>,
    ) => Promise<T>,
  ): Promise<T> {
    this.client.exec('BEGIN IMMEDIATE');
    try {
      const result = await work({
        context: { client: this.client },
        findById: (migrationId) => this.findById(migrationId),
        insert: async (value) => {
          if (
            value.streamId !== LOCAL_SQLITE_MIGRATION_STREAM_ID ||
            value.dialect !== 'sqlite'
          ) {
            throw new TypeError('Local SQLite migration identity is invalid');
          }
          this.client
            .prepare(
              `INSERT INTO "QingLong3SchemaMigrations"
               (migration_id, stream_id, dialect, checksum, applied_at_ms)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              value.migrationId,
              value.streamId,
              value.dialect,
              value.checksum,
              value.appliedAtMs,
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
