import {
  DataTypes,
  Model,
  ModelStatic,
  Sequelize,
  UniqueConstraintError,
} from 'sequelize';
import { TASK_EXECUTION_REVISION_TABLE } from '../../../migrations/0012-task-execution-revisions';
import { EXECUTOR_TYPES, type ExecutorType } from '../../domain/execution';
import type { PinnedTaskExecutionRevision } from '../../domain/taskExecutionRevision';
import {
  createPinnedTaskExecutionRevisionRecord,
  normalizePinnedTaskExecutionRevision,
  taskExecutionRevisionDigest,
  TaskExecutionRevisionCorruptError,
} from '../../domain/taskExecutionRevisionRecord';
import type {
  InsertTaskExecutionRevisionResult,
  TaskExecutionRevisionRepository,
} from '../../ports/taskExecutionRevisionRepository';
import type { TaskExecutionRevisionRequest } from '../../ports/taskExecutionRevisionSource';

interface TaskExecutionRevisionRow {
  projectId: string;
  taskId: string;
  taskRevision: string;
  executorType: string;
  executionTemplate: string;
  contextRef: string;
  contentDigest: string;
  createdAtMs: number | string;
}

interface TaskExecutionRevisionInstance
  extends Model<TaskExecutionRevisionRow, TaskExecutionRevisionRow>,
    TaskExecutionRevisionRow {}

export class TaskExecutionRevisionConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly taskId: string,
    readonly taskRevision: string,
  ) {
    super(
      `Task execution revision ${projectId}/${taskId}@${taskRevision} is immutable`,
    );
    this.name = 'TaskExecutionRevisionConflictError';
  }
}

function defineTaskExecutionRevisionModel(
  database: Sequelize,
): ModelStatic<TaskExecutionRevisionInstance> {
  return database.define<TaskExecutionRevisionInstance>(
    'Ql3TaskExecutionRevision',
    {
      projectId: {
        field: 'project_id',
        type: DataTypes.STRING(128),
        allowNull: false,
        primaryKey: true,
      },
      taskId: {
        field: 'task_id',
        type: DataTypes.STRING(255),
        allowNull: false,
        primaryKey: true,
      },
      taskRevision: {
        field: 'task_revision',
        type: DataTypes.STRING(128),
        allowNull: false,
        primaryKey: true,
      },
      executorType: {
        field: 'executor_type',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      executionTemplate: {
        field: 'execution_template',
        type: DataTypes.TEXT,
        allowNull: false,
      },
      contextRef: {
        field: 'context_ref',
        type: DataTypes.STRING(512),
        allowNull: false,
      },
      contentDigest: {
        field: 'content_digest',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      createdAtMs: {
        field: 'created_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    {
      tableName: TASK_EXECUTION_REVISION_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
}

function assertIdentity(name: string, value: string, maximum: number): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
}

function assertRequest(request: Readonly<TaskExecutionRevisionRequest>): void {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Task execution revision request must be an object');
  }
  assertIdentity('projectId', request.projectId, 128);
  assertIdentity('taskId', request.taskId, 255);
  assertIdentity('taskRevision', request.taskRevision, 128);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  for (const candidate of [
    error,
    'original' in error ? error.original : undefined,
    'parent' in error ? error.parent : undefined,
  ]) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      'code' in candidate &&
      typeof candidate.code === 'string'
    ) {
      return candidate.code;
    }
  }
  return undefined;
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2 ** attempt));
}

function rowToRevision(
  row: TaskExecutionRevisionRow,
): PinnedTaskExecutionRevision {
  if (!EXECUTOR_TYPES.includes(row.executorType as ExecutorType)) {
    throw new TaskExecutionRevisionCorruptError(
      'Stored Task execution revision has an invalid executor type',
    );
  }
  let execution: unknown;
  try {
    execution = JSON.parse(row.executionTemplate);
  } catch {
    throw new TaskExecutionRevisionCorruptError(
      'Stored Task execution revision template is not valid JSON',
    );
  }
  try {
    const normalized = normalizePinnedTaskExecutionRevision({
      projectId: row.projectId,
      taskId: row.taskId,
      taskRevision: row.taskRevision,
      executorType: row.executorType as ExecutorType,
      execution: execution as PinnedTaskExecutionRevision['execution'],
      contextRef: row.contextRef,
    });
    if (JSON.stringify(normalized.execution) !== row.executionTemplate) {
      throw new TaskExecutionRevisionCorruptError(
        'Stored Task execution revision template is not canonical',
      );
    }
    if (
      !/^[0-9a-f]{64}$/.test(row.contentDigest) ||
      taskExecutionRevisionDigest(normalized) !== row.contentDigest
    ) {
      throw new TaskExecutionRevisionCorruptError(
        'Stored Task execution revision digest does not match its content',
      );
    }
    const createdAtMs = Number(row.createdAtMs);
    return createPinnedTaskExecutionRevisionRecord(normalized, createdAtMs);
  } catch (error) {
    if (error instanceof TaskExecutionRevisionCorruptError) throw error;
    throw new TaskExecutionRevisionCorruptError(
      `Stored Task execution revision is invalid: ${
        error instanceof Error ? error.message : 'unknown validation error'
      }`,
    );
  }
}

export class LegacySequelizeTaskExecutionRevisionRepository
  implements TaskExecutionRevisionRepository
{
  private readonly revision: ModelStatic<TaskExecutionRevisionInstance>;

  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Legacy Task execution revision repository is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
    this.revision = defineTaskExecutionRevisionModel(database);
  }

  async resolve(
    request: Readonly<TaskExecutionRevisionRequest>,
  ): Promise<PinnedTaskExecutionRevision | null> {
    assertRequest(request);
    const row = (await this.revision.findOne({
      where: {
        projectId: request.projectId,
        taskId: request.taskId,
        taskRevision: request.taskRevision,
      },
      raw: true,
    })) as unknown as TaskExecutionRevisionRow | null;
    return row ? rowToRevision(row) : null;
  }

  async insert(
    revision: PinnedTaskExecutionRevision,
    createdAtMs: number,
  ): Promise<InsertTaskExecutionRevisionResult> {
    const record = createPinnedTaskExecutionRevisionRecord(
      revision,
      createdAtMs,
    );
    const values: TaskExecutionRevisionRow = {
      projectId: record.projectId,
      taskId: record.taskId,
      taskRevision: record.taskRevision,
      executorType: record.executorType,
      executionTemplate: JSON.stringify(record.execution),
      contextRef: record.contextRef,
      contentDigest: record.contentDigest,
      createdAtMs: record.createdAtMs,
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.revision.create(values);
        return 'inserted';
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
          const existing = await this.resolve(record);
          if (
            existing &&
            taskExecutionRevisionDigest(existing) === record.contentDigest
          ) {
            return 'idempotent';
          }
          throw new TaskExecutionRevisionConflictError(
            record.projectId,
            record.taskId,
            record.taskRevision,
          );
        }
        if (errorCode(error) === 'SQLITE_BUSY' && attempt < 4) {
          await retryDelay(attempt);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Task execution revision insert retry budget exhausted');
  }
}
