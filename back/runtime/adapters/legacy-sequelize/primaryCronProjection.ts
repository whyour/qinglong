import {
  DataTypes,
  Model,
  type ModelStatic,
  Op,
  type Sequelize,
  type Transaction,
} from 'sequelize';
import {
  RUN_ATTEMPT_TABLE,
  RUN_TABLE,
} from '../../../migrations/0002-run-schema';
import { RUNNING_INSTANCE_TABLE } from '../../../migrations/0003-running-instance-run-reference';
import type { RunAttemptStatus, RunStatus } from '../../domain/run';
import { parseLegacyLogOutputRef } from '../../compatibility/legacyLogOutputRef';
import type {
  SequelizeRunProjectionContext,
  SequelizeRunProjectionParticipant,
} from './projectedRunRepository';

const CRONTAB_TABLE = 'Crontabs';
const CRONTAB_STATUS_RUNNING = 0;
const CRONTAB_STATUS_IDLE = 1;
const CRONTAB_STATUS_QUEUED = 3;
const INSTANCE_STATUS_RUNNING = 0;
const INSTANCE_STATUS_FINISHED = 1;
const INSTANCE_STATUS_STOPPED = 2;
const INSTANCE_STATUS_ERROR = 3;

const RUNNING_RUN_STATUSES: readonly RunStatus[] = [
  'running',
  'waiting_approval',
];
const QUEUED_RUN_STATUSES: readonly RunStatus[] = [
  'created',
  'queued',
  'dispatching',
  'retry_wait',
];
const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'lost',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
];

interface ProjectionRunRow {
  id: string;
  legacyCronId: number | null;
  executionOwner: string;
  status: RunStatus;
  outputRef: string | null;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

interface ProjectionAttemptRow {
  id: string;
  runId: string;
  attempt: number;
  status: RunAttemptStatus;
  pid: number | null;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  exitCode: number | null;
}

interface ProjectionCrontabRow {
  id: number;
  status: number | null;
  pid: number | null;
  logPath: string | null;
  lastRunningTime: number | null;
  lastExecutionTime: number | null;
}

interface ProjectionInstanceRow {
  id?: number;
  cronId: number;
  runId: string | null;
  attemptId: string | null;
  pid: number | null;
  logPath: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: number;
  exitCode: number | null;
}

interface ProjectionRunInstance
  extends Model<ProjectionRunRow, ProjectionRunRow>,
    ProjectionRunRow {}
interface ProjectionAttemptInstance
  extends Model<ProjectionAttemptRow, ProjectionAttemptRow>,
    ProjectionAttemptRow {}
interface ProjectionCrontabInstance
  extends Model<ProjectionCrontabRow, ProjectionCrontabRow>,
    ProjectionCrontabRow {}
interface ProjectionInstanceInstance
  extends Model<ProjectionInstanceRow, ProjectionInstanceRow>,
    ProjectionInstanceRow {}

interface ProjectionModels {
  run: ModelStatic<ProjectionRunInstance>;
  attempt: ModelStatic<ProjectionAttemptInstance>;
  crontab: ModelStatic<ProjectionCrontabInstance>;
  instance: ModelStatic<ProjectionInstanceInstance>;
}

interface SelectedRun {
  run: ProjectionRunRow;
  attempt: ProjectionAttemptRow | null;
}

function defineProjectionModels(database: Sequelize): ProjectionModels {
  const common = { timestamps: false, freezeTableName: true } as const;
  const run = database.define<ProjectionRunInstance>(
    'Ql3PrimaryCronProjectionRun',
    {
      id: { type: DataTypes.STRING(36), primaryKey: true },
      legacyCronId: { field: 'legacy_cron_id', type: DataTypes.INTEGER },
      executionOwner: {
        field: 'execution_owner',
        type: DataTypes.STRING(16),
      },
      status: { type: DataTypes.STRING(32) },
      outputRef: { field: 'output_ref', type: DataTypes.STRING(512) },
      createdAtMs: { field: 'created_at_ms', type: DataTypes.BIGINT },
      startedAtMs: { field: 'started_at_ms', type: DataTypes.BIGINT },
      finishedAtMs: { field: 'finished_at_ms', type: DataTypes.BIGINT },
    },
    { ...common, tableName: RUN_TABLE },
  );
  const attempt = database.define<ProjectionAttemptInstance>(
    'Ql3PrimaryCronProjectionAttempt',
    {
      id: { type: DataTypes.STRING(36), primaryKey: true },
      runId: { field: 'run_id', type: DataTypes.STRING(36) },
      attempt: { type: DataTypes.INTEGER },
      status: { type: DataTypes.STRING(32) },
      pid: { type: DataTypes.INTEGER },
      createdAtMs: { field: 'created_at_ms', type: DataTypes.BIGINT },
      startedAtMs: { field: 'started_at_ms', type: DataTypes.BIGINT },
      finishedAtMs: { field: 'finished_at_ms', type: DataTypes.BIGINT },
      exitCode: { field: 'exit_code', type: DataTypes.INTEGER },
    },
    { ...common, tableName: RUN_ATTEMPT_TABLE },
  );
  const crontab = database.define<ProjectionCrontabInstance>(
    'Ql3PrimaryCronProjectionCrontab',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      status: { type: DataTypes.INTEGER },
      pid: { type: DataTypes.INTEGER },
      logPath: { field: 'log_path', type: DataTypes.STRING },
      lastRunningTime: {
        field: 'last_running_time',
        type: DataTypes.INTEGER,
      },
      lastExecutionTime: {
        field: 'last_execution_time',
        type: DataTypes.INTEGER,
      },
    },
    { ...common, tableName: CRONTAB_TABLE },
  );
  const instance = database.define<ProjectionInstanceInstance>(
    'Ql3PrimaryCronProjectionInstance',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      cronId: { field: 'cron_id', type: DataTypes.INTEGER },
      runId: { field: 'run_id', type: DataTypes.STRING(36) },
      attemptId: { field: 'attempt_id', type: DataTypes.STRING(36) },
      pid: { type: DataTypes.INTEGER },
      logPath: { field: 'log_path', type: DataTypes.STRING },
      startedAt: { field: 'started_at', type: DataTypes.INTEGER },
      finishedAt: { field: 'finished_at', type: DataTypes.INTEGER },
      status: { type: DataTypes.INTEGER },
      exitCode: { field: 'exit_code', type: DataTypes.INTEGER },
    },
    { ...common, tableName: RUNNING_INSTANCE_TABLE },
  );
  return { run, attempt, crontab, instance };
}

function toUnixSeconds(milliseconds: number): number {
  return Math.floor(milliseconds / 1000);
}

function instanceStatus(status: RunAttemptStatus): number | null {
  switch (status) {
    case 'claimed':
      return null;
    case 'starting':
    case 'running':
      return INSTANCE_STATUS_RUNNING;
    case 'succeeded':
      return INSTANCE_STATUS_FINISHED;
    case 'cancelled':
      return INSTANCE_STATUS_STOPPED;
    case 'failed':
    case 'timed_out':
    case 'lost':
      return INSTANCE_STATUS_ERROR;
  }
}

function isAttemptActive(status: RunAttemptStatus): boolean {
  return status === 'starting' || status === 'running';
}

/**
 * Projects runtime-owned Run state into the legacy UI tables before the same
 * SQLite transaction commits. It never projects legacy-owned Shadow Runs.
 */
export class PrimaryCronProjection
  implements SequelizeRunProjectionParticipant
{
  private readonly models: ProjectionModels;

  constructor(database: Sequelize) {
    this.models = defineProjectionModels(database);
  }

  async apply(context: SequelizeRunProjectionContext): Promise<void> {
    const cronIds = new Set<number>();
    for (const attemptId of context.changedAttemptIds) {
      const cronId = await this.projectAttempt(attemptId, context.transaction);
      if (cronId !== null) cronIds.add(cronId);
    }
    for (const runId of context.changedRunIds) {
      const run = await context.runs.findRunById(runId);
      if (run?.executionOwner === 'runtime' && run.legacyCronId !== undefined) {
        cronIds.add(run.legacyCronId);
      }
    }
    for (const cronId of cronIds) {
      await this.projectCrontab(cronId, context.transaction);
    }
  }

  private async projectAttempt(
    attemptId: string,
    transaction: Transaction,
  ): Promise<number | null> {
    const attempt = await this.models.attempt.findByPk(attemptId, {
      raw: true,
      transaction,
    });
    if (!attempt) return null;
    const run = await this.models.run.findByPk(attempt.runId, {
      raw: true,
      transaction,
    });
    if (!run || run.executionOwner !== 'runtime' || run.legacyCronId === null) {
      return null;
    }

    const status = instanceStatus(attempt.status);
    if (status === null) return run.legacyCronId;
    const logPath = parseLegacyLogOutputRef(run.outputRef ?? undefined);
    const values: ProjectionInstanceRow = {
      cronId: run.legacyCronId,
      runId: run.id,
      attemptId: attempt.id,
      pid: attempt.pid,
      logPath,
      startedAt: toUnixSeconds(
        attempt.startedAtMs ?? run.startedAtMs ?? attempt.createdAtMs,
      ),
      finishedAt:
        attempt.finishedAtMs === null
          ? null
          : toUnixSeconds(attempt.finishedAtMs),
      status,
      exitCode: attempt.exitCode,
    };
    const existing = await this.models.instance.findOne({
      where: { attemptId: attempt.id },
      transaction,
    });
    if (existing) {
      await existing.update(values, { transaction });
    } else {
      await this.models.instance.create(values, { transaction });
    }
    return run.legacyCronId;
  }

  private async projectCrontab(
    cronId: number,
    transaction: Transaction,
  ): Promise<void> {
    const running = await this.findSelectedRun(
      cronId,
      RUNNING_RUN_STATUSES,
      transaction,
    );
    if (running) {
      await this.updateCrontab(
        cronId,
        CRONTAB_STATUS_RUNNING,
        running,
        transaction,
      );
      return;
    }
    const queued = await this.findSelectedRun(
      cronId,
      QUEUED_RUN_STATUSES,
      transaction,
    );
    if (queued) {
      await this.updateCrontab(
        cronId,
        CRONTAB_STATUS_QUEUED,
        queued,
        transaction,
      );
      return;
    }
    const terminal = await this.findSelectedRun(
      cronId,
      TERMINAL_RUN_STATUSES,
      transaction,
    );
    await this.updateCrontab(
      cronId,
      CRONTAB_STATUS_IDLE,
      terminal,
      transaction,
    );
  }

  private async findSelectedRun(
    cronId: number,
    statuses: readonly RunStatus[],
    transaction: Transaction,
  ): Promise<SelectedRun | null> {
    const run = await this.models.run.findOne({
      where: {
        legacyCronId: cronId,
        executionOwner: 'runtime',
        status: { [Op.in]: [...statuses] },
      },
      order: [
        ['createdAtMs', 'DESC'],
        ['id', 'DESC'],
      ],
      raw: true,
      transaction,
    });
    if (!run) return null;
    const attempt = await this.models.attempt.findOne({
      where: { runId: run.id },
      order: [
        ['attempt', 'DESC'],
        ['id', 'DESC'],
      ],
      raw: true,
      transaction,
    });
    return { run, attempt };
  }

  private async updateCrontab(
    cronId: number,
    status: number,
    selected: SelectedRun | null,
    transaction: Transaction,
  ): Promise<void> {
    const run = selected?.run;
    const attempt = selected?.attempt;
    const startedAtMs = attempt?.startedAtMs ?? run?.startedAtMs ?? null;
    const finishedAtMs = attempt?.finishedAtMs ?? run?.finishedAtMs ?? null;
    const values: Partial<ProjectionCrontabRow> = {
      status,
      pid: attempt && isAttemptActive(attempt.status) ? attempt.pid : null,
      logPath: parseLegacyLogOutputRef(run?.outputRef ?? undefined),
    };
    if (startedAtMs !== null) {
      values.lastExecutionTime = toUnixSeconds(startedAtMs);
    }
    if (startedAtMs !== null && finishedAtMs !== null) {
      values.lastRunningTime = Math.max(
        0,
        Math.floor((finishedAtMs - startedAtMs) / 1000),
      );
    }
    await this.models.crontab.update(values, {
      where: { id: cronId },
      transaction,
    });
  }
}
