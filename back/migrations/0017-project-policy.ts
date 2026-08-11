import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import {
  POLICY_SUBJECT_TYPES,
  PROJECT_ROLES,
  PROJECT_ROLE_BINDING_STATES,
  PROJECT_STATUSES,
} from '../runtime/domain/projectPolicy';
import type { Migration } from './types';

export const PROJECT_TABLE = 'Projects';
export const PROJECT_ROLE_BINDING_TABLE = 'ProjectRoleBindings';
export const PROJECT_SLUG_INDEX = 'projects_slug_uidx';
export const PROJECT_ROLE_BINDING_CURRENT_INDEX =
  'project_role_binding_current_idx';
export const PROJECT_ROLE_BINDING_MUTATION_INDEX =
  'project_role_binding_mutation_uidx';
export const PROJECT_ROLE_BINDING_SUBJECT_INDEX =
  'project_role_binding_subject_idx';

const manifest = {
  tables: {
    Projects: [
      'id',
      'name',
      'slug',
      'status',
      'version',
      'created_at_ms',
      'updated_at_ms',
    ],
    ProjectRoleBindings: [
      'project_id',
      'subject_type',
      'subject_id',
      'version',
      'state',
      'role',
      'mutation_id',
      'changed_by_type',
      'changed_by_id',
      'created_at_ms',
    ],
  },
  indexes: [
    `${PROJECT_SLUG_INDEX}(slug) UNIQUE`,
    `${PROJECT_ROLE_BINDING_CURRENT_INDEX}(project_id,subject_type,subject_id,version DESC)`,
    `${PROJECT_ROLE_BINDING_MUTATION_INDEX}(project_id,mutation_id) UNIQUE`,
    `${PROJECT_ROLE_BINDING_SUBJECT_INDEX}(subject_type,subject_id,project_id,version DESC)`,
  ],
  constraints: [
    'projects_status_check',
    'projects_version_check',
    'projects_created_at_check',
    'projects_updated_at_check',
    'project_role_bindings_subject_type_check',
    'project_role_bindings_version_check',
    'project_role_bindings_state_check',
    'project_role_bindings_role_check',
    'project_role_bindings_changed_by_type_check',
    'project_role_bindings_created_at_check',
  ],
  baseline: {
    id: 'default',
    name: 'Default',
    slug: 'default',
    status: 'active',
    version: 1,
    created_at_ms: 0,
    updated_at_ms: 0,
  },
};

export const projectPolicyManifest = manifest;

export const projectPolicyMigration: Migration = {
  id: '0017-project-policy',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      PROJECT_TABLE,
      {
        id: { type: DataTypes.STRING(128), allowNull: false, primaryKey: true },
        name: { type: DataTypes.STRING(255), allowNull: false },
        slug: { type: DataTypes.STRING(128), allowNull: false },
        status: { type: DataTypes.STRING(16), allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        updated_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(PROJECT_TABLE, {
      fields: ['status'],
      type: 'check',
      where: { status: { [Op.in]: PROJECT_STATUSES } },
      name: 'projects_status_check',
      transaction,
    });
    for (const [field, name, minimum] of [
      ['version', 'projects_version_check', 1],
      ['created_at_ms', 'projects_created_at_check', 0],
      ['updated_at_ms', 'projects_updated_at_check', 0],
    ] as const) {
      await queryInterface.addConstraint(PROJECT_TABLE, {
        fields: [field],
        type: 'check',
        where: { [field]: { [Op.gte]: minimum } },
        name,
        transaction,
      });
    }
    await queryInterface.addIndex(PROJECT_TABLE, ['slug'], {
      name: PROJECT_SLUG_INDEX,
      unique: true,
      transaction,
    });
    await queryInterface.bulkInsert(PROJECT_TABLE, [manifest.baseline], {
      transaction,
    });

    await queryInterface.createTable(
      PROJECT_ROLE_BINDING_TABLE,
      {
        project_id: {
          type: DataTypes.STRING(128),
          allowNull: false,
          primaryKey: true,
          references: { model: PROJECT_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        subject_type: {
          type: DataTypes.STRING(32),
          allowNull: false,
          primaryKey: true,
        },
        subject_id: {
          type: DataTypes.STRING(255),
          allowNull: false,
          primaryKey: true,
        },
        version: {
          type: DataTypes.INTEGER,
          allowNull: false,
          primaryKey: true,
        },
        state: { type: DataTypes.STRING(16), allowNull: false },
        role: { type: DataTypes.STRING(16), allowNull: true },
        mutation_id: { type: DataTypes.STRING(64), allowNull: false },
        changed_by_type: { type: DataTypes.STRING(32), allowNull: false },
        changed_by_id: { type: DataTypes.STRING(255), allowNull: false },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    for (const [field, values, name] of [
      [
        'subject_type',
        POLICY_SUBJECT_TYPES,
        'project_role_bindings_subject_type_check',
      ],
      [
        'state',
        PROJECT_ROLE_BINDING_STATES,
        'project_role_bindings_state_check',
      ],
      ['role', PROJECT_ROLES, 'project_role_bindings_role_check'],
      [
        'changed_by_type',
        POLICY_SUBJECT_TYPES,
        'project_role_bindings_changed_by_type_check',
      ],
    ] as const) {
      await queryInterface.addConstraint(PROJECT_ROLE_BINDING_TABLE, {
        fields: [field],
        type: 'check',
        where: { [field]: { [Op.in]: values } },
        name,
        transaction,
      });
    }
    await queryInterface.addConstraint(PROJECT_ROLE_BINDING_TABLE, {
      fields: ['version'],
      type: 'check',
      where: { version: { [Op.gte]: 1 } },
      name: 'project_role_bindings_version_check',
      transaction,
    });
    await queryInterface.addConstraint(PROJECT_ROLE_BINDING_TABLE, {
      fields: ['created_at_ms'],
      type: 'check',
      where: { created_at_ms: { [Op.gte]: 0 } },
      name: 'project_role_bindings_created_at_check',
      transaction,
    });
    await queryInterface.addIndex(PROJECT_ROLE_BINDING_TABLE, {
      fields: [
        'project_id',
        'subject_type',
        'subject_id',
        { name: 'version', order: 'DESC' },
      ],
      name: PROJECT_ROLE_BINDING_CURRENT_INDEX,
      transaction,
    });
    await queryInterface.addIndex(
      PROJECT_ROLE_BINDING_TABLE,
      ['project_id', 'mutation_id'],
      {
        name: PROJECT_ROLE_BINDING_MUTATION_INDEX,
        unique: true,
        transaction,
      },
    );
    await queryInterface.addIndex(PROJECT_ROLE_BINDING_TABLE, {
      fields: [
        'subject_type',
        'subject_id',
        'project_id',
        { name: 'version', order: 'DESC' },
      ],
      name: PROJECT_ROLE_BINDING_SUBJECT_INDEX,
      transaction,
    });
  },
};
