import type { ModelStatic, Sequelize, Transaction } from 'sequelize';
import type {
  SchemaMigrationInstance,
  SchemaMigrationAttributes,
} from '../../data/schemaMigration';
import type {
  MigrationStreamRecord,
  MigrationStreamStore,
  MigrationStreamTransaction,
} from '../core/migrationStream';
import type { MigrationContext } from '../types';

export const SQLITE_MAIN_MIGRATION_STREAM_ID = 'sqlite-main';

function toRecord(instance: SchemaMigrationInstance): MigrationStreamRecord {
  return {
    streamId: SQLITE_MAIN_MIGRATION_STREAM_ID,
    dialect: 'sqlite',
    migrationId: instance.id,
    checksum: instance.checksum,
    appliedAtMs: Number(instance.applied_at),
  };
}

/**
 * Compatibility adapter for the existing Sequelize-owned SQLite connection.
 * It preserves the legacy SchemaMigrations row shape while the generic core
 * owns ordering, replay and checksum semantics.
 */
export class SequelizeSqliteMigrationStreamStore
  implements MigrationStreamStore<MigrationContext>
{
  constructor(
    private readonly database: Sequelize,
    private readonly migrationModel: ModelStatic<SchemaMigrationInstance>,
  ) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'SequelizeSqliteMigrationStreamStore requires SQLite',
      );
    }
  }

  async ensureHistory(): Promise<void> {
    await this.migrationModel.sync();
  }

  async listAll(): Promise<readonly MigrationStreamRecord[]> {
    return (await this.migrationModel.findAll()).map(toRecord);
  }

  async findById(migrationId: string): Promise<MigrationStreamRecord | null> {
    const applied = await this.migrationModel.findByPk(migrationId);
    return applied ? toRecord(applied) : null;
  }

  async transaction<T>(
    work: (
      transaction: MigrationStreamTransaction<MigrationContext>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (transaction) =>
      work(this.createTransaction(transaction)),
    );
  }

  private createTransaction(
    transaction: Transaction,
  ): MigrationStreamTransaction<MigrationContext> {
    return {
      context: {
        queryInterface: this.database.getQueryInterface(),
        transaction,
      },
      findById: async (migrationId) => {
        const applied = await this.migrationModel.findByPk(migrationId, {
          transaction,
        });
        return applied ? toRecord(applied) : null;
      },
      insert: async (record) => {
        if (
          record.streamId !== SQLITE_MAIN_MIGRATION_STREAM_ID ||
          record.dialect !== 'sqlite'
        ) {
          throw new TypeError('SQLite migration record identity is invalid');
        }
        const attributes: SchemaMigrationAttributes = {
          id: record.migrationId,
          checksum: record.checksum,
          applied_at: record.appliedAtMs,
        };
        await this.migrationModel.create(attributes, { transaction });
      },
    };
  }
}
