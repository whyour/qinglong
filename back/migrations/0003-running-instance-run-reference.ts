import { createHash } from 'crypto';
import { DataTypes } from 'sequelize';
import type { Migration } from './types';

export const RUNNING_INSTANCE_TABLE = 'RunningInstances';
export const RUNNING_INSTANCE_RUN_INDEX = 'running_instances_run_started_idx';
export const RUNNING_INSTANCE_ATTEMPT_INDEX = 'running_instances_attempt_uidx';

const manifest = {
  table: RUNNING_INSTANCE_TABLE,
  columns: {
    run_id: 'varchar(36) null',
    attempt_id: 'varchar(36) null',
  },
  indexes: [
    `${RUNNING_INSTANCE_RUN_INDEX}(run_id,started_at)`,
    `${RUNNING_INSTANCE_ATTEMPT_INDEX}(attempt_id) unique`,
  ],
};

export const runningInstanceRunReferenceManifest = manifest;

export const runningInstanceRunReferenceMigration: Migration = {
  id: '0003-running-instance-run-reference',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    const tables = new Set(await queryInterface.showAllTables());
    if (!tables.has(RUNNING_INSTANCE_TABLE)) return;

    const columns = await queryInterface.describeTable(RUNNING_INSTANCE_TABLE);
    if (!columns.run_id) {
      await queryInterface.addColumn(
        RUNNING_INSTANCE_TABLE,
        'run_id',
        { type: DataTypes.STRING(36), allowNull: true },
        { transaction },
      );
    }
    if (!columns.attempt_id) {
      await queryInterface.addColumn(
        RUNNING_INSTANCE_TABLE,
        'attempt_id',
        { type: DataTypes.STRING(36), allowNull: true },
        { transaction },
      );
    }

    const currentIndexes = (await queryInterface.showIndex(
      RUNNING_INSTANCE_TABLE,
      { transaction },
    )) as Array<{ name: string }>;
    const indexes = new Set(currentIndexes.map((index) => index.name));
    if (!indexes.has(RUNNING_INSTANCE_RUN_INDEX)) {
      await queryInterface.addIndex(
        RUNNING_INSTANCE_TABLE,
        ['run_id', 'started_at'],
        {
          name: RUNNING_INSTANCE_RUN_INDEX,
          transaction,
        },
      );
    }
    if (!indexes.has(RUNNING_INSTANCE_ATTEMPT_INDEX)) {
      await queryInterface.addIndex(RUNNING_INSTANCE_TABLE, ['attempt_id'], {
        name: RUNNING_INSTANCE_ATTEMPT_INDEX,
        unique: true,
        transaction,
      });
    }
  },
};
