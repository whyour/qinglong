import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import {
  APPROVED_ACTION_RECOVERY_STRONG_ASSURANCES,
  MAX_APPROVED_ACTION_RECOVERY_AUTH_AGE_MS,
} from '../runtime/domain/approvedActionRecoveryAuthorization';
import { PROJECT_TABLE } from './0017-project-policy';
import { APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE } from './0022-approved-action-recovery';
import type { Migration } from './types';

export const APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE =
  'ApprovedActionRecoveryAuthorizationFacts';
export const APPROVED_ACTION_RECOVERY_AUTHORIZATION_MUTATION_INDEX =
  'approved_action_recovery_authorization_mutation_uidx';
export const APPROVED_ACTION_RECOVERY_AUTHORIZATION_PROJECT_INDEX =
  'approved_action_recovery_authorization_project_idx';
export const APPROVED_ACTION_RECOVERY_AUTHORIZATION_AUTH_INDEX =
  'approved_action_recovery_authorization_auth_idx';

const columns = [
  'dispatch_id',
  'project_id',
  'mutation_id',
  'resolved_by_id',
  'authentication_id',
  'assurance',
  'authenticated_at_ms',
  'project_version',
  'binding_version',
  'authorized_at_ms',
  'fact_digest',
];

const manifest = {
  table: APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE,
  columns,
  indexes: [
    `${APPROVED_ACTION_RECOVERY_AUTHORIZATION_MUTATION_INDEX}(mutation_id) UNIQUE`,
    `${APPROVED_ACTION_RECOVERY_AUTHORIZATION_PROJECT_INDEX}(project_id,authorized_at_ms,dispatch_id)`,
    `${APPROVED_ACTION_RECOVERY_AUTHORIZATION_AUTH_INDEX}(authentication_id,authorized_at_ms,dispatch_id)`,
  ],
  constraints: [
    'approved_action_recovery_authorization_assurance_check',
    'approved_action_recovery_authorization_project_version_check',
    'approved_action_recovery_authorization_binding_version_check',
    'approved_action_recovery_authorization_recency_check',
  ],
  maxAuthenticationAgeMs: MAX_APPROVED_ACTION_RECOVERY_AUTH_AGE_MS,
};

export const approvedActionRecoveryAuthorizationManifest = manifest;

export const approvedActionRecoveryAuthorizationMigration: Migration = {
  id: '0024-approved-action-recovery-authorization',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE,
      {
        dispatch_id: {
          type: DataTypes.STRING(64),
          allowNull: false,
          primaryKey: true,
          references: {
            model: APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
            key: 'dispatch_id',
          },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        project_id: {
          type: DataTypes.STRING(128),
          allowNull: false,
          references: { model: PROJECT_TABLE, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        mutation_id: { type: DataTypes.STRING(64), allowNull: false },
        resolved_by_id: { type: DataTypes.STRING(255), allowNull: false },
        authentication_id: { type: DataTypes.STRING(128), allowNull: false },
        assurance: { type: DataTypes.STRING(32), allowNull: false },
        authenticated_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        project_version: { type: DataTypes.INTEGER, allowNull: false },
        binding_version: { type: DataTypes.INTEGER, allowNull: false },
        authorized_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        fact_digest: { type: DataTypes.STRING(64), allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(
      APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE,
      {
        fields: ['assurance'],
        type: 'check',
        where: {
          assurance: { [Op.in]: APPROVED_ACTION_RECOVERY_STRONG_ASSURANCES },
        },
        name: 'approved_action_recovery_authorization_assurance_check',
        transaction,
      },
    );
    for (const [field, name] of [
      [
        'project_version',
        'approved_action_recovery_authorization_project_version_check',
      ],
      [
        'binding_version',
        'approved_action_recovery_authorization_binding_version_check',
      ],
    ] as const) {
      await queryInterface.addConstraint(
        APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE,
        {
          fields: [field],
          type: 'check',
          where: { [field]: { [Op.between]: [1, 2_147_483_647] } },
          name,
          transaction,
        },
      );
    }
    await queryInterface.addConstraint(
      APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE,
      {
        fields: ['authenticated_at_ms', 'authorized_at_ms'],
        type: 'check',
        where: {
          authorized_at_ms: {
            [Op.gte]: { [Op.col]: 'authenticated_at_ms' },
            [Op.lte]: queryInterface.sequelize.literal(
              `authenticated_at_ms + ${MAX_APPROVED_ACTION_RECOVERY_AUTH_AGE_MS}`,
            ),
          },
        },
        name: 'approved_action_recovery_authorization_recency_check',
        transaction,
      },
    );
    await queryInterface.addIndex(
      APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE,
      ['mutation_id'],
      {
        name: APPROVED_ACTION_RECOVERY_AUTHORIZATION_MUTATION_INDEX,
        unique: true,
        transaction,
      },
    );
    await queryInterface.addIndex(
      APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE,
      ['project_id', 'authorized_at_ms', 'dispatch_id'],
      {
        name: APPROVED_ACTION_RECOVERY_AUTHORIZATION_PROJECT_INDEX,
        transaction,
      },
    );
    await queryInterface.addIndex(
      APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE,
      ['authentication_id', 'authorized_at_ms', 'dispatch_id'],
      {
        name: APPROVED_ACTION_RECOVERY_AUTHORIZATION_AUTH_INDEX,
        transaction,
      },
    );
  },
};
