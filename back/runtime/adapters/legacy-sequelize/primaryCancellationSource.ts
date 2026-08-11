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
import type { ExecutionStopKind, ExecutorType } from '../../domain/execution';
import type {
  PrimaryCancellationAttemptReference,
  PrimaryCancellationCandidate,
  PrimaryCancellationCursor,
  PrimaryCancellationPage,
  PrimaryCancellationSource,
} from '../../ports/primaryCancellationSource';
import { MAX_PRIMARY_CANCELLATION_BATCH_SIZE } from '../../ports/primaryCancellationSource';

interface CancellationRunRow {
  id: string;
  executionOwner: string;
  status: string;
  cancelRequestedAtMs: number | null;
  cancelReason: string | null;
}

interface CancellationRequestedRunRow extends CancellationRunRow {
  cancelRequestedAtMs: number;
  cancelReason: string;
}

interface CancellationAttemptRow {
  id: string;
  runId: string;
  attempt: number;
  status: string;
  executorType: string;
  executorHandle: string | null;
  pid: number | null;
  createdAtMs: number;
}

interface CancellationRunInstance
  extends Model<CancellationRunRow, CancellationRunRow>,
    CancellationRunRow {}
interface CancellationAttemptInstance
  extends Model<CancellationAttemptRow, CancellationAttemptRow>,
    CancellationAttemptRow {}

function defineCancellationRunModel(
  database: Sequelize,
): ModelStatic<CancellationRunInstance> {
  return database.define<CancellationRunInstance>(
    'Ql3PrimaryCancellationRun',
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
        allowNull: false,
      },
      cancelReason: {
        field: 'cancel_reason',
        type: DataTypes.STRING(32),
        allowNull: false,
      },
    },
    { tableName: RUN_TABLE, timestamps: false, freezeTableName: true },
  );
}

function defineCancellationAttemptModel(
  database: Sequelize,
): ModelStatic<CancellationAttemptInstance> {
  return database.define<CancellationAttemptInstance>(
    'Ql3PrimaryCancellationAttempt',
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
      executorHandle: {
        field: 'executor_handle',
        type: DataTypes.TEXT,
        allowNull: true,
      },
      pid: { type: DataTypes.INTEGER, allowNull: true },
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

function assertCursor(cursor: PrimaryCancellationCursor): void {
  if (!Number.isSafeInteger(cursor.requestedAtMs) || cursor.requestedAtMs < 0) {
    throw new RangeError('cursor.requestedAtMs must be a non-negative integer');
  }
  if (!cursor.runId || cursor.runId.length > 36) {
    throw new RangeError('cursor.runId must be between 1 and 36 characters');
  }
}

export class LegacySequelizePrimaryCancellationSource
  implements PrimaryCancellationSource
{
  private readonly run: ModelStatic<CancellationRunInstance>;
  private readonly attempt: ModelStatic<CancellationAttemptInstance>;

  constructor(database: Sequelize) {
    this.run = defineCancellationRunModel(database);
    this.attempt = defineCancellationAttemptModel(database);
  }

  async listCandidates({
    cursor,
    limit = 32,
  }: {
    cursor?: PrimaryCancellationCursor;
    limit?: number;
  } = {}): Promise<PrimaryCancellationPage> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_PRIMARY_CANCELLATION_BATCH_SIZE
    ) {
      throw new RangeError(
        'limit must be between 1 and MAX_PRIMARY_CANCELLATION_BATCH_SIZE',
      );
    }
    if (cursor) assertCursor(cursor);

    const where: WhereOptions<CancellationRunRow> = {
      executionOwner: 'runtime',
      status: {
        [Op.in]: [
          'created',
          'queued',
          'dispatching',
          'running',
          'waiting_approval',
          'retry_wait',
          'lost',
        ],
      },
      cancelRequestedAtMs: {
        [Op.ne]: null,
      },
      cancelReason: { [Op.ne]: null },
      ...(cursor === undefined
        ? {}
        : {
            [Op.or]: [
              { cancelRequestedAtMs: { [Op.gt]: cursor.requestedAtMs } },
              {
                cancelRequestedAtMs: cursor.requestedAtMs,
                id: { [Op.gt]: cursor.runId },
              },
            ],
          }),
    };
    const runRows = (await this.run.findAll({
      attributes: ['id', 'cancelRequestedAtMs', 'cancelReason'],
      where,
      order: [
        ['cancelRequestedAtMs', 'ASC'],
        ['id', 'ASC'],
      ],
      limit: limit + 1,
      raw: true,
    })) as unknown as CancellationRunRow[];
    const truncated = runRows.length > limit;
    const boundedRuns = runRows
      .filter(
        (run): run is CancellationRequestedRunRow =>
          run.cancelRequestedAtMs !== null && run.cancelReason !== null,
      )
      .slice(0, limit);
    if (boundedRuns.length === 0) {
      return {
        candidates: [],
        truncated: false,
        unsafeAttemptOverflow: false,
      };
    }

    const maxAttemptRows = limit * 2;
    const attemptRows = (await this.attempt.findAll({
      attributes: [
        'id',
        'runId',
        'attempt',
        'executorType',
        'executorHandle',
        'pid',
      ],
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
    })) as unknown as CancellationAttemptRow[];
    if (attemptRows.length > maxAttemptRows) {
      return {
        candidates: [],
        truncated,
        unsafeAttemptOverflow: true,
      };
    }

    const attemptsByRun = new Map<
      string,
      PrimaryCancellationAttemptReference[]
    >();
    for (const attempt of attemptRows) {
      const references = attemptsByRun.get(attempt.runId) ?? [];
      references.push({
        attemptId: attempt.id,
        executorType: attempt.executorType as ExecutorType,
        ...(attempt.executorHandle === null
          ? {}
          : { executorHandle: attempt.executorHandle }),
        ...(attempt.pid === null ? {} : { pid: attempt.pid }),
      });
      attemptsByRun.set(attempt.runId, references);
    }

    const candidates: PrimaryCancellationCandidate[] = boundedRuns.map(
      (run) => ({
        runId: run.id,
        requestedAtMs: run.cancelRequestedAtMs,
        reason: run.cancelReason as ExecutionStopKind,
        attempts: attemptsByRun.get(run.id) ?? [],
      }),
    );
    const last = boundedRuns[boundedRuns.length - 1];
    return {
      candidates,
      truncated,
      unsafeAttemptOverflow: false,
      nextCursor: {
        requestedAtMs: last.cancelRequestedAtMs,
        runId: last.id,
      },
    };
  }
}
