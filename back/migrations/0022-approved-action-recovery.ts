import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import {
  APPROVED_ACTION_RECOVERY_CONTROL_STATUSES,
  APPROVED_ACTION_RECOVERY_DECISIONS,
  APPROVED_ACTION_RECOVERY_FINDINGS,
  APPROVED_ACTION_RECOVERY_SOURCES,
  MAX_APPROVED_ACTION_RECOVERY_FINDINGS,
  MAX_APPROVED_ACTION_RECOVERY_VERSION,
} from '../runtime/domain/approvedActionRecovery';
import { PROJECT_TABLE } from './0017-project-policy';
import { APPROVED_ACTION_DISPATCH_EXECUTION_TABLE } from './0021-approved-action-dispatch-executions';
import type { Migration } from './types';

export const APPROVED_ACTION_RECOVERY_CONTROL_TABLE =
  'ApprovedActionRecoveryControls';
export const APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE =
  'ApprovedActionRecoveryResolutions';
export const APPROVED_ACTION_RECOVERY_DUE_INDEX =
  'approved_action_recovery_due_idx';
export const APPROVED_ACTION_RECOVERY_PROJECT_INDEX =
  'approved_action_recovery_project_idx';
export const APPROVED_ACTION_RECOVERY_LEASE_INDEX =
  'approved_action_recovery_lease_idx';
export const APPROVED_ACTION_RECOVERY_RESOLUTION_MUTATION_INDEX =
  'approved_action_recovery_resolution_mutation_uidx';
export const APPROVED_ACTION_RECOVERY_RESOLUTION_PROJECT_INDEX =
  'approved_action_recovery_resolution_project_idx';

const controlColumns = [
  'dispatch_id',
  'project_id',
  'execution_version',
  'status',
  'version',
  'next_scan_at_ms',
  'lease_owner',
  'lease_token',
  'lease_expires_at_ms',
  'finding_count',
  'last_finding_mutation_id',
  'last_finding',
  'last_result_code',
  'last_evidence_digest',
  'resolution_mutation_id',
  'created_at_ms',
  'updated_at_ms',
];

const resolutionColumns = [
  'dispatch_id',
  'project_id',
  'execution_version',
  'mutation_id',
  'source',
  'decision',
  'evidence_digest',
  'reason_code',
  'resolved_by_type',
  'resolved_by_id',
  'resolved_at_ms',
];

const constraints = [
  'approved_action_recovery_status_check',
  'approved_action_recovery_execution_version_check',
  'approved_action_recovery_version_check',
  'approved_action_recovery_finding_count_check',
  'approved_action_recovery_lease_tuple_check',
  'approved_action_recovery_finding_tuple_check',
  'approved_action_recovery_finding_value_check',
  'approved_action_recovery_evidence_digest_check',
  'approved_action_recovery_resolution_mutation_tuple_check',
  'approved_action_recovery_timestamps_check',
  'approved_action_recovery_resolution_execution_version_check',
  'approved_action_recovery_resolution_source_check',
  'approved_action_recovery_resolution_decision_check',
  'approved_action_recovery_resolution_actor_tuple_check',
  'approved_action_recovery_resolution_source_tuple_check',
  'approved_action_recovery_resolution_evidence_digest_check',
  'approved_action_recovery_resolution_time_check',
];

const manifest = {
  tables: {
    ApprovedActionRecoveryControls: controlColumns,
    ApprovedActionRecoveryResolutions: resolutionColumns,
  },
  indexes: [
    `${APPROVED_ACTION_RECOVERY_DUE_INDEX}(status,next_scan_at_ms,dispatch_id)`,
    `${APPROVED_ACTION_RECOVERY_PROJECT_INDEX}(project_id,status,created_at_ms,dispatch_id)`,
    `${APPROVED_ACTION_RECOVERY_LEASE_INDEX}(status,lease_expires_at_ms,dispatch_id)`,
    `${APPROVED_ACTION_RECOVERY_RESOLUTION_MUTATION_INDEX}(mutation_id) UNIQUE`,
    `${APPROVED_ACTION_RECOVERY_RESOLUTION_PROJECT_INDEX}(project_id,resolved_at_ms,dispatch_id)`,
  ],
  constraints,
};

export const approvedActionRecoveryManifest = manifest;

export const approvedActionRecoveryMigration: Migration = {
  id: '0022-approved-action-recovery',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
      {
        dispatch_id: {
          type: DataTypes.STRING(64),
          allowNull: false,
          primaryKey: true,
          references: {
            model: APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
            key: 'dispatch_id',
          },
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
        execution_version: { type: DataTypes.INTEGER, allowNull: false },
        status: { type: DataTypes.STRING(24), allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false },
        next_scan_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        lease_owner: { type: DataTypes.STRING(128), allowNull: true },
        lease_token: { type: DataTypes.STRING(128), allowNull: true },
        lease_expires_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        finding_count: { type: DataTypes.INTEGER, allowNull: false },
        last_finding_mutation_id: {
          type: DataTypes.STRING(64),
          allowNull: true,
        },
        last_finding: { type: DataTypes.STRING(24), allowNull: true },
        last_result_code: { type: DataTypes.STRING(64), allowNull: true },
        last_evidence_digest: { type: DataTypes.STRING(64), allowNull: true },
        resolution_mutation_id: {
          type: DataTypes.STRING(64),
          allowNull: true,
        },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        updated_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.createTable(
      APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
      {
        dispatch_id: {
          type: DataTypes.STRING(64),
          allowNull: false,
          primaryKey: true,
          references: {
            model: APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
            key: 'dispatch_id',
          },
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
        execution_version: { type: DataTypes.INTEGER, allowNull: false },
        mutation_id: { type: DataTypes.STRING(64), allowNull: false },
        source: { type: DataTypes.STRING(24), allowNull: false },
        decision: { type: DataTypes.STRING(24), allowNull: false },
        evidence_digest: { type: DataTypes.STRING(64), allowNull: true },
        reason_code: { type: DataTypes.STRING(64), allowNull: false },
        resolved_by_type: { type: DataTypes.STRING(32), allowNull: true },
        resolved_by_id: { type: DataTypes.STRING(255), allowNull: true },
        resolved_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );

    for (const [table, field, minimum, maximum, name] of [
      [
        APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
        'execution_version',
        1,
        MAX_APPROVED_ACTION_RECOVERY_VERSION,
        'approved_action_recovery_execution_version_check',
      ],
      [
        APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
        'version',
        0,
        MAX_APPROVED_ACTION_RECOVERY_VERSION,
        'approved_action_recovery_version_check',
      ],
      [
        APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
        'finding_count',
        0,
        MAX_APPROVED_ACTION_RECOVERY_FINDINGS,
        'approved_action_recovery_finding_count_check',
      ],
      [
        APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
        'execution_version',
        1,
        MAX_APPROVED_ACTION_RECOVERY_VERSION,
        'approved_action_recovery_resolution_execution_version_check',
      ],
    ] as const) {
      await queryInterface.addConstraint(table, {
        fields: [field],
        type: 'check',
        where: { [field]: { [Op.between]: [minimum, maximum] } },
        name,
        transaction,
      });
    }
    for (const [table, field, values, name] of [
      [
        APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
        'status',
        APPROVED_ACTION_RECOVERY_CONTROL_STATUSES,
        'approved_action_recovery_status_check',
      ],
      [
        APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
        'last_finding',
        APPROVED_ACTION_RECOVERY_FINDINGS,
        'approved_action_recovery_finding_value_check',
      ],
      [
        APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
        'source',
        APPROVED_ACTION_RECOVERY_SOURCES,
        'approved_action_recovery_resolution_source_check',
      ],
      [
        APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
        'decision',
        APPROVED_ACTION_RECOVERY_DECISIONS,
        'approved_action_recovery_resolution_decision_check',
      ],
    ] as const) {
      await queryInterface.addConstraint(table, {
        fields: [field],
        type: 'check',
        where: { [field]: { [Op.in]: values } },
        name,
        transaction,
      });
    }
    await queryInterface.addConstraint(APPROVED_ACTION_RECOVERY_CONTROL_TABLE, {
      fields: ['lease_owner', 'lease_token', 'lease_expires_at_ms'],
      type: 'check',
      where: {
        [Op.or]: [
          { lease_owner: null, lease_token: null, lease_expires_at_ms: null },
          {
            lease_owner: { [Op.not]: null },
            lease_token: { [Op.not]: null },
            lease_expires_at_ms: { [Op.not]: null },
          },
        ],
      },
      name: 'approved_action_recovery_lease_tuple_check',
      transaction,
    });
    await queryInterface.addConstraint(APPROVED_ACTION_RECOVERY_CONTROL_TABLE, {
      fields: ['last_finding_mutation_id', 'last_finding', 'last_result_code'],
      type: 'check',
      where: {
        [Op.or]: [
          {
            last_finding_mutation_id: null,
            last_finding: null,
            last_result_code: null,
          },
          {
            last_finding_mutation_id: { [Op.not]: null },
            last_finding: { [Op.not]: null },
            last_result_code: { [Op.not]: null },
          },
        ],
      },
      name: 'approved_action_recovery_finding_tuple_check',
      transaction,
    });
    for (const [table, field, name] of [
      [
        APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
        'last_evidence_digest',
        'approved_action_recovery_evidence_digest_check',
      ],
      [
        APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
        'evidence_digest',
        'approved_action_recovery_resolution_evidence_digest_check',
      ],
    ] as const) {
      await queryInterface.addConstraint(table, {
        fields: [field],
        type: 'check',
        where: {
          [Op.or]: [
            { [field]: null },
            queryInterface.sequelize.where(
              queryInterface.sequelize.fn(
                'length',
                queryInterface.sequelize.col(field),
              ),
              64,
            ),
          ],
        },
        name,
        transaction,
      });
    }
    await queryInterface.addConstraint(APPROVED_ACTION_RECOVERY_CONTROL_TABLE, {
      fields: ['status', 'resolution_mutation_id'],
      type: 'check',
      where: {
        [Op.or]: [
          { status: 'resolved', resolution_mutation_id: { [Op.not]: null } },
          {
            status: { [Op.not]: 'resolved' },
            resolution_mutation_id: null,
          },
        ],
      },
      name: 'approved_action_recovery_resolution_mutation_tuple_check',
      transaction,
    });
    await queryInterface.addConstraint(APPROVED_ACTION_RECOVERY_CONTROL_TABLE, {
      fields: ['created_at_ms', 'updated_at_ms'],
      type: 'check',
      where: {
        created_at_ms: { [Op.gte]: 0 },
        updated_at_ms: { [Op.gte]: { [Op.col]: 'created_at_ms' } },
      },
      name: 'approved_action_recovery_timestamps_check',
      transaction,
    });
    await queryInterface.addConstraint(
      APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
      {
        fields: ['resolved_by_type', 'resolved_by_id'],
        type: 'check',
        where: {
          [Op.or]: [
            { resolved_by_type: null, resolved_by_id: null },
            {
              resolved_by_type: 'user',
              resolved_by_id: { [Op.not]: null },
            },
          ],
        },
        name: 'approved_action_recovery_resolution_actor_tuple_check',
        transaction,
      },
    );
    await queryInterface.addConstraint(
      APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
      {
        fields: ['source', 'decision', 'evidence_digest', 'resolved_by_type'],
        type: 'check',
        where: {
          [Op.or]: [
            {
              source: 'automatic_evidence',
              decision: {
                [Op.in]: ['confirm_succeeded', 'confirm_failed'],
              },
              evidence_digest: { [Op.not]: null },
              resolved_by_type: null,
            },
            { source: 'human', resolved_by_type: 'user' },
          ],
        },
        name: 'approved_action_recovery_resolution_source_tuple_check',
        transaction,
      },
    );
    await queryInterface.addConstraint(
      APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
      {
        fields: ['resolved_at_ms'],
        type: 'check',
        where: { resolved_at_ms: { [Op.gte]: 0 } },
        name: 'approved_action_recovery_resolution_time_check',
        transaction,
      },
    );

    await queryInterface.addIndex(
      APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
      ['status', 'next_scan_at_ms', 'dispatch_id'],
      { name: APPROVED_ACTION_RECOVERY_DUE_INDEX, transaction },
    );
    await queryInterface.addIndex(APPROVED_ACTION_RECOVERY_CONTROL_TABLE, {
      fields: ['project_id', 'status', 'created_at_ms', 'dispatch_id'],
      name: APPROVED_ACTION_RECOVERY_PROJECT_INDEX,
      transaction,
    });
    await queryInterface.addIndex(APPROVED_ACTION_RECOVERY_CONTROL_TABLE, {
      fields: ['status', 'lease_expires_at_ms', 'dispatch_id'],
      name: APPROVED_ACTION_RECOVERY_LEASE_INDEX,
      transaction,
    });
    await queryInterface.addIndex(
      APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
      ['mutation_id'],
      {
        name: APPROVED_ACTION_RECOVERY_RESOLUTION_MUTATION_INDEX,
        unique: true,
        transaction,
      },
    );
    await queryInterface.addIndex(
      APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
      ['project_id', 'resolved_at_ms', 'dispatch_id'],
      {
        name: APPROVED_ACTION_RECOVERY_RESOLUTION_PROJECT_INDEX,
        transaction,
      },
    );

    await queryInterface.sequelize.query(
      `INSERT INTO "${APPROVED_ACTION_RECOVERY_CONTROL_TABLE}"
        (dispatch_id, project_id, execution_version, status, version,
         next_scan_at_ms, lease_owner, lease_token, lease_expires_at_ms,
         finding_count, last_finding_mutation_id, last_finding,
         last_result_code, last_evidence_digest,
         resolution_mutation_id, created_at_ms, updated_at_ms)
       SELECT dispatch_id, project_id, version, 'armed', 0,
              lease_expires_at_ms, NULL, NULL, NULL,
              0, NULL, NULL, NULL, NULL, NULL, started_at_ms, started_at_ms
         FROM "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}"
        WHERE status = 'executing'`,
      { transaction },
    );
  },
};
