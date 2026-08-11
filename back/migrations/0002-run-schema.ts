import { createHash } from 'crypto';
import { DataTypes, Op } from 'sequelize';
import type { Migration } from './types';

export const RUN_TABLE = 'Runs';
export const RUN_ATTEMPT_TABLE = 'RunAttempts';
export const RUN_EVENT_TABLE = 'RunEvents';

const schemaManifest = {
  version: 1,
  tables: {
    Runs: [
      'id',
      'project_id',
      'task_id',
      'task_revision',
      'task_name',
      'task_snapshot_ref',
      'legacy_cron_id',
      'parent_run_id',
      'retry_of_run_id',
      'trigger_id',
      'trigger_type',
      'execution_origin',
      'execution_owner',
      'triggered_by',
      'request_id',
      'scheduled_for_ms',
      'status',
      'version',
      'event_sequence',
      'priority',
      'idempotency_key',
      'input_ref',
      'output_ref',
      'created_at_ms',
      'queued_at_ms',
      'started_at_ms',
      'finished_at_ms',
      'error_code',
      'error_summary',
    ],
    RunAttempts: [
      'id',
      'run_id',
      'step_run_id',
      'attempt',
      'status',
      'executor_type',
      'worker_id',
      'executor_handle',
      'pid',
      'log_artifact_id',
      'lease_token',
      'lease_expires_at_ms',
      'callback_token_hash',
      'callback_sequence',
      'created_at_ms',
      'started_at_ms',
      'finished_at_ms',
      'exit_code',
      'error_code',
      'error_summary',
    ],
    RunEvents: [
      'id',
      'run_id',
      'sequence',
      'type',
      'dedupe_key',
      'actor_type',
      'actor_id',
      'attempt_id',
      'step_run_id',
      'payload',
      'created_at_ms',
    ],
  },
  indexes: [
    'runs_project_created_idx',
    'runs_task_created_idx',
    'runs_status_queued_idx',
    'runs_legacy_cron_created_idx',
    'runs_project_idempotency_uidx',
    'run_attempts_run_attempt_uidx',
    'run_attempts_run_status_idx',
    'run_attempts_status_created_idx',
    'run_attempts_lease_idx',
    'run_events_run_sequence_uidx',
    'run_events_run_dedupe_uidx',
    'run_events_run_created_idx',
  ],
  constraints: [
    'runs_version_nonnegative_check',
    'runs_event_sequence_nonnegative_check',
    'run_attempts_attempt_positive_check',
    'run_attempts_callback_sequence_nonnegative_check',
    'run_events_sequence_positive_check',
  ],
};

export const runSchemaManifest = schemaManifest;

export const runSchemaMigration: Migration = {
  id: '0002-run-schema',
  checksum: createHash('sha256')
    .update(JSON.stringify(schemaManifest))
    .digest('hex'),
  async up({ queryInterface, transaction }) {
    await queryInterface.createTable(
      RUN_TABLE,
      {
        id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true },
        project_id: { type: DataTypes.STRING(128), allowNull: false },
        task_id: { type: DataTypes.STRING(255), allowNull: false },
        task_revision: { type: DataTypes.STRING(128), allowNull: false },
        task_name: { type: DataTypes.STRING(255), allowNull: true },
        task_snapshot_ref: { type: DataTypes.STRING(512), allowNull: true },
        legacy_cron_id: { type: DataTypes.INTEGER, allowNull: true },
        parent_run_id: { type: DataTypes.STRING(36), allowNull: true },
        retry_of_run_id: { type: DataTypes.STRING(36), allowNull: true },
        trigger_id: { type: DataTypes.STRING(36), allowNull: true },
        trigger_type: { type: DataTypes.STRING(64), allowNull: false },
        execution_origin: { type: DataTypes.STRING(64), allowNull: false },
        execution_owner: { type: DataTypes.STRING(16), allowNull: false },
        triggered_by: { type: DataTypes.STRING(255), allowNull: true },
        request_id: { type: DataTypes.STRING(128), allowNull: true },
        scheduled_for_ms: { type: DataTypes.BIGINT, allowNull: true },
        status: { type: DataTypes.STRING(32), allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        event_sequence: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        priority: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        idempotency_key: { type: DataTypes.STRING(255), allowNull: true },
        input_ref: { type: DataTypes.STRING(512), allowNull: true },
        output_ref: { type: DataTypes.STRING(512), allowNull: true },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        queued_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        started_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        finished_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        error_code: { type: DataTypes.STRING(128), allowNull: true },
        error_summary: { type: DataTypes.STRING(1024), allowNull: true },
      },
      { transaction },
    );

    await queryInterface.createTable(
      RUN_ATTEMPT_TABLE,
      {
        id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true },
        run_id: {
          type: DataTypes.STRING(36),
          allowNull: false,
          references: { model: RUN_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        step_run_id: { type: DataTypes.STRING(36), allowNull: true },
        attempt: { type: DataTypes.INTEGER, allowNull: false },
        status: { type: DataTypes.STRING(32), allowNull: false },
        executor_type: { type: DataTypes.STRING(64), allowNull: false },
        worker_id: { type: DataTypes.STRING(128), allowNull: true },
        executor_handle: { type: DataTypes.TEXT, allowNull: true },
        pid: { type: DataTypes.INTEGER, allowNull: true },
        log_artifact_id: { type: DataTypes.STRING(36), allowNull: true },
        lease_token: { type: DataTypes.STRING(128), allowNull: true },
        lease_expires_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        callback_token_hash: { type: DataTypes.STRING(128), allowNull: true },
        callback_sequence: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
        started_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        finished_at_ms: { type: DataTypes.BIGINT, allowNull: true },
        exit_code: { type: DataTypes.INTEGER, allowNull: true },
        error_code: { type: DataTypes.STRING(128), allowNull: true },
        error_summary: { type: DataTypes.STRING(1024), allowNull: true },
      },
      { transaction },
    );

    await queryInterface.createTable(
      RUN_EVENT_TABLE,
      {
        id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true },
        run_id: {
          type: DataTypes.STRING(36),
          allowNull: false,
          references: { model: RUN_TABLE, key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        sequence: { type: DataTypes.INTEGER, allowNull: false },
        type: { type: DataTypes.STRING(128), allowNull: false },
        dedupe_key: { type: DataTypes.STRING(255), allowNull: true },
        actor_type: { type: DataTypes.STRING(64), allowNull: false },
        actor_id: { type: DataTypes.STRING(255), allowNull: true },
        attempt_id: {
          type: DataTypes.STRING(36),
          allowNull: true,
          references: { model: RUN_ATTEMPT_TABLE, key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        step_run_id: { type: DataTypes.STRING(36), allowNull: true },
        payload: { type: DataTypes.JSON, allowNull: false },
        created_at_ms: { type: DataTypes.BIGINT, allowNull: false },
      },
      { transaction },
    );

    await queryInterface.addConstraint(RUN_TABLE, {
      fields: ['version'],
      type: 'check',
      where: { version: { [Op.gte]: 0 } },
      name: 'runs_version_nonnegative_check',
      transaction,
    });
    await queryInterface.addConstraint(RUN_TABLE, {
      fields: ['event_sequence'],
      type: 'check',
      where: { event_sequence: { [Op.gte]: 0 } },
      name: 'runs_event_sequence_nonnegative_check',
      transaction,
    });
    await queryInterface.addConstraint(RUN_ATTEMPT_TABLE, {
      fields: ['attempt'],
      type: 'check',
      where: { attempt: { [Op.gte]: 1 } },
      name: 'run_attempts_attempt_positive_check',
      transaction,
    });
    await queryInterface.addConstraint(RUN_ATTEMPT_TABLE, {
      fields: ['callback_sequence'],
      type: 'check',
      where: { callback_sequence: { [Op.gte]: 0 } },
      name: 'run_attempts_callback_sequence_nonnegative_check',
      transaction,
    });
    await queryInterface.addConstraint(RUN_EVENT_TABLE, {
      fields: ['sequence'],
      type: 'check',
      where: { sequence: { [Op.gte]: 1 } },
      name: 'run_events_sequence_positive_check',
      transaction,
    });

    await queryInterface.addIndex(RUN_TABLE, ['project_id', 'created_at_ms'], {
      name: 'runs_project_created_idx',
      transaction,
    });
    await queryInterface.addIndex(RUN_TABLE, ['task_id', 'created_at_ms'], {
      name: 'runs_task_created_idx',
      transaction,
    });
    await queryInterface.addIndex(RUN_TABLE, ['status', 'queued_at_ms'], {
      name: 'runs_status_queued_idx',
      transaction,
    });
    await queryInterface.addIndex(
      RUN_TABLE,
      ['legacy_cron_id', 'created_at_ms'],
      { name: 'runs_legacy_cron_created_idx', transaction },
    );
    await queryInterface.addIndex(
      RUN_TABLE,
      ['project_id', 'idempotency_key'],
      {
        name: 'runs_project_idempotency_uidx',
        unique: true,
        transaction,
      },
    );

    await queryInterface.addIndex(RUN_ATTEMPT_TABLE, ['run_id', 'attempt'], {
      name: 'run_attempts_run_attempt_uidx',
      unique: true,
      transaction,
    });
    await queryInterface.addIndex(RUN_ATTEMPT_TABLE, ['run_id', 'status'], {
      name: 'run_attempts_run_status_idx',
      transaction,
    });
    await queryInterface.addIndex(
      RUN_ATTEMPT_TABLE,
      ['status', 'created_at_ms'],
      { name: 'run_attempts_status_created_idx', transaction },
    );
    await queryInterface.addIndex(RUN_ATTEMPT_TABLE, ['lease_expires_at_ms'], {
      name: 'run_attempts_lease_idx',
      transaction,
    });

    await queryInterface.addIndex(RUN_EVENT_TABLE, ['run_id', 'sequence'], {
      name: 'run_events_run_sequence_uidx',
      unique: true,
      transaction,
    });
    await queryInterface.addIndex(RUN_EVENT_TABLE, ['run_id', 'dedupe_key'], {
      name: 'run_events_run_dedupe_uidx',
      unique: true,
      transaction,
    });
    await queryInterface.addIndex(
      RUN_EVENT_TABLE,
      ['run_id', 'created_at_ms'],
      { name: 'run_events_run_created_idx', transaction },
    );
  },
};
