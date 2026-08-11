import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import { RUN_TABLE } from './0002-run-schema';
import type { Migration } from './types';

export const RUN_RETRY_POLICY_TABLE = 'RunRetryPolicies';
export const RUN_RETRY_POLICY_DUE_INDEX = 'run_retry_policies_due_idx';
export const RUN_LOST_RETRY_INDEX = 'runs_lost_retry_idx';

const manifest = {
  table: RUN_RETRY_POLICY_TABLE,
  columns: [
    'run_id',
    'max_attempts',
    'retry_on_lost',
    'safety',
    'backoff_base_ms',
    'backoff_max_ms',
    'next_attempt_at_ms',
    'version',
    'created_at_ms',
    'updated_at_ms',
  ],
  indexes: [
    `${RUN_LOST_RETRY_INDEX}(execution_owner,status,id)`,
    `${RUN_RETRY_POLICY_DUE_INDEX}(next_attempt_at_ms,run_id) WHERE next_attempt_at_ms IS NOT NULL`,
  ],
  constraints: [
    'run_retry_policies_max_attempts_check',
    'run_retry_policies_backoff_base_check',
    'run_retry_policies_backoff_max_check',
    'run_retry_policies_version_check',
  ],
};

export const runRetryPolicyManifest = manifest;

export const runRetryPolicyMigration: Migration = {
  id: '0011-run-retry-policy',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      RUN_RETRY_POLICY_TABLE,
      {
        run_id: {
          type: DataTypes.STRING(36),
          allowNull: false,
          primaryKey: true,
          references: { model: RUN_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        max_attempts: { type: DataTypes.INTEGER, allowNull: false },
        retry_on_lost: { type: DataTypes.BOOLEAN, allowNull: false },
        safety: { type: DataTypes.STRING(16), allowNull: false },
        backoff_base_ms: { type: DataTypes.BIGINT, allowNull: false },
        backoff_max_ms: { type: DataTypes.BIGINT, allowNull: false },
        next_attempt_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        version: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        updated_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(RUN_RETRY_POLICY_TABLE, {
      fields: ['max_attempts'],
      type: 'check',
      where: { max_attempts: { [Op.between]: [1, 16] } },
      name: 'run_retry_policies_max_attempts_check',
      transaction,
    });
    await queryInterface.addConstraint(RUN_RETRY_POLICY_TABLE, {
      fields: ['backoff_base_ms'],
      type: 'check',
      where: { backoff_base_ms: { [Op.gte]: 0 } },
      name: 'run_retry_policies_backoff_base_check',
      transaction,
    });
    await queryInterface.addConstraint(RUN_RETRY_POLICY_TABLE, {
      fields: ['backoff_max_ms'],
      type: 'check',
      where: { backoff_max_ms: { [Op.gte]: 0 } },
      name: 'run_retry_policies_backoff_max_check',
      transaction,
    });
    await queryInterface.addConstraint(RUN_RETRY_POLICY_TABLE, {
      fields: ['version'],
      type: 'check',
      where: { version: { [Op.gte]: 0 } },
      name: 'run_retry_policies_version_check',
      transaction,
    });
    await queryInterface.addIndex(
      RUN_TABLE,
      ['execution_owner', 'status', 'id'],
      {
        name: RUN_LOST_RETRY_INDEX,
        transaction,
      },
    );
    await queryInterface.addIndex(
      RUN_RETRY_POLICY_TABLE,
      ['next_attempt_at_ms', 'run_id'],
      {
        name: RUN_RETRY_POLICY_DUE_INDEX,
        where: { next_attempt_at_ms: { [Op.ne]: null } },
        transaction,
      },
    );
  },
};
