import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import {
  APPROVED_RUN_ACTION_TYPE,
  APPROVED_RUN_RECEIPT_RESULT_CODE,
  APPROVED_RUN_RECEIPT_SCHEMA_VERSION,
} from '../runtime/domain/approvedRunAction';
import { PROJECT_TABLE } from './0017-project-policy';
import {
  APPROVAL_REQUEST_TABLE,
  APPROVED_ACTION_DISPATCH_TABLE,
} from './0020-approval-requests';
import { RUN_TABLE } from './0002-run-schema';
import type { Migration } from './types';

export const APPROVED_RUN_ACTION_RECEIPT_TABLE = 'ApprovedRunActionReceipts';
export const APPROVED_RUN_ACTION_RECEIPT_PROJECT_INDEX =
  'approved_run_receipt_project_idx';
export const APPROVED_RUN_ACTION_RECEIPT_RESOURCE_UNIQUE_INDEX =
  'approved_run_receipt_resource_uidx';

const columns = [
  'dispatch_id',
  'approval_request_id',
  'project_id',
  'schema_version',
  'action_type',
  'action_digest',
  'execution_attempt',
  'execution_version',
  'started_at_ms',
  'idempotency_key',
  'outcome',
  'result_code',
  'resource_type',
  'resource_id',
  'finished_at_ms',
  'evidence_digest',
  'created_at_ms',
];

const manifest = {
  table: APPROVED_RUN_ACTION_RECEIPT_TABLE,
  columns,
  indexes: [
    `${APPROVED_RUN_ACTION_RECEIPT_PROJECT_INDEX}(project_id,created_at_ms,dispatch_id)`,
    `${APPROVED_RUN_ACTION_RECEIPT_RESOURCE_UNIQUE_INDEX}(resource_type,resource_id)`,
  ],
  constraints: [
    'approved_run_receipt_schema_version_check',
    'approved_run_receipt_action_type_check',
    'approved_run_receipt_execution_attempt_check',
    'approved_run_receipt_execution_version_check',
    'approved_run_receipt_idempotency_check',
    'approved_run_receipt_outcome_check',
    'approved_run_receipt_result_code_check',
    'approved_run_receipt_resource_type_check',
    'approved_run_receipt_timestamps_check',
  ],
};

export const approvedRunActionReceiptManifest = manifest;

export const approvedRunActionReceiptMigration: Migration = {
  id: '0023-approved-run-action-receipts',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      APPROVED_RUN_ACTION_RECEIPT_TABLE,
      {
        dispatch_id: {
          type: DataTypes.STRING(64),
          allowNull: false,
          primaryKey: true,
          references: { model: APPROVED_ACTION_DISPATCH_TABLE, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        approval_request_id: {
          type: DataTypes.STRING(64),
          allowNull: false,
          references: { model: APPROVAL_REQUEST_TABLE, key: 'id' },
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
        schema_version: { type: DataTypes.INTEGER, allowNull: false },
        action_type: { type: DataTypes.STRING(64), allowNull: false },
        action_digest: { type: DataTypes.STRING(64), allowNull: false },
        execution_attempt: { type: DataTypes.INTEGER, allowNull: false },
        execution_version: { type: DataTypes.INTEGER, allowNull: false },
        started_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        idempotency_key: { type: DataTypes.STRING(64), allowNull: false },
        outcome: { type: DataTypes.STRING(16), allowNull: false },
        result_code: { type: DataTypes.STRING(64), allowNull: false },
        resource_type: { type: DataTypes.STRING(16), allowNull: false },
        resource_id: {
          type: DataTypes.STRING(64),
          allowNull: false,
          references: { model: RUN_TABLE, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        finished_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        evidence_digest: { type: DataTypes.STRING(64), allowNull: false },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    for (const [field, value, name] of [
      [
        'schema_version',
        APPROVED_RUN_RECEIPT_SCHEMA_VERSION,
        'approved_run_receipt_schema_version_check',
      ],
      [
        'action_type',
        APPROVED_RUN_ACTION_TYPE,
        'approved_run_receipt_action_type_check',
      ],
      ['outcome', 'succeeded', 'approved_run_receipt_outcome_check'],
      [
        'result_code',
        APPROVED_RUN_RECEIPT_RESULT_CODE,
        'approved_run_receipt_result_code_check',
      ],
      ['resource_type', 'run', 'approved_run_receipt_resource_type_check'],
    ] as const) {
      await queryInterface.addConstraint(APPROVED_RUN_ACTION_RECEIPT_TABLE, {
        fields: [field],
        type: 'check',
        where: { [field]: value },
        name,
        transaction,
      });
    }
    for (const [field, maximum, name] of [
      ['execution_attempt', 16, 'approved_run_receipt_execution_attempt_check'],
      [
        'execution_version',
        2_147_483_647,
        'approved_run_receipt_execution_version_check',
      ],
    ] as const) {
      await queryInterface.addConstraint(APPROVED_RUN_ACTION_RECEIPT_TABLE, {
        fields: [field],
        type: 'check',
        where: { [field]: { [Op.between]: [1, maximum] } },
        name,
        transaction,
      });
    }
    await queryInterface.addConstraint(APPROVED_RUN_ACTION_RECEIPT_TABLE, {
      fields: ['dispatch_id', 'idempotency_key'],
      type: 'check',
      where: { idempotency_key: { [Op.eq]: { [Op.col]: 'dispatch_id' } } },
      name: 'approved_run_receipt_idempotency_check',
      transaction,
    });
    await queryInterface.addConstraint(APPROVED_RUN_ACTION_RECEIPT_TABLE, {
      fields: ['started_at_ms', 'finished_at_ms', 'created_at_ms'],
      type: 'check',
      where: {
        finished_at_ms: { [Op.gte]: { [Op.col]: 'started_at_ms' } },
        created_at_ms: { [Op.eq]: { [Op.col]: 'finished_at_ms' } },
      },
      name: 'approved_run_receipt_timestamps_check',
      transaction,
    });
    await queryInterface.addIndex(APPROVED_RUN_ACTION_RECEIPT_TABLE, {
      fields: ['project_id', 'created_at_ms', 'dispatch_id'],
      name: APPROVED_RUN_ACTION_RECEIPT_PROJECT_INDEX,
      transaction,
    });
    await queryInterface.addIndex(APPROVED_RUN_ACTION_RECEIPT_TABLE, {
      fields: ['resource_type', 'resource_id'],
      unique: true,
      name: APPROVED_RUN_ACTION_RECEIPT_RESOURCE_UNIQUE_INDEX,
      transaction,
    });
  },
};
