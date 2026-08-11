import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import type { Migration } from './types';

export const LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE =
  'LocalArtifactMaintenanceCursors';

const manifest = {
  table: LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE,
  columns: [
    'scope',
    'cursor_finished_at_ms',
    'cursor_attempt_id',
    'version',
    'updated_at_ms',
  ],
  indexes: [] as string[],
  constraints: [
    'local_artifact_cursor_scope_check',
    'local_artifact_cursor_pair_check',
    'local_artifact_cursor_version_check',
    'local_artifact_cursor_updated_check',
  ],
};

export const localArtifactMaintenanceCursorManifest = manifest;

export const localArtifactMaintenanceCursorMigration: Migration = {
  id: '0016-local-artifact-maintenance-cursor',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE,
      {
        scope: {
          type: DataTypes.STRING(32),
          allowNull: false,
          primaryKey: true,
        },
        cursor_finished_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        cursor_attempt_id: { type: DataTypes.STRING(36), allowNull: true },
        version: { type: DataTypes.BIGINT, allowNull: false },
        updated_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(
      LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE,
      {
        fields: ['scope'],
        type: 'check',
        where: { scope: 'retention' },
        name: 'local_artifact_cursor_scope_check',
        transaction,
      },
    );
    await queryInterface.addConstraint(
      LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE,
      {
        fields: ['cursor_finished_at_ms', 'cursor_attempt_id'],
        type: 'check',
        where: {
          [Op.or]: [
            { cursor_finished_at_ms: null, cursor_attempt_id: null },
            {
              cursor_finished_at_ms: { [Op.not]: null },
              cursor_attempt_id: { [Op.not]: null },
            },
          ],
        },
        name: 'local_artifact_cursor_pair_check',
        transaction,
      },
    );
    await queryInterface.addConstraint(
      LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE,
      {
        fields: ['version'],
        type: 'check',
        where: { version: { [Op.gte]: 1 } },
        name: 'local_artifact_cursor_version_check',
        transaction,
      },
    );
    await queryInterface.addConstraint(
      LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE,
      {
        fields: ['updated_at_ms'],
        type: 'check',
        where: { updated_at_ms: { [Op.gte]: 0 } },
        name: 'local_artifact_cursor_updated_check',
        transaction,
      },
    );
  },
};
