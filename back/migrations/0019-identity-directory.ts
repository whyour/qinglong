import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import {
  IDENTITY_AUTHENTICATION_BINDING_STATES,
  IDENTITY_SUBJECT_STATUSES,
  LEGACY_PANEL_IDENTITY_PROVIDER,
  LEGACY_PANEL_PROVIDER_SUBJECT,
  LEGACY_PRIMARY_USER_SUBJECT_ID,
} from '../runtime/domain/identityDirectory';
import { POLICY_SUBJECT_TYPES } from '../runtime/domain/projectPolicy';
import type { Migration } from './types';

export const IDENTITY_SUBJECT_TABLE = 'IdentitySubjects';
export const IDENTITY_AUTHENTICATION_BINDING_TABLE =
  'IdentityAuthenticationBindings';
export const IDENTITY_SUBJECT_STATUS_INDEX = 'identity_subject_status_idx';
export const IDENTITY_AUTHENTICATION_BINDING_CURRENT_INDEX =
  'identity_auth_binding_current_idx';
export const IDENTITY_AUTHENTICATION_BINDING_SUBJECT_INDEX =
  'identity_auth_binding_subject_idx';

const manifest = {
  tables: {
    IdentitySubjects: [
      'id',
      'type',
      'status',
      'version',
      'created_at_ms',
      'updated_at_ms',
    ],
    IdentityAuthenticationBindings: [
      'provider',
      'provider_subject',
      'version',
      'state',
      'subject_id',
      'created_at_ms',
    ],
  },
  indexes: [
    `${IDENTITY_SUBJECT_STATUS_INDEX}(type,status,id)`,
    `${IDENTITY_AUTHENTICATION_BINDING_CURRENT_INDEX}(provider,provider_subject,version DESC)`,
    `${IDENTITY_AUTHENTICATION_BINDING_SUBJECT_INDEX}(subject_id,provider,provider_subject,version DESC)`,
  ],
  constraints: [
    'identity_subject_type_check',
    'identity_subject_status_check',
    'identity_subject_version_check',
    'identity_subject_created_at_check',
    'identity_subject_updated_at_check',
    'identity_auth_binding_version_check',
    'identity_auth_binding_state_check',
    'identity_auth_binding_created_at_check',
  ],
  baseline: {
    subject: {
      id: LEGACY_PRIMARY_USER_SUBJECT_ID,
      type: 'user',
      status: 'active',
      version: 1,
      created_at_ms: 0,
      updated_at_ms: 0,
    },
    binding: {
      provider: LEGACY_PANEL_IDENTITY_PROVIDER,
      provider_subject: LEGACY_PANEL_PROVIDER_SUBJECT,
      version: 1,
      state: 'active',
      subject_id: LEGACY_PRIMARY_USER_SUBJECT_ID,
      created_at_ms: 0,
    },
  },
};

export const identityDirectoryManifest = manifest;

export const identityDirectoryMigration: Migration = {
  id: '0019-identity-directory',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      IDENTITY_SUBJECT_TABLE,
      {
        id: { type: DataTypes.STRING(255), allowNull: false, primaryKey: true },
        type: { type: DataTypes.STRING(32), allowNull: false },
        status: { type: DataTypes.STRING(16), allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        updated_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    for (const [field, values, name] of [
      ['type', POLICY_SUBJECT_TYPES, 'identity_subject_type_check'],
      ['status', IDENTITY_SUBJECT_STATUSES, 'identity_subject_status_check'],
    ] as const) {
      await queryInterface.addConstraint(IDENTITY_SUBJECT_TABLE, {
        fields: [field],
        type: 'check',
        where: { [field]: { [Op.in]: values } },
        name,
        transaction,
      });
    }
    for (const [field, name, minimum] of [
      ['version', 'identity_subject_version_check', 1],
      ['created_at_ms', 'identity_subject_created_at_check', 0],
      ['updated_at_ms', 'identity_subject_updated_at_check', 0],
    ] as const) {
      await queryInterface.addConstraint(IDENTITY_SUBJECT_TABLE, {
        fields: [field],
        type: 'check',
        where: { [field]: { [Op.gte]: minimum } },
        name,
        transaction,
      });
    }
    await queryInterface.addIndex(IDENTITY_SUBJECT_TABLE, {
      fields: ['type', 'status', 'id'],
      name: IDENTITY_SUBJECT_STATUS_INDEX,
      transaction,
    });
    await queryInterface.bulkInsert(
      IDENTITY_SUBJECT_TABLE,
      [manifest.baseline.subject],
      { transaction },
    );

    await queryInterface.createTable(
      IDENTITY_AUTHENTICATION_BINDING_TABLE,
      {
        provider: {
          type: DataTypes.STRING(64),
          allowNull: false,
          primaryKey: true,
        },
        provider_subject: {
          type: DataTypes.STRING(128),
          allowNull: false,
          primaryKey: true,
        },
        version: {
          type: DataTypes.INTEGER,
          allowNull: false,
          primaryKey: true,
        },
        state: { type: DataTypes.STRING(16), allowNull: false },
        subject_id: {
          type: DataTypes.STRING(255),
          allowNull: false,
          references: { model: IDENTITY_SUBJECT_TABLE, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(IDENTITY_AUTHENTICATION_BINDING_TABLE, {
      fields: ['version'],
      type: 'check',
      where: { version: { [Op.gte]: 1 } },
      name: 'identity_auth_binding_version_check',
      transaction,
    });
    await queryInterface.addConstraint(IDENTITY_AUTHENTICATION_BINDING_TABLE, {
      fields: ['state'],
      type: 'check',
      where: {
        state: { [Op.in]: IDENTITY_AUTHENTICATION_BINDING_STATES },
      },
      name: 'identity_auth_binding_state_check',
      transaction,
    });
    await queryInterface.addConstraint(IDENTITY_AUTHENTICATION_BINDING_TABLE, {
      fields: ['created_at_ms'],
      type: 'check',
      where: { created_at_ms: { [Op.gte]: 0 } },
      name: 'identity_auth_binding_created_at_check',
      transaction,
    });
    await queryInterface.addIndex(IDENTITY_AUTHENTICATION_BINDING_TABLE, {
      fields: [
        'provider',
        'provider_subject',
        { name: 'version', order: 'DESC' },
      ],
      name: IDENTITY_AUTHENTICATION_BINDING_CURRENT_INDEX,
      transaction,
    });
    await queryInterface.addIndex(IDENTITY_AUTHENTICATION_BINDING_TABLE, {
      fields: [
        'subject_id',
        'provider',
        'provider_subject',
        { name: 'version', order: 'DESC' },
      ],
      name: IDENTITY_AUTHENTICATION_BINDING_SUBJECT_INDEX,
      transaction,
    });
    await queryInterface.bulkInsert(
      IDENTITY_AUTHENTICATION_BINDING_TABLE,
      [manifest.baseline.binding],
      { transaction },
    );
  },
};
