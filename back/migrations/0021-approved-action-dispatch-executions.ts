import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import {
  APPROVED_ACTION_EXECUTION_STATUSES,
  DEFAULT_APPROVED_ACTION_MAX_ATTEMPTS,
  MAX_APPROVED_ACTION_ATTEMPTS,
} from '../runtime/domain/approvedActionDispatchExecution';
import { PROJECT_TABLE } from './0017-project-policy';
import { APPROVED_ACTION_DISPATCH_TABLE } from './0020-approval-requests';
import type { Migration } from './types';

export const APPROVED_ACTION_DISPATCH_EXECUTION_TABLE =
  'ApprovedActionDispatchExecutions';
export const APPROVED_ACTION_DISPATCH_EXECUTION_DUE_INDEX =
  'approved_action_execution_due_idx';
export const APPROVED_ACTION_DISPATCH_EXECUTION_PROJECT_INDEX =
  'approved_action_execution_project_idx';
export const APPROVED_ACTION_DISPATCH_EXECUTION_LEASE_INDEX =
  'approved_action_execution_lease_idx';

const columns = [
  'dispatch_id',
  'project_id',
  'status',
  'version',
  'attempt_count',
  'max_attempts',
  'eligible_at_ms',
  'next_attempt_at_ms',
  'lease_owner',
  'lease_token',
  'lease_expires_at_ms',
  'started_at_ms',
  'result_mutation_id',
  'last_result_code',
  'completed_at_ms',
  'created_at_ms',
  'updated_at_ms',
];

const manifest = {
  table: APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
  columns,
  indexes: [
    `${APPROVED_ACTION_DISPATCH_EXECUTION_DUE_INDEX}(eligible_at_ms,dispatch_id)`,
    `${APPROVED_ACTION_DISPATCH_EXECUTION_PROJECT_INDEX}(project_id,status,created_at_ms,dispatch_id)`,
    `${APPROVED_ACTION_DISPATCH_EXECUTION_LEASE_INDEX}(status,lease_expires_at_ms,dispatch_id)`,
  ],
  constraints: [
    'approved_action_execution_status_check',
    'approved_action_execution_version_check',
    'approved_action_execution_attempt_count_check',
    'approved_action_execution_max_attempts_check',
    'approved_action_execution_attempt_budget_check',
    'approved_action_execution_lease_tuple_check',
    'approved_action_execution_created_at_check',
    'approved_action_execution_updated_at_check',
  ],
  baselineMaxAttempts: DEFAULT_APPROVED_ACTION_MAX_ATTEMPTS,
};

export const approvedActionDispatchExecutionManifest = manifest;

export const approvedActionDispatchExecutionMigration: Migration = {
  id: '0021-approved-action-dispatch-executions',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
      {
        dispatch_id: {
          type: DataTypes.STRING(64),
          allowNull: false,
          primaryKey: true,
          references: { model: APPROVED_ACTION_DISPATCH_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        project_id: {
          type: DataTypes.STRING(128),
          allowNull: false,
          references: { model: PROJECT_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        status: { type: DataTypes.STRING(16), allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false },
        attempt_count: { type: DataTypes.INTEGER, allowNull: false },
        max_attempts: { type: DataTypes.INTEGER, allowNull: false },
        eligible_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        next_attempt_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        lease_owner: { type: DataTypes.STRING(128), allowNull: true },
        lease_token: { type: DataTypes.STRING(128), allowNull: true },
        lease_expires_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        started_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        result_mutation_id: { type: DataTypes.STRING(64), allowNull: true },
        last_result_code: { type: DataTypes.STRING(64), allowNull: true },
        completed_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        updated_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(
      APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
      {
        fields: ['status'],
        type: 'check',
        where: { status: { [Op.in]: APPROVED_ACTION_EXECUTION_STATUSES } },
        name: 'approved_action_execution_status_check',
        transaction,
      },
    );
    for (const [field, minimum, maximum, name] of [
      ['version', 0, 2_147_483_647, 'approved_action_execution_version_check'],
      [
        'attempt_count',
        0,
        MAX_APPROVED_ACTION_ATTEMPTS,
        'approved_action_execution_attempt_count_check',
      ],
      [
        'max_attempts',
        1,
        MAX_APPROVED_ACTION_ATTEMPTS,
        'approved_action_execution_max_attempts_check',
      ],
    ] as const) {
      await queryInterface.addConstraint(
        APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
        {
          fields: [field],
          type: 'check',
          where: { [field]: { [Op.between]: [minimum, maximum] } },
          name,
          transaction,
        },
      );
    }
    await queryInterface.addConstraint(
      APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
      {
        fields: ['attempt_count', 'max_attempts'],
        type: 'check',
        where: { attempt_count: { [Op.lte]: { [Op.col]: 'max_attempts' } } },
        name: 'approved_action_execution_attempt_budget_check',
        transaction,
      },
    );
    await queryInterface.addConstraint(
      APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
      {
        fields: ['lease_owner', 'lease_token', 'lease_expires_at_ms'],
        type: 'check',
        where: {
          [Op.or]: [
            {
              lease_owner: null,
              lease_token: null,
              lease_expires_at_ms: null,
            },
            {
              lease_owner: { [Op.not]: null },
              lease_token: { [Op.not]: null },
              lease_expires_at_ms: { [Op.not]: null },
            },
          ],
        },
        name: 'approved_action_execution_lease_tuple_check',
        transaction,
      },
    );
    await queryInterface.addConstraint(
      APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
      {
        fields: ['created_at_ms'],
        type: 'check',
        where: { created_at_ms: { [Op.gte]: 0 } },
        name: 'approved_action_execution_created_at_check',
        transaction,
      },
    );
    await queryInterface.addConstraint(
      APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
      {
        fields: ['updated_at_ms', 'created_at_ms'],
        type: 'check',
        where: { updated_at_ms: { [Op.gte]: { [Op.col]: 'created_at_ms' } } },
        name: 'approved_action_execution_updated_at_check',
        transaction,
      },
    );
    await queryInterface.addIndex(
      APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
      ['eligible_at_ms', 'dispatch_id'],
      {
        name: APPROVED_ACTION_DISPATCH_EXECUTION_DUE_INDEX,
        transaction,
      },
    );
    await queryInterface.addIndex(APPROVED_ACTION_DISPATCH_EXECUTION_TABLE, {
      fields: ['project_id', 'status', 'created_at_ms', 'dispatch_id'],
      name: APPROVED_ACTION_DISPATCH_EXECUTION_PROJECT_INDEX,
      transaction,
    });
    await queryInterface.addIndex(APPROVED_ACTION_DISPATCH_EXECUTION_TABLE, {
      fields: ['status', 'lease_expires_at_ms', 'dispatch_id'],
      name: APPROVED_ACTION_DISPATCH_EXECUTION_LEASE_INDEX,
      transaction,
    });
    await queryInterface.sequelize.query(
      `INSERT INTO "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}"
        (dispatch_id, project_id, status, version, attempt_count, max_attempts,
         eligible_at_ms, next_attempt_at_ms, lease_owner, lease_token,
         lease_expires_at_ms, started_at_ms, result_mutation_id,
         last_result_code, completed_at_ms, created_at_ms, updated_at_ms)
       SELECT id, project_id, 'pending', 0, 0, :maxAttempts,
              created_at_ms, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              created_at_ms, created_at_ms
         FROM "${APPROVED_ACTION_DISPATCH_TABLE}"`,
      {
        replacements: { maxAttempts: DEFAULT_APPROVED_ACTION_MAX_ATTEMPTS },
        transaction,
      },
    );
  },
};
