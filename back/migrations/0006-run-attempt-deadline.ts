import { createHash } from 'crypto';
import { DataTypes } from 'sequelize';
import { RUN_ATTEMPT_TABLE } from './0002-run-schema';
import type { Migration } from './types';

export const RUN_ATTEMPT_DEADLINE_INDEX = 'run_attempt_status_deadline_idx';

const manifest = {
  table: RUN_ATTEMPT_TABLE,
  columns: {
    deadline_at_ms: 'bigint null',
  },
  indexes: [`${RUN_ATTEMPT_DEADLINE_INDEX}(status,deadline_at_ms,id)`],
};

export const runAttemptDeadlineManifest = manifest;

export const runAttemptDeadlineMigration: Migration = {
  id: '0006-run-attempt-deadline',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    const tables = new Set(await queryInterface.showAllTables());
    if (!tables.has(RUN_ATTEMPT_TABLE)) return;

    const columns = await queryInterface.describeTable(RUN_ATTEMPT_TABLE);
    if (!columns.deadline_at_ms) {
      await queryInterface.addColumn(
        RUN_ATTEMPT_TABLE,
        'deadline_at_ms',
        { type: DataTypes.BIGINT, allowNull: true },
        { transaction },
      );
    }

    const currentIndexes = (await queryInterface.showIndex(RUN_ATTEMPT_TABLE, {
      transaction,
    })) as Array<{ name: string }>;
    if (
      !currentIndexes.some((index) => index.name === RUN_ATTEMPT_DEADLINE_INDEX)
    ) {
      await queryInterface.addIndex(
        RUN_ATTEMPT_TABLE,
        ['status', 'deadline_at_ms', 'id'],
        { name: RUN_ATTEMPT_DEADLINE_INDEX, transaction },
      );
    }
  },
};
