import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import type { Migration } from './types';

export const TASK_EXECUTION_REVISION_TABLE = 'TaskExecutionRevisions';
export const TASK_EXECUTION_REVISION_CREATED_INDEX =
  'task_execution_revisions_created_idx';

const manifest = {
  table: TASK_EXECUTION_REVISION_TABLE,
  columns: [
    'project_id',
    'task_id',
    'task_revision',
    'executor_type',
    'execution_template',
    'context_ref',
    'content_digest',
    'created_at_ms',
  ],
  indexes: [
    `${TASK_EXECUTION_REVISION_CREATED_INDEX}(project_id,created_at_ms,task_id,task_revision)`,
  ],
  constraints: ['task_execution_revisions_created_at_check'],
};

export const taskExecutionRevisionManifest = manifest;

export const taskExecutionRevisionMigration: Migration = {
  id: '0012-task-execution-revisions',
  checksum: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      TASK_EXECUTION_REVISION_TABLE,
      {
        project_id: {
          type: DataTypes.STRING(128),
          allowNull: false,
          primaryKey: true,
        },
        task_id: {
          type: DataTypes.STRING(255),
          allowNull: false,
          primaryKey: true,
        },
        task_revision: {
          type: DataTypes.STRING(128),
          allowNull: false,
          primaryKey: true,
        },
        executor_type: { type: DataTypes.STRING(64), allowNull: false },
        execution_template: { type: DataTypes.TEXT, allowNull: false },
        context_ref: { type: DataTypes.STRING(512), allowNull: false },
        content_digest: { type: DataTypes.STRING(64), allowNull: false },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );
    await queryInterface.addConstraint(TASK_EXECUTION_REVISION_TABLE, {
      fields: ['created_at_ms'],
      type: 'check',
      where: { created_at_ms: { [Op.gte]: 0 } },
      name: 'task_execution_revisions_created_at_check',
      transaction,
    });
    await queryInterface.addIndex(
      TASK_EXECUTION_REVISION_TABLE,
      ['project_id', 'created_at_ms', 'task_id', 'task_revision'],
      { name: TASK_EXECUTION_REVISION_CREATED_INDEX, transaction },
    );
  },
};
