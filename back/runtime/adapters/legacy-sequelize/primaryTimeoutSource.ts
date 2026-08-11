import {
  DataTypes,
  Model,
  ModelStatic,
  Op,
  Sequelize,
  type WhereOptions,
} from 'sequelize';
import {
  RUN_ATTEMPT_TABLE,
  RUN_TABLE,
} from '../../../migrations/0002-run-schema';
import {
  MAX_PRIMARY_TIMEOUT_BATCH_SIZE,
  type PrimaryTimeoutCursor,
  type PrimaryTimeoutPage,
  type PrimaryTimeoutSource,
} from '../../ports/primaryTimeoutSource';

interface TimeoutAttemptRow {
  id: string;
  runId: string;
  status: string;
  deadlineAtMs: number | null;
}

interface TimeoutRunRow {
  id: string;
  executionOwner: string;
  status: string;
  cancelRequestedAtMs: number | null;
}

interface TimeoutAttemptInstance
  extends Model<TimeoutAttemptRow, TimeoutAttemptRow>,
    TimeoutAttemptRow {}
interface TimeoutRunInstance
  extends Model<TimeoutRunRow, TimeoutRunRow>,
    TimeoutRunRow {}

function defineTimeoutAttemptModel(
  database: Sequelize,
): ModelStatic<TimeoutAttemptInstance> {
  return database.define<TimeoutAttemptInstance>(
    'Ql3PrimaryTimeoutAttempt',
    {
      id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true },
      runId: {
        field: 'run_id',
        type: DataTypes.STRING(36),
        allowNull: false,
      },
      status: { type: DataTypes.STRING(32), allowNull: false },
      deadlineAtMs: {
        field: 'deadline_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
    },
    { tableName: RUN_ATTEMPT_TABLE, timestamps: false, freezeTableName: true },
  );
}

function defineTimeoutRunModel(
  database: Sequelize,
): ModelStatic<TimeoutRunInstance> {
  return database.define<TimeoutRunInstance>(
    'Ql3PrimaryTimeoutRun',
    {
      id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true },
      executionOwner: {
        field: 'execution_owner',
        type: DataTypes.STRING(16),
        allowNull: false,
      },
      status: { type: DataTypes.STRING(32), allowNull: false },
      cancelRequestedAtMs: {
        field: 'cancel_requested_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
    },
    { tableName: RUN_TABLE, timestamps: false, freezeTableName: true },
  );
}

function assertCursor(cursor: PrimaryTimeoutCursor): void {
  if (!Number.isSafeInteger(cursor.deadlineAtMs) || cursor.deadlineAtMs < 0) {
    throw new RangeError('cursor.deadlineAtMs must be a non-negative integer');
  }
  if (!cursor.attemptId || cursor.attemptId.length > 36) {
    throw new RangeError(
      'cursor.attemptId must be between 1 and 36 characters',
    );
  }
}

export class LegacySequelizePrimaryTimeoutSource
  implements PrimaryTimeoutSource
{
  private readonly attempt: ModelStatic<TimeoutAttemptInstance>;
  private readonly run: ModelStatic<TimeoutRunInstance>;

  constructor(database: Sequelize) {
    this.attempt = defineTimeoutAttemptModel(database);
    this.run = defineTimeoutRunModel(database);
    this.attempt.belongsTo(this.run, {
      as: 'timeoutRun',
      foreignKey: 'runId',
      targetKey: 'id',
      constraints: false,
    });
  }

  async listOverdue(options: {
    nowMs: number;
    cursor?: PrimaryTimeoutCursor;
    limit?: number;
  }): Promise<PrimaryTimeoutPage> {
    if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0) {
      throw new RangeError('nowMs must be a non-negative safe integer');
    }
    const limit = options.limit ?? 32;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_PRIMARY_TIMEOUT_BATCH_SIZE
    ) {
      throw new RangeError(
        'limit must be between 1 and MAX_PRIMARY_TIMEOUT_BATCH_SIZE',
      );
    }
    if (options.cursor) assertCursor(options.cursor);

    const cursorWhere: WhereOptions<TimeoutAttemptRow> = options.cursor
      ? {
          [Op.or]: [
            { deadlineAtMs: { [Op.gt]: options.cursor.deadlineAtMs } },
            {
              deadlineAtMs: options.cursor.deadlineAtMs,
              id: { [Op.gt]: options.cursor.attemptId },
            },
          ],
        }
      : {};
    const rows = (await this.attempt.findAll({
      attributes: ['id', 'runId', 'status', 'deadlineAtMs'],
      where: {
        status: { [Op.in]: ['starting', 'running'] },
        deadlineAtMs: { [Op.ne]: null, [Op.lte]: options.nowMs },
        ...cursorWhere,
      },
      include: [
        {
          model: this.run,
          as: 'timeoutRun',
          attributes: [],
          required: true,
          where: {
            executionOwner: 'runtime',
            status: { [Op.in]: ['dispatching', 'running'] },
            cancelRequestedAtMs: null,
          },
        },
      ],
      order: [
        ['deadlineAtMs', 'ASC'],
        ['id', 'ASC'],
      ],
      limit: limit + 1,
      raw: true,
    })) as unknown as TimeoutAttemptRow[];

    const truncated = rows.length > limit;
    const selected = rows.slice(0, limit);
    const candidates = selected.map((row) => ({
      runId: row.runId,
      attemptId: row.id,
      deadlineAtMs: Number(row.deadlineAtMs),
    }));
    const last = candidates[candidates.length - 1];
    return {
      candidates,
      truncated,
      ...(truncated && last
        ? {
            nextCursor: {
              deadlineAtMs: last.deadlineAtMs,
              attemptId: last.attemptId,
            },
          }
        : {}),
    };
  }
}
