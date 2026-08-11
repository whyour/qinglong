import type { ModelStatic, Sequelize } from 'sequelize';
import Logger from '../loaders/logger';
import {
  SchemaMigrationInstance,
  SchemaMigrationModel,
} from '../data/schemaMigration';
import { sequelize } from '../data';
import { migrations as registeredMigrations } from '.';
import {
  SQLITE_MAIN_MIGRATION_STREAM_ID,
  SequelizeSqliteMigrationStreamStore,
} from './adapters/sequelizeSqliteMigrationStreamStore';
import {
  runMigrationStream,
  type MigrationStreamStore,
} from './core/migrationStream';
import type { Migration, MigrationContext } from './types';

interface MigrationLogger {
  info(message: string): unknown;
}

export interface RunMigrationsOptions {
  database?: Sequelize;
  migrationModel?: ModelStatic<SchemaMigrationInstance>;
  migrations?: Migration[];
  logger?: MigrationLogger;
}

function validateMigrations(migrations: Migration[]) {
  const ids = new Set<string>();
  for (const migration of migrations) {
    if (ids.has(migration.id)) {
      throw new Error(`Duplicate migration id: ${migration.id}`);
    }
    ids.add(migration.id);
  }
}

function scopeHistoryToCustomMigrations(
  store: MigrationStreamStore<MigrationContext>,
  migrations: readonly Migration[],
): MigrationStreamStore<MigrationContext> {
  const ids = new Set(migrations.map(({ id }) => id));
  return {
    ensureHistory: () => store.ensureHistory(),
    listAll: async () =>
      (await store.listAll()).filter(({ migrationId }) => ids.has(migrationId)),
    findById: (migrationId) => store.findById(migrationId),
    transaction: (work) => store.transaction(work),
  };
}

export async function runMigrations(
  options: RunMigrationsOptions = {},
): Promise<void> {
  const database = options.database || sequelize;
  const migrationModel = options.migrationModel || SchemaMigrationModel;
  const migrations = options.migrations || registeredMigrations;
  const logger = options.logger || Logger;

  validateMigrations(migrations);
  const store = new SequelizeSqliteMigrationStreamStore(
    database,
    migrationModel,
  );
  await runMigrationStream({
    stream: {
      id: SQLITE_MAIN_MIGRATION_STREAM_ID,
      dialect: 'sqlite',
      migrationIdScheme: 'sqlite-numbered',
      checksumScheme: 'legacy-opaque',
      migrations,
    },
    store:
      options.migrations === undefined
        ? store
        : scopeHistoryToCustomMigrations(store, migrations),
    clock: Date.now,
    logger: {
      info(message) {
        logger.info(
          message.replace(
            `[migration:${SQLITE_MAIN_MIGRATION_STREAM_ID}]`,
            '[migration]',
          ),
        );
      },
    },
  });
}
