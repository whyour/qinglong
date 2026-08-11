import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import { RUN_ATTEMPT_TABLE } from './0002-run-schema';
import type { Migration } from './types';

export const LOCAL_ARTIFACT_RETENTION_TABLE = 'LocalArtifactRetentions';
export const LOCAL_ARTIFACT_RETENTION_RECORDED_INDEX =
  'local_artifact_retention_recorded_idx';
export const RUN_ATTEMPT_ARTIFACT_RETENTION_INDEX =
  'run_attempts_artifact_retention_idx';

const manifest = {
  table: LOCAL_ARTIFACT_RETENTION_TABLE,
  columns: [
    'attempt_id',
    'log_artifact_id',
    'finished_at_ms',
    'eligible_at_ms',
    'disposition',
    'bytes_reclaimed',
    'recorded_at_ms',
  ],
  indexes: [
    `${LOCAL_ARTIFACT_RETENTION_RECORDED_INDEX}(recorded_at_ms,attempt_id)`,
    `${RUN_ATTEMPT_ARTIFACT_RETENTION_INDEX}(status,finished_at_ms,id)`,
  ],
  constraints: [
    'local_artifact_retention_disposition_check',
    'local_artifact_retention_finished_check',
    'local_artifact_retention_eligible_check',
    'local_artifact_retention_bytes_check',
    'local_artifact_retention_recorded_check',
  ],
};

export const localArtifactRetentionManifest = manifest;

export const localArtifactRetentionMigration: Migration = {
  id: '0015-local-artifact-retention',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      LOCAL_ARTIFACT_RETENTION_TABLE,
      {
        attempt_id: {
          type: DataTypes.STRING(36),
          allowNull: false,
          primaryKey: true,
          references: { model: RUN_ATTEMPT_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        log_artifact_id: { type: DataTypes.STRING(36), allowNull: false },
        finished_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        eligible_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        disposition: { type: DataTypes.STRING(16), allowNull: false },
        bytes_reclaimed: { type: DataTypes.BIGINT, allowNull: false },
        recorded_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(LOCAL_ARTIFACT_RETENTION_TABLE, {
      fields: ['disposition'],
      type: 'check',
      where: { disposition: { [Op.in]: ['deleted', 'already_absent'] } },
      name: 'local_artifact_retention_disposition_check',
      transaction,
    });
    for (const [field, name] of [
      ['finished_at_ms', 'local_artifact_retention_finished_check'],
      ['eligible_at_ms', 'local_artifact_retention_eligible_check'],
      ['bytes_reclaimed', 'local_artifact_retention_bytes_check'],
      ['recorded_at_ms', 'local_artifact_retention_recorded_check'],
    ] as const) {
      await queryInterface.addConstraint(LOCAL_ARTIFACT_RETENTION_TABLE, {
        fields: [field],
        type: 'check',
        where: { [field]: { [Op.gte]: 0 } },
        name,
        transaction,
      });
    }
    await queryInterface.addIndex(
      LOCAL_ARTIFACT_RETENTION_TABLE,
      ['recorded_at_ms', 'attempt_id'],
      { name: LOCAL_ARTIFACT_RETENTION_RECORDED_INDEX, transaction },
    );
    await queryInterface.addIndex(
      RUN_ATTEMPT_TABLE,
      ['status', 'finished_at_ms', 'id'],
      { name: RUN_ATTEMPT_ARTIFACT_RETENTION_INDEX, transaction },
    );
  },
};
