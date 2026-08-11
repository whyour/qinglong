import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import type { Migration } from './types';

export const LOCAL_SECRET_ENVELOPE_TABLE = 'LocalSecretEnvelopes';
export const LOCAL_SECRET_MUTATION_INDEX = 'local_secret_mutation_idx';
export const LOCAL_SECRET_CURRENT_INDEX = 'local_secret_current_idx';
export const LOCAL_SECRET_KEY_INDEX = 'local_secret_key_idx';

const manifest = {
  table: LOCAL_SECRET_ENVELOPE_TABLE,
  columns: [
    'project_id',
    'secret_name',
    'version',
    'mutation_id',
    'key_id',
    'algorithm',
    'nonce',
    'ciphertext',
    'auth_tag',
    'created_at_ms',
  ],
  indexes: [
    `${LOCAL_SECRET_MUTATION_INDEX}(project_id,secret_name,mutation_id) UNIQUE`,
    `${LOCAL_SECRET_CURRENT_INDEX}(project_id,secret_name,version DESC)`,
    `${LOCAL_SECRET_KEY_INDEX}(key_id,project_id,secret_name,version)`,
  ],
  constraints: [
    'local_secret_envelopes_version_check',
    'local_secret_envelopes_created_at_check',
  ],
};

export const localSecretEnvelopeManifest = manifest;

export const localSecretEnvelopeMigration: Migration = {
  id: '0014-local-secret-envelopes',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      LOCAL_SECRET_ENVELOPE_TABLE,
      {
        project_id: {
          type: DataTypes.STRING(128),
          allowNull: false,
          primaryKey: true,
        },
        secret_name: {
          type: DataTypes.STRING(128),
          allowNull: false,
          primaryKey: true,
        },
        version: {
          type: DataTypes.INTEGER,
          allowNull: false,
          primaryKey: true,
        },
        mutation_id: { type: DataTypes.STRING(64), allowNull: false },
        key_id: { type: DataTypes.STRING(128), allowNull: false },
        algorithm: { type: DataTypes.STRING(32), allowNull: false },
        nonce: { type: DataTypes.BLOB, allowNull: false },
        ciphertext: { type: DataTypes.BLOB, allowNull: false },
        auth_tag: { type: DataTypes.BLOB, allowNull: false },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(LOCAL_SECRET_ENVELOPE_TABLE, {
      fields: ['version'],
      type: 'check',
      where: { version: { [Op.gte]: 1 } },
      name: 'local_secret_envelopes_version_check',
      transaction,
    });
    await queryInterface.addConstraint(LOCAL_SECRET_ENVELOPE_TABLE, {
      fields: ['created_at_ms'],
      type: 'check',
      where: { created_at_ms: { [Op.gte]: 0 } },
      name: 'local_secret_envelopes_created_at_check',
      transaction,
    });
    await queryInterface.addIndex(
      LOCAL_SECRET_ENVELOPE_TABLE,
      ['project_id', 'secret_name', 'mutation_id'],
      { name: LOCAL_SECRET_MUTATION_INDEX, unique: true, transaction },
    );
    await queryInterface.addIndex(LOCAL_SECRET_ENVELOPE_TABLE, {
      fields: ['project_id', 'secret_name', { name: 'version', order: 'DESC' }],
      name: LOCAL_SECRET_CURRENT_INDEX,
      transaction,
    });
    await queryInterface.addIndex(
      LOCAL_SECRET_ENVELOPE_TABLE,
      ['key_id', 'project_id', 'secret_name', 'version'],
      { name: LOCAL_SECRET_KEY_INDEX, transaction },
    );
  },
};
