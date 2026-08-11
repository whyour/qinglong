import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import {
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_STATES,
  APPROVAL_RISKS,
  APPROVED_ACTION_DISPATCH_STATES,
} from '../runtime/domain/approvalRequest';
import { POLICY_SUBJECT_TYPES } from '../runtime/domain/projectPolicy';
import { PROJECT_TABLE } from './0017-project-policy';
import type { Migration } from './types';

export const APPROVAL_REQUEST_TABLE = 'ApprovalRequests';
export const APPROVED_ACTION_DISPATCH_TABLE = 'ApprovedActionDispatches';
export const APPROVAL_REQUEST_DECISION_ID_INDEX =
  'approval_request_decision_id_uidx';
export const APPROVAL_REQUEST_CONSUMPTION_ID_INDEX =
  'approval_request_consumption_id_uidx';
export const APPROVAL_REQUEST_PENDING_INDEX = 'approval_request_pending_idx';
export const APPROVAL_REQUEST_REQUESTER_INDEX =
  'approval_request_requester_idx';
export const APPROVED_ACTION_DISPATCH_REQUEST_INDEX =
  'approved_action_dispatch_request_uidx';
export const APPROVED_ACTION_DISPATCH_PENDING_INDEX =
  'approved_action_dispatch_pending_idx';

const approvalRequestColumns = [
  'id',
  'project_id',
  'version',
  'state',
  'permission',
  'action_type',
  'action_ref',
  'action_digest',
  'preview_digest',
  'risk',
  'requested_by_type',
  'requested_by_id',
  'requested_at_ms',
  'expires_at_ms',
  'decision_id',
  'decision',
  'decision_reason_code',
  'decided_by_type',
  'decided_by_id',
  'decided_at_ms',
  'consumption_id',
  'dispatch_id',
  'consumed_by_type',
  'consumed_by_id',
  'consumed_at_ms',
];

const approvedActionDispatchColumns = [
  'id',
  'approval_request_id',
  'approval_request_version',
  'project_id',
  'state',
  'permission',
  'action_type',
  'action_ref',
  'action_digest',
  'preview_digest',
  'requested_by_type',
  'requested_by_id',
  'consumed_by_type',
  'consumed_by_id',
  'created_at_ms',
];

const constraints = [
  'approval_request_version_check',
  'approval_request_state_check',
  'approval_request_risk_check',
  'approval_request_requester_type_check',
  'approval_request_lifetime_check',
  'approval_request_decision_tuple_check',
  'approval_request_decision_value_check',
  'approval_request_decided_by_type_check',
  'approval_request_decision_time_check',
  'approval_request_consumption_tuple_check',
  'approval_request_consumed_by_type_check',
  'approval_request_consumption_time_check',
  'approval_request_state_tuple_check',
  'approved_action_dispatch_version_check',
  'approved_action_dispatch_state_check',
  'approved_action_dispatch_requester_type_check',
  'approved_action_dispatch_consumer_type_check',
  'approved_action_dispatch_created_at_check',
];

const manifest = {
  tables: {
    ApprovalRequests: approvalRequestColumns,
    ApprovedActionDispatches: approvedActionDispatchColumns,
  },
  indexes: [
    `${APPROVAL_REQUEST_DECISION_ID_INDEX}(decision_id) UNIQUE`,
    `${APPROVAL_REQUEST_CONSUMPTION_ID_INDEX}(consumption_id) UNIQUE`,
    `${APPROVAL_REQUEST_PENDING_INDEX}(project_id,state,expires_at_ms,id)`,
    `${APPROVAL_REQUEST_REQUESTER_INDEX}(project_id,requested_by_type,requested_by_id,requested_at_ms DESC,id)`,
    `${APPROVED_ACTION_DISPATCH_REQUEST_INDEX}(approval_request_id) UNIQUE`,
    `${APPROVED_ACTION_DISPATCH_PENDING_INDEX}(project_id,state,created_at_ms,id)`,
  ],
  constraints,
};

export const approvalRequestManifest = manifest;

function nullableTuple(...fields: string[]) {
  return {
    [Op.or]: [
      Object.fromEntries(fields.map((field) => [field, null])),
      Object.fromEntries(fields.map((field) => [field, { [Op.not]: null }])),
    ],
  };
}

export const approvalRequestMigration: Migration = {
  id: '0020-approval-requests',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      APPROVAL_REQUEST_TABLE,
      {
        id: { type: DataTypes.STRING(64), allowNull: false, primaryKey: true },
        project_id: {
          type: DataTypes.STRING(128),
          allowNull: false,
          references: { model: PROJECT_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        version: { type: DataTypes.INTEGER, allowNull: false },
        state: { type: DataTypes.STRING(16), allowNull: false },
        permission: { type: DataTypes.STRING(255), allowNull: false },
        action_type: { type: DataTypes.STRING(64), allowNull: false },
        action_ref: { type: DataTypes.STRING(255), allowNull: false },
        action_digest: { type: DataTypes.STRING(64), allowNull: false },
        preview_digest: { type: DataTypes.STRING(64), allowNull: false },
        risk: { type: DataTypes.STRING(16), allowNull: false },
        requested_by_type: { type: DataTypes.STRING(32), allowNull: false },
        requested_by_id: { type: DataTypes.STRING(255), allowNull: false },
        requested_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        expires_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        decision_id: { type: DataTypes.STRING(64), allowNull: true },
        decision: { type: DataTypes.STRING(16), allowNull: true },
        decision_reason_code: { type: DataTypes.STRING(64), allowNull: true },
        decided_by_type: { type: DataTypes.STRING(32), allowNull: true },
        decided_by_id: { type: DataTypes.STRING(255), allowNull: true },
        decided_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        consumption_id: { type: DataTypes.STRING(64), allowNull: true },
        dispatch_id: { type: DataTypes.STRING(64), allowNull: true },
        consumed_by_type: { type: DataTypes.STRING(32), allowNull: true },
        consumed_by_id: { type: DataTypes.STRING(255), allowNull: true },
        consumed_at_ms: { type: DataTypes.BIGINT, allowNull: true },
      },
      { transaction },
    );
    await queryInterface.addConstraint(APPROVAL_REQUEST_TABLE, {
      fields: ['version'],
      type: 'check',
      where: { version: { [Op.between]: [1, 3] } },
      name: 'approval_request_version_check',
      transaction,
    });
    for (const [field, values, name] of [
      ['state', APPROVAL_REQUEST_STATES, 'approval_request_state_check'],
      ['risk', APPROVAL_RISKS, 'approval_request_risk_check'],
      [
        'requested_by_type',
        POLICY_SUBJECT_TYPES,
        'approval_request_requester_type_check',
      ],
      [
        'decided_by_type',
        POLICY_SUBJECT_TYPES,
        'approval_request_decided_by_type_check',
      ],
      [
        'consumed_by_type',
        POLICY_SUBJECT_TYPES,
        'approval_request_consumed_by_type_check',
      ],
    ] as const) {
      await queryInterface.addConstraint(APPROVAL_REQUEST_TABLE, {
        fields: [field],
        type: 'check',
        where: { [field]: { [Op.in]: values } },
        name,
        transaction,
      });
    }
    await queryInterface.addConstraint(APPROVAL_REQUEST_TABLE, {
      fields: ['requested_at_ms', 'expires_at_ms'],
      type: 'check',
      where: {
        requested_at_ms: { [Op.gte]: 0 },
        expires_at_ms: { [Op.gt]: { [Op.col]: 'requested_at_ms' } },
      },
      name: 'approval_request_lifetime_check',
      transaction,
    });
    await queryInterface.addConstraint(APPROVAL_REQUEST_TABLE, {
      fields: [
        'decision_id',
        'decision',
        'decision_reason_code',
        'decided_by_type',
        'decided_by_id',
        'decided_at_ms',
      ],
      type: 'check',
      where: nullableTuple(
        'decision_id',
        'decision',
        'decision_reason_code',
        'decided_by_type',
        'decided_by_id',
        'decided_at_ms',
      ),
      name: 'approval_request_decision_tuple_check',
      transaction,
    });
    await queryInterface.addConstraint(APPROVAL_REQUEST_TABLE, {
      fields: ['decision'],
      type: 'check',
      where: { decision: { [Op.in]: APPROVAL_DECISIONS } },
      name: 'approval_request_decision_value_check',
      transaction,
    });
    await queryInterface.addConstraint(APPROVAL_REQUEST_TABLE, {
      fields: ['decided_at_ms', 'requested_at_ms', 'expires_at_ms'],
      type: 'check',
      where: {
        [Op.or]: [
          { decided_at_ms: null },
          {
            decided_at_ms: {
              [Op.gte]: { [Op.col]: 'requested_at_ms' },
              [Op.lt]: { [Op.col]: 'expires_at_ms' },
            },
          },
        ],
      },
      name: 'approval_request_decision_time_check',
      transaction,
    });
    await queryInterface.addConstraint(APPROVAL_REQUEST_TABLE, {
      fields: [
        'consumption_id',
        'dispatch_id',
        'consumed_by_type',
        'consumed_by_id',
        'consumed_at_ms',
      ],
      type: 'check',
      where: nullableTuple(
        'consumption_id',
        'dispatch_id',
        'consumed_by_type',
        'consumed_by_id',
        'consumed_at_ms',
      ),
      name: 'approval_request_consumption_tuple_check',
      transaction,
    });
    await queryInterface.addConstraint(APPROVAL_REQUEST_TABLE, {
      fields: ['consumed_at_ms', 'decided_at_ms', 'expires_at_ms'],
      type: 'check',
      where: {
        [Op.or]: [
          { consumed_at_ms: null },
          {
            consumed_at_ms: {
              [Op.gte]: { [Op.col]: 'decided_at_ms' },
              [Op.lt]: { [Op.col]: 'expires_at_ms' },
            },
          },
        ],
      },
      name: 'approval_request_consumption_time_check',
      transaction,
    });
    await queryInterface.addConstraint(APPROVAL_REQUEST_TABLE, {
      fields: ['state', 'version', 'decision', 'decision_id', 'consumption_id'],
      type: 'check',
      where: {
        [Op.or]: [
          {
            state: 'pending',
            version: 1,
            decision_id: null,
            consumption_id: null,
          },
          {
            state: 'approved',
            version: 2,
            decision: 'approved',
            consumption_id: null,
          },
          {
            state: 'rejected',
            version: 2,
            decision: 'rejected',
            consumption_id: null,
          },
          {
            state: 'consumed',
            version: 3,
            decision: 'approved',
            consumption_id: { [Op.not]: null },
          },
        ],
      },
      name: 'approval_request_state_tuple_check',
      transaction,
    });

    await queryInterface.addIndex(APPROVAL_REQUEST_TABLE, ['decision_id'], {
      name: APPROVAL_REQUEST_DECISION_ID_INDEX,
      unique: true,
      transaction,
    });
    await queryInterface.addIndex(APPROVAL_REQUEST_TABLE, ['consumption_id'], {
      name: APPROVAL_REQUEST_CONSUMPTION_ID_INDEX,
      unique: true,
      transaction,
    });
    await queryInterface.addIndex(APPROVAL_REQUEST_TABLE, {
      fields: ['project_id', 'state', 'expires_at_ms', 'id'],
      name: APPROVAL_REQUEST_PENDING_INDEX,
      transaction,
    });
    await queryInterface.addIndex(APPROVAL_REQUEST_TABLE, {
      fields: [
        'project_id',
        'requested_by_type',
        'requested_by_id',
        { name: 'requested_at_ms', order: 'DESC' },
        'id',
      ],
      name: APPROVAL_REQUEST_REQUESTER_INDEX,
      transaction,
    });

    await queryInterface.createTable(
      APPROVED_ACTION_DISPATCH_TABLE,
      {
        id: { type: DataTypes.STRING(64), allowNull: false, primaryKey: true },
        approval_request_id: {
          type: DataTypes.STRING(64),
          allowNull: false,
          references: { model: APPROVAL_REQUEST_TABLE, key: 'id' },
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
        approval_request_version: { type: DataTypes.INTEGER, allowNull: false },
        project_id: {
          type: DataTypes.STRING(128),
          allowNull: false,
          references: { model: PROJECT_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        state: { type: DataTypes.STRING(16), allowNull: false },
        permission: { type: DataTypes.STRING(255), allowNull: false },
        action_type: { type: DataTypes.STRING(64), allowNull: false },
        action_ref: { type: DataTypes.STRING(255), allowNull: false },
        action_digest: { type: DataTypes.STRING(64), allowNull: false },
        preview_digest: { type: DataTypes.STRING(64), allowNull: false },
        requested_by_type: { type: DataTypes.STRING(32), allowNull: false },
        requested_by_id: { type: DataTypes.STRING(255), allowNull: false },
        consumed_by_type: { type: DataTypes.STRING(32), allowNull: false },
        consumed_by_id: { type: DataTypes.STRING(255), allowNull: false },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(APPROVED_ACTION_DISPATCH_TABLE, {
      fields: ['approval_request_version'],
      type: 'check',
      where: { approval_request_version: 3 },
      name: 'approved_action_dispatch_version_check',
      transaction,
    });
    for (const [field, values, name] of [
      [
        'state',
        APPROVED_ACTION_DISPATCH_STATES,
        'approved_action_dispatch_state_check',
      ],
      [
        'requested_by_type',
        POLICY_SUBJECT_TYPES,
        'approved_action_dispatch_requester_type_check',
      ],
      [
        'consumed_by_type',
        POLICY_SUBJECT_TYPES,
        'approved_action_dispatch_consumer_type_check',
      ],
    ] as const) {
      await queryInterface.addConstraint(APPROVED_ACTION_DISPATCH_TABLE, {
        fields: [field],
        type: 'check',
        where: { [field]: { [Op.in]: values } },
        name,
        transaction,
      });
    }
    await queryInterface.addConstraint(APPROVED_ACTION_DISPATCH_TABLE, {
      fields: ['created_at_ms'],
      type: 'check',
      where: { created_at_ms: { [Op.gte]: 0 } },
      name: 'approved_action_dispatch_created_at_check',
      transaction,
    });
    await queryInterface.addIndex(
      APPROVED_ACTION_DISPATCH_TABLE,
      ['approval_request_id'],
      {
        name: APPROVED_ACTION_DISPATCH_REQUEST_INDEX,
        unique: true,
        transaction,
      },
    );
    await queryInterface.addIndex(APPROVED_ACTION_DISPATCH_TABLE, {
      fields: ['project_id', 'state', 'created_at_ms', 'id'],
      name: APPROVED_ACTION_DISPATCH_PENDING_INDEX,
      transaction,
    });
  },
};
