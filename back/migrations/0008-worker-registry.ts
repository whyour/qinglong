import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import type { Migration } from './types';

export const WORKER_REGISTRY_TABLE = 'Workers';
export const WORKER_REGISTRY_LEASE_INDEX = 'workers_lease_idx';
export const WORKER_REGISTRY_CAPACITY_INDEX = 'workers_capacity_idx';

const manifest = {
  table: WORKER_REGISTRY_TABLE,
  columns: [
    'id',
    'session_id',
    'generation',
    'status',
    'version',
    'capabilities_json',
    'capabilities_hash',
    'max_concurrent_runs',
    'available_slots',
    'registered_at_ms',
    'last_heartbeat_at_ms',
    'lease_expires_at_ms',
    'updated_at_ms',
  ],
  indexes: [
    `${WORKER_REGISTRY_LEASE_INDEX}(status,lease_expires_at_ms,id)`,
    `${WORKER_REGISTRY_CAPACITY_INDEX}(status,available_slots,lease_expires_at_ms,id)`,
  ],
  constraints: [
    'workers_generation_positive_check',
    'workers_version_nonnegative_check',
    'workers_max_concurrency_positive_check',
    'workers_available_slots_nonnegative_check',
    'workers_status_check',
  ],
};

export const workerRegistryManifest = manifest;

export const workerRegistryMigration: Migration = {
  id: '0008-worker-registry',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      WORKER_REGISTRY_TABLE,
      {
        id: { type: DataTypes.STRING(128), allowNull: false, primaryKey: true },
        session_id: { type: DataTypes.STRING(36), allowNull: false },
        generation: { type: DataTypes.INTEGER, allowNull: false },
        status: { type: DataTypes.STRING(16), allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false },
        capabilities_json: { type: DataTypes.TEXT, allowNull: false },
        capabilities_hash: { type: DataTypes.STRING(64), allowNull: false },
        max_concurrent_runs: { type: DataTypes.INTEGER, allowNull: false },
        available_slots: { type: DataTypes.INTEGER, allowNull: false },
        registered_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        last_heartbeat_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        lease_expires_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        updated_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(WORKER_REGISTRY_TABLE, {
      fields: ['generation'],
      type: 'check',
      where: { generation: { [Op.gt]: 0 } },
      name: 'workers_generation_positive_check',
      transaction,
    });
    await queryInterface.addConstraint(WORKER_REGISTRY_TABLE, {
      fields: ['version'],
      type: 'check',
      where: { version: { [Op.gte]: 0 } },
      name: 'workers_version_nonnegative_check',
      transaction,
    });
    await queryInterface.addConstraint(WORKER_REGISTRY_TABLE, {
      fields: ['max_concurrent_runs'],
      type: 'check',
      where: { max_concurrent_runs: { [Op.gt]: 0 } },
      name: 'workers_max_concurrency_positive_check',
      transaction,
    });
    await queryInterface.addConstraint(WORKER_REGISTRY_TABLE, {
      fields: ['available_slots'],
      type: 'check',
      where: { available_slots: { [Op.gte]: 0 } },
      name: 'workers_available_slots_nonnegative_check',
      transaction,
    });
    await queryInterface.addConstraint(WORKER_REGISTRY_TABLE, {
      fields: ['status'],
      type: 'check',
      where: { status: { [Op.in]: ['online', 'draining', 'offline'] } },
      name: 'workers_status_check',
      transaction,
    });
    await queryInterface.addIndex(
      WORKER_REGISTRY_TABLE,
      ['status', 'lease_expires_at_ms', 'id'],
      { name: WORKER_REGISTRY_LEASE_INDEX, transaction },
    );
    await queryInterface.addIndex(
      WORKER_REGISTRY_TABLE,
      ['status', 'available_slots', 'lease_expires_at_ms', 'id'],
      { name: WORKER_REGISTRY_CAPACITY_INDEX, transaction },
    );
  },
};
