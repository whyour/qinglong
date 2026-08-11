import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import { POLICY_SUBJECT_TYPES } from '../runtime/domain/projectPolicy';
import { PROJECT_TABLE } from './0017-project-policy';
import type { Migration } from './types';

export const PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE =
  'ProjectOwnerBootstrapChallenges';
export const PROJECT_OWNER_BOOTSTRAP_CHALLENGE_ID_INDEX =
  'project_owner_bootstrap_challenge_id_uidx';
export const PROJECT_OWNER_BOOTSTRAP_CURRENT_INDEX =
  'project_owner_bootstrap_current_idx';

const manifest = {
  table: PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE,
  columns: [
    'project_id',
    'version',
    'challenge_id',
    'token_digest',
    'issued_at_ms',
    'expires_at_ms',
    'consumed_at_ms',
    'claimed_subject_type',
    'claimed_subject_id',
  ],
  indexes: [
    `${PROJECT_OWNER_BOOTSTRAP_CHALLENGE_ID_INDEX}(challenge_id) UNIQUE`,
    `${PROJECT_OWNER_BOOTSTRAP_CURRENT_INDEX}(project_id,version DESC)`,
  ],
  constraints: [
    'project_owner_bootstrap_version_check',
    'project_owner_bootstrap_issued_at_check',
    'project_owner_bootstrap_lifetime_check',
    'project_owner_bootstrap_claim_tuple_check',
    'project_owner_bootstrap_claimed_subject_type_check',
  ],
};

export const projectOwnerBootstrapManifest = manifest;

export const projectOwnerBootstrapMigration: Migration = {
  id: '0018-project-owner-bootstrap',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE,
      {
        project_id: {
          type: DataTypes.STRING(128),
          allowNull: false,
          primaryKey: true,
          references: { model: PROJECT_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        version: {
          type: DataTypes.INTEGER,
          allowNull: false,
          primaryKey: true,
        },
        challenge_id: { type: DataTypes.STRING(22), allowNull: false },
        token_digest: { type: DataTypes.STRING(64), allowNull: false },
        issued_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        expires_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        consumed_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        claimed_subject_type: { type: DataTypes.STRING(32), allowNull: true },
        claimed_subject_id: { type: DataTypes.STRING(255), allowNull: true },
      },
      { transaction },
    );
    await queryInterface.addConstraint(
      PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE,
      {
        fields: ['version'],
        type: 'check',
        where: { version: { [Op.gte]: 1 } },
        name: 'project_owner_bootstrap_version_check',
        transaction,
      },
    );
    await queryInterface.addConstraint(
      PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE,
      {
        fields: ['issued_at_ms'],
        type: 'check',
        where: { issued_at_ms: { [Op.gte]: 0 } },
        name: 'project_owner_bootstrap_issued_at_check',
        transaction,
      },
    );
    await queryInterface.addConstraint(
      PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE,
      {
        fields: ['expires_at_ms', 'issued_at_ms'],
        type: 'check',
        where: { expires_at_ms: { [Op.gt]: { [Op.col]: 'issued_at_ms' } } },
        name: 'project_owner_bootstrap_lifetime_check',
        transaction,
      },
    );
    await queryInterface.addConstraint(
      PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE,
      {
        fields: [
          'consumed_at_ms',
          'claimed_subject_type',
          'claimed_subject_id',
        ],
        type: 'check',
        where: {
          [Op.or]: [
            {
              consumed_at_ms: null,
              claimed_subject_type: null,
              claimed_subject_id: null,
            },
            {
              consumed_at_ms: { [Op.not]: null },
              claimed_subject_type: { [Op.not]: null },
              claimed_subject_id: { [Op.not]: null },
            },
          ],
        },
        name: 'project_owner_bootstrap_claim_tuple_check',
        transaction,
      },
    );
    await queryInterface.addConstraint(
      PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE,
      {
        fields: ['claimed_subject_type'],
        type: 'check',
        where: { claimed_subject_type: { [Op.in]: POLICY_SUBJECT_TYPES } },
        name: 'project_owner_bootstrap_claimed_subject_type_check',
        transaction,
      },
    );
    await queryInterface.addIndex(
      PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE,
      ['challenge_id'],
      {
        name: PROJECT_OWNER_BOOTSTRAP_CHALLENGE_ID_INDEX,
        unique: true,
        transaction,
      },
    );
    await queryInterface.addIndex(PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE, {
      fields: ['project_id', { name: 'version', order: 'DESC' }],
      name: PROJECT_OWNER_BOOTSTRAP_CURRENT_INDEX,
      transaction,
    });
  },
};
