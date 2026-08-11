import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import { RUN_ATTEMPT_TABLE, RUN_TABLE } from './0002-run-schema';
import type { Migration } from './types';

export const RUN_CANCELLATION_DISPATCH_TABLE = 'RunCancellationDispatches';
export const RUN_CANCELLATION_DISPATCH_DUE_INDEX =
  'run_cancel_dispatch_due_idx';
export const RUN_CANCELLATION_DISPATCH_LEASE_INDEX =
  'run_cancel_dispatch_lease_idx';

const manifest = {
  table: RUN_CANCELLATION_DISPATCH_TABLE,
  columns: [
    'run_id',
    'attempt_id',
    'status',
    'version',
    'dispatch_count',
    'next_attempt_at_ms',
    'lease_owner',
    'lease_token',
    'lease_expires_at_ms',
    'last_result',
    'last_dispatched_at_ms',
    'created_at_ms',
    'updated_at_ms',
  ],
  indexes: [
    `${RUN_CANCELLATION_DISPATCH_DUE_INDEX}(status,next_attempt_at_ms)`,
    `${RUN_CANCELLATION_DISPATCH_LEASE_INDEX}(lease_expires_at_ms)`,
  ],
  constraints: [
    'run_cancel_dispatch_version_nonnegative_check',
    'run_cancel_dispatch_count_nonnegative_check',
  ],
};

export const runCancellationDispatchManifest = manifest;

export const runCancellationDispatchMigration: Migration = {
  id: '0005-run-cancellation-dispatch',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      RUN_CANCELLATION_DISPATCH_TABLE,
      {
        run_id: {
          type: DataTypes.STRING(36),
          allowNull: false,
          primaryKey: true,
          references: { model: RUN_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        attempt_id: {
          type: DataTypes.STRING(36),
          allowNull: false,
          references: { model: RUN_ATTEMPT_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        status: { type: DataTypes.STRING(32), allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        dispatch_count: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        next_attempt_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        lease_owner: { type: DataTypes.STRING(128), allowNull: true },
        lease_token: { type: DataTypes.STRING(128), allowNull: true },
        lease_expires_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        last_result: { type: DataTypes.STRING(64), allowNull: true },
        last_dispatched_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        updated_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(RUN_CANCELLATION_DISPATCH_TABLE, {
      fields: ['version'],
      type: 'check',
      where: { version: { [Op.gte]: 0 } },
      name: 'run_cancel_dispatch_version_nonnegative_check',
      transaction,
    });
    await queryInterface.addConstraint(RUN_CANCELLATION_DISPATCH_TABLE, {
      fields: ['dispatch_count'],
      type: 'check',
      where: { dispatch_count: { [Op.gte]: 0 } },
      name: 'run_cancel_dispatch_count_nonnegative_check',
      transaction,
    });
    await queryInterface.addIndex(
      RUN_CANCELLATION_DISPATCH_TABLE,
      ['status', 'next_attempt_at_ms'],
      { name: RUN_CANCELLATION_DISPATCH_DUE_INDEX, transaction },
    );
    await queryInterface.addIndex(
      RUN_CANCELLATION_DISPATCH_TABLE,
      ['lease_expires_at_ms'],
      { name: RUN_CANCELLATION_DISPATCH_LEASE_INDEX, transaction },
    );
  },
};
