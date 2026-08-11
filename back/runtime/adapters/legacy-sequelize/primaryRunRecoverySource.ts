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
import type { ExecutorType } from '../../domain/execution';
import type {
  PrimaryRunRecoveryAttemptReference,
  PrimaryRunRecoveryCandidate,
  PrimaryRunRecoveryCursor,
  PrimaryRunRecoveryPage,
  PrimaryRunRecoverySource,
} from '../../ports/primaryRunRecoverySource';
import { MAX_PRIMARY_RECOVERY_BATCH_SIZE } from '../../ports/primaryRunRecoverySource';

interface RecoveryRunRow {
  id: string;
  executionOwner: string;
  status: string;
  createdAtMs: number;
}

interface RecoveryAttemptRow {
  id: string;
  runId: string;
  attempt: number;
  status: string;
  executorType: string;
  createdAtMs: number;
}

interface RecoveryRunInstance
  extends Model<RecoveryRunRow, RecoveryRunRow>,
    RecoveryRunRow {}
interface RecoveryAttemptInstance
  extends Model<RecoveryAttemptRow, RecoveryAttemptRow>,
    RecoveryAttemptRow {}

function defineRecoveryRunModel(
  database: Sequelize,
): ModelStatic<RecoveryRunInstance> {
  return database.define<RecoveryRunInstance>(
    'Ql3PrimaryRecoveryRun',
    {
      id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true },
      executionOwner: {
        field: 'execution_owner',
        type: DataTypes.STRING(16),
        allowNull: false,
      },
      status: { type: DataTypes.STRING(32), allowNull: false },
      createdAtMs: {
        field: 'created_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    { tableName: RUN_TABLE, timestamps: false, freezeTableName: true },
  );
}

function defineRecoveryAttemptModel(
  database: Sequelize,
): ModelStatic<RecoveryAttemptInstance> {
  return database.define<RecoveryAttemptInstance>(
    'Ql3PrimaryRecoveryAttempt',
    {
      id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true },
      runId: {
        field: 'run_id',
        type: DataTypes.STRING(36),
        allowNull: false,
      },
      attempt: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.STRING(32), allowNull: false },
      executorType: {
        field: 'executor_type',
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
      tableName: RUN_ATTEMPT_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
}

function assertCursor(cursor: PrimaryRunRecoveryCursor): void {
  if (!Number.isSafeInteger(cursor.createdAtMs) || cursor.createdAtMs < 0) {
    throw new RangeError('cursor.createdAtMs must be a non-negative integer');
  }
  if (!cursor.runId || cursor.runId.length > 36) {
    throw new RangeError('cursor.runId must be between 1 and 36 characters');
  }
}

export class LegacySequelizePrimaryRunRecoverySource
  implements PrimaryRunRecoverySource
{
  private readonly run: ModelStatic<RecoveryRunInstance>;
  private readonly attempt: ModelStatic<RecoveryAttemptInstance>;

  constructor(database: Sequelize) {
    this.run = defineRecoveryRunModel(database);
    this.attempt = defineRecoveryAttemptModel(database);
  }

  async listCandidates({
    cursor,
    limit = 32,
  }: {
    cursor?: PrimaryRunRecoveryCursor;
    limit?: number;
  } = {}): Promise<PrimaryRunRecoveryPage> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_PRIMARY_RECOVERY_BATCH_SIZE
    ) {
      throw new RangeError(
        'limit must be between 1 and MAX_PRIMARY_RECOVERY_BATCH_SIZE',
      );
    }
    if (cursor) assertCursor(cursor);

    const where: WhereOptions<RecoveryRunRow> = {
      executionOwner: 'runtime',
      status: { [Op.in]: ['dispatching', 'running'] },
      ...(cursor === undefined
        ? {}
        : {
            [Op.or]: [
              { createdAtMs: { [Op.gt]: cursor.createdAtMs } },
              {
                createdAtMs: cursor.createdAtMs,
                id: { [Op.gt]: cursor.runId },
              },
            ],
          }),
    };
    const runRows = (await this.run.findAll({
      attributes: ['id', 'createdAtMs'],
      where,
      order: [
        ['createdAtMs', 'ASC'],
        ['id', 'ASC'],
      ],
      limit: limit + 1,
      raw: true,
    })) as unknown as RecoveryRunRow[];
    const truncated = runRows.length > limit;
    const boundedRuns = runRows.slice(0, limit);
    if (boundedRuns.length === 0) {
      return {
        candidates: [],
        truncated: false,
        unsafeAttemptOverflow: false,
      };
    }

    const maxAttemptRows = limit * 2;
    const attemptRows = (await this.attempt.findAll({
      attributes: ['id', 'runId', 'attempt', 'executorType'],
      where: {
        runId: { [Op.in]: boundedRuns.map((run) => run.id) },
        status: { [Op.in]: ['claimed', 'starting', 'running'] },
      },
      order: [
        ['runId', 'ASC'],
        ['attempt', 'DESC'],
        ['createdAtMs', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: maxAttemptRows + 1,
      raw: true,
    })) as unknown as RecoveryAttemptRow[];
    if (attemptRows.length > maxAttemptRows) {
      return {
        candidates: [],
        truncated,
        unsafeAttemptOverflow: true,
      };
    }

    const attemptsByRun = new Map<
      string,
      PrimaryRunRecoveryAttemptReference[]
    >();
    for (const attempt of attemptRows) {
      const references = attemptsByRun.get(attempt.runId) ?? [];
      references.push({
        attemptId: attempt.id,
        executorType: attempt.executorType as ExecutorType,
      });
      attemptsByRun.set(attempt.runId, references);
    }
    const candidates: PrimaryRunRecoveryCandidate[] = boundedRuns.map(
      (run) => ({
        runId: run.id,
        attempts: attemptsByRun.get(run.id) ?? [],
      }),
    );
    const last = boundedRuns[boundedRuns.length - 1];
    return {
      candidates,
      truncated,
      unsafeAttemptOverflow: false,
      nextCursor: { createdAtMs: last.createdAtMs, runId: last.id },
    };
  }
}
