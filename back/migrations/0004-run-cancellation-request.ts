import { createHash } from 'crypto';
import { DataTypes } from 'sequelize';
import { RUN_TABLE } from './0002-run-schema';
import type { Migration } from './types';

export const RUN_CANCELLATION_REQUEST_INDEX =
  'runs_status_cancel_requested_idx';

const manifest = {
  table: RUN_TABLE,
  columns: {
    cancel_requested_at_ms: 'bigint null',
    cancel_reason: 'varchar(32) null',
  },
  indexes: [`${RUN_CANCELLATION_REQUEST_INDEX}(status,cancel_requested_at_ms)`],
};

export const runCancellationRequestManifest = manifest;

export const runCancellationRequestMigration: Migration = {
  id: '0004-run-cancellation-request',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    const tables = new Set(await queryInterface.showAllTables());
    if (!tables.has(RUN_TABLE)) return;

    const columns = await queryInterface.describeTable(RUN_TABLE);
    if (!columns.cancel_requested_at_ms) {
      await queryInterface.addColumn(
        RUN_TABLE,
        'cancel_requested_at_ms',
        { type: DataTypes.BIGINT, allowNull: true },
        { transaction },
      );
    }
    if (!columns.cancel_reason) {
      await queryInterface.addColumn(
        RUN_TABLE,
        'cancel_reason',
        { type: DataTypes.STRING(32), allowNull: true },
        { transaction },
      );
    }

    const currentIndexes = (await queryInterface.showIndex(RUN_TABLE, {
      transaction,
    })) as Array<{ name: string }>;
    if (
      !currentIndexes.some(
        (index) => index.name === RUN_CANCELLATION_REQUEST_INDEX,
      )
    ) {
      await queryInterface.addIndex(
        RUN_TABLE,
        ['status', 'cancel_requested_at_ms'],
        { name: RUN_CANCELLATION_REQUEST_INDEX, transaction },
      );
    }
  },
};
