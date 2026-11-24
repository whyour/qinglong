import { DataTypes, Sequelize } from 'sequelize';
import type { CronInstance } from './cron';
import type { RunningInstanceModel } from './runningInstance';
import type { CrontabStatInstance } from './cronStats';
import type { SystemInstance } from './system';

export function defineCrontabModel(database: Sequelize) {
  return database.define<CronInstance>('Crontab', {
    name: {
      unique: 'compositeIndex',
      type: DataTypes.STRING,
    },
    command: {
      unique: 'compositeIndex',
      type: DataTypes.STRING,
    },
    schedule: {
      unique: 'compositeIndex',
      type: DataTypes.STRING,
    },
    timestamp: DataTypes.STRING,
    saved: DataTypes.BOOLEAN,
    status: DataTypes.NUMBER,
    isSystem: DataTypes.NUMBER,
    pid: DataTypes.NUMBER,
    isDisabled: DataTypes.NUMBER,
    isPinned: DataTypes.NUMBER,
    log_path: DataTypes.STRING,
    queued_token: DataTypes.STRING,
    labels: DataTypes.JSON,
    last_instance_id: DataTypes.INTEGER,
    last_running_time: DataTypes.NUMBER,
    last_execution_time: DataTypes.NUMBER,
    sub_id: { type: DataTypes.NUMBER, allowNull: true },
    extra_schedules: DataTypes.JSON,
    task_before: DataTypes.STRING,
    task_after: DataTypes.STRING,
    log_name: DataTypes.STRING,
    allow_multiple_instances: DataTypes.NUMBER,
    skip_if_pending: DataTypes.BOOLEAN,
    max_queue_wait: DataTypes.INTEGER,
    catchup_seconds: DataTypes.INTEGER,
    recovery_from: DataTypes.BIGINT,
    work_dir: DataTypes.STRING,
  });
}

export function defineRunningInstanceModel(database: Sequelize) {
  return database.define<RunningInstanceModel>(
    'RunningInstance',
    {
      cron_id: {
        type: DataTypes.NUMBER,
        allowNull: false,
      },
      pid: {
        type: DataTypes.NUMBER,
        allowNull: true,
      },
      log_path: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      started_at: {
        type: DataTypes.NUMBER,
        allowNull: false,
      },
      finished_at: {
        type: DataTypes.NUMBER,
        allowNull: true,
      },
      status: {
        type: DataTypes.NUMBER,
        allowNull: false,
        defaultValue: 0,
      },
      exit_code: {
        type: DataTypes.NUMBER,
        allowNull: true,
      },
    },
    {
      indexes: [
        { fields: ['cron_id', 'pid', 'started_at'] },
        { fields: ['cron_id', 'id'] },
        // Settlement looks for live siblings while holding the writer transaction.
        // Finished history must not make that lookup scan every past execution.
        {
          name: 'running_instances_active_cron_id',
          fields: ['cron_id', 'id'],
          where: { status: 0 },
        },
      ],
    },
  );
}

export function defineCrontabStatModel(database: Sequelize) {
  return database.define<CrontabStatInstance>(
    'CrontabStat',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      ref_id: {
        type: DataTypes.NUMBER,
        allowNull: false,
      },
      date: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      run_count: {
        type: DataTypes.NUMBER,
        defaultValue: 0,
      },
      success_count: {
        type: DataTypes.NUMBER,
        defaultValue: 0,
      },
      fail_count: {
        type: DataTypes.NUMBER,
        defaultValue: 0,
      },
      untimed_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      total_time: {
        type: DataTypes.NUMBER,
        defaultValue: 0,
      },
      fixed_max_time: { type: DataTypes.NUMBER, allowNull: true },
      max_time: {
        type: DataTypes.NUMBER,
        defaultValue: 0,
      },
    },
    {
      indexes: [
        { unique: true, fields: ['ref_id', 'date'] },
        { fields: ['date'] },
      ],
    },
  );
}

export function defineSystemModel(database: Sequelize) {
  return database.define<SystemInstance>('Auth', {
    ip: DataTypes.STRING,
    type: DataTypes.STRING,
    info: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  });
}
