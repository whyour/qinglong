import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import { RUN_ATTEMPT_TABLE, RUN_TABLE } from './0002-run-schema';
import { WORKER_REGISTRY_TABLE } from './0008-worker-registry';
import type { Migration } from './types';

export const RUN_DISPATCH_LEASE_TABLE = 'RunDispatchLeases';
export const RUN_DISPATCH_LEASE_EXPIRY_INDEX = 'run_dispatch_leases_expiry_idx';
export const RUN_DISPATCH_LEASE_WORKER_INDEX = 'run_dispatch_leases_worker_idx';
export const RUN_DISPATCH_LEASE_TOKEN_INDEX = 'run_dispatch_leases_token_uidx';

const manifest = {
  table: RUN_DISPATCH_LEASE_TABLE,
  columns: [
    'attempt_id',
    'run_id',
    'status',
    'version',
    'lease_generation',
    'worker_id',
    'worker_session_id',
    'worker_generation',
    'lease_token',
    'acquired_at_ms',
    'renewed_at_ms',
    'expires_at_ms',
    'released_at_ms',
    'release_reason',
    'completed_at_ms',
    'updated_at_ms',
  ],
  indexes: [
    `${RUN_DISPATCH_LEASE_EXPIRY_INDEX}(status,expires_at_ms,attempt_id)`,
    `${RUN_DISPATCH_LEASE_WORKER_INDEX}(worker_id,worker_session_id,worker_generation,status,expires_at_ms,attempt_id)`,
    `${RUN_DISPATCH_LEASE_TOKEN_INDEX}(lease_token)`,
  ],
  constraints: [
    'run_dispatch_leases_status_check',
    'run_dispatch_leases_version_nonnegative_check',
    'run_dispatch_leases_generation_positive_check',
    'run_dispatch_leases_worker_generation_positive_check',
  ],
};

export const runDispatchLeaseManifest = manifest;

export const runDispatchLeaseMigration: Migration = {
  id: '0009-run-dispatch-lease',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      RUN_DISPATCH_LEASE_TABLE,
      {
        attempt_id: {
          type: DataTypes.STRING(36),
          allowNull: false,
          primaryKey: true,
          references: { model: RUN_ATTEMPT_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        run_id: {
          type: DataTypes.STRING(36),
          allowNull: false,
          references: { model: RUN_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        status: { type: DataTypes.STRING(16), allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false },
        lease_generation: { type: DataTypes.INTEGER, allowNull: false },
        worker_id: {
          type: DataTypes.STRING(128),
          allowNull: false,
          references: { model: WORKER_REGISTRY_TABLE, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        worker_session_id: { type: DataTypes.STRING(36), allowNull: false },
        worker_generation: { type: DataTypes.INTEGER, allowNull: false },
        lease_token: { type: DataTypes.STRING(128), allowNull: false },
        acquired_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        renewed_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        expires_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        released_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        release_reason: { type: DataTypes.STRING(32), allowNull: true },
        completed_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        updated_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(RUN_DISPATCH_LEASE_TABLE, {
      fields: ['status'],
      type: 'check',
      where: { status: { [Op.in]: ['leased', 'released', 'completed'] } },
      name: 'run_dispatch_leases_status_check',
      transaction,
    });
    await queryInterface.addConstraint(RUN_DISPATCH_LEASE_TABLE, {
      fields: ['version'],
      type: 'check',
      where: { version: { [Op.gte]: 0 } },
      name: 'run_dispatch_leases_version_nonnegative_check',
      transaction,
    });
    await queryInterface.addConstraint(RUN_DISPATCH_LEASE_TABLE, {
      fields: ['lease_generation'],
      type: 'check',
      where: { lease_generation: { [Op.gt]: 0 } },
      name: 'run_dispatch_leases_generation_positive_check',
      transaction,
    });
    await queryInterface.addConstraint(RUN_DISPATCH_LEASE_TABLE, {
      fields: ['worker_generation'],
      type: 'check',
      where: { worker_generation: { [Op.gt]: 0 } },
      name: 'run_dispatch_leases_worker_generation_positive_check',
      transaction,
    });
    await queryInterface.addIndex(
      RUN_DISPATCH_LEASE_TABLE,
      ['status', 'expires_at_ms', 'attempt_id'],
      { name: RUN_DISPATCH_LEASE_EXPIRY_INDEX, transaction },
    );
    await queryInterface.addIndex(
      RUN_DISPATCH_LEASE_TABLE,
      [
        'worker_id',
        'worker_session_id',
        'worker_generation',
        'status',
        'expires_at_ms',
        'attempt_id',
      ],
      { name: RUN_DISPATCH_LEASE_WORKER_INDEX, transaction },
    );
    await queryInterface.addIndex(RUN_DISPATCH_LEASE_TABLE, ['lease_token'], {
      name: RUN_DISPATCH_LEASE_TOKEN_INDEX,
      unique: true,
      transaction,
    });
  },
};
