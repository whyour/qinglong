import {
  DataTypes,
  Model,
  ModelStatic,
  Op,
  Sequelize,
  UniqueConstraintError,
  type WhereOptions,
} from 'sequelize';
import { RUN_ATTEMPT_TABLE } from '../../../migrations/0002-run-schema';
import { COMPLETION_RECEIPT_JOURNAL_TABLE } from '../../../migrations/0007-completion-receipt-journal';
import {
  COMPLETION_RECEIPT_JOURNAL_STATES,
  type CompletionReceiptJournalCandidate,
  type CompletionReceiptJournalCursor,
  type CompletionReceiptJournalRecord,
  type CompletionReceiptJournalState,
} from '../../domain/completionReceiptJournal';
import { assertCompletionReceiptId } from '../../domain/completionReceipt';
import type { RunAttemptStatus } from '../../domain/run';
import {
  MAX_COMPLETION_RECEIPT_JOURNAL_BATCH_SIZE,
  type CompletionReceiptJournal,
  type QuarantineCompletionReceiptCommand,
  type RegisterCompletionReceiptCommand,
} from '../../ports/completionReceiptJournal';

interface JournalRow {
  attemptId: string;
  runId: string;
  state: string;
  quarantineRef: string | null;
  purgeAfterMs: number | null;
  registeredAtMs: number;
  updatedAtMs: number;
}

interface AttemptRow {
  id: string;
  status: string;
  executorType: string;
  finishedAtMs: number | null;
}

interface JournalInstance extends Model<JournalRow, JournalRow>, JournalRow {}
interface AttemptInstance extends Model<AttemptRow, AttemptRow>, AttemptRow {}

function defineJournalModel(database: Sequelize): ModelStatic<JournalInstance> {
  return database.define<JournalInstance>(
    'Ql3CompletionReceiptJournal',
    {
      attemptId: {
        field: 'attempt_id',
        type: DataTypes.STRING(36),
        primaryKey: true,
      },
      runId: {
        field: 'run_id',
        type: DataTypes.STRING(36),
        allowNull: false,
      },
      state: { type: DataTypes.STRING(16), allowNull: false },
      quarantineRef: {
        field: 'quarantine_ref',
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      purgeAfterMs: {
        field: 'purge_after_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      registeredAtMs: {
        field: 'registered_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      updatedAtMs: {
        field: 'updated_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    {
      tableName: COMPLETION_RECEIPT_JOURNAL_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
}

function defineAttemptModel(database: Sequelize): ModelStatic<AttemptInstance> {
  return database.define<AttemptInstance>(
    'Ql3CompletionReceiptJournalAttempt',
    {
      id: { type: DataTypes.STRING(36), primaryKey: true },
      status: { type: DataTypes.STRING(32), allowNull: false },
      executorType: {
        field: 'executor_type',
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      finishedAtMs: {
        field: 'finished_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
    },
    { tableName: RUN_ATTEMPT_TABLE, timestamps: false, freezeTableName: true },
  );
}

function assertNonNegativeTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertCursor(cursor: CompletionReceiptJournalCursor): void {
  assertNonNegativeTimestamp('cursor.updatedAtMs', cursor.updatedAtMs);
  assertCompletionReceiptId(cursor.attemptId, 'attemptId');
}

function assertQuarantineRef(value: string): void {
  if (
    value.length < 1 ||
    value.length > 255 ||
    !value.startsWith('.quarantine/') ||
    value.includes('..') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new TypeError('quarantineRef is invalid');
  }
}

function toRecord(row: JournalRow): CompletionReceiptJournalRecord {
  if (!COMPLETION_RECEIPT_JOURNAL_STATES.includes(row.state as never)) {
    throw new Error('Completion receipt journal state is corrupt');
  }
  return {
    attemptId: row.attemptId,
    runId: row.runId,
    state: row.state as CompletionReceiptJournalState,
    registeredAtMs: Number(row.registeredAtMs),
    updatedAtMs: Number(row.updatedAtMs),
    ...(row.quarantineRef === null ? {} : { quarantineRef: row.quarantineRef }),
    ...(row.purgeAfterMs === null
      ? {}
      : { purgeAfterMs: Number(row.purgeAfterMs) }),
  };
}

export class LegacySequelizeCompletionReceiptJournal
  implements CompletionReceiptJournal
{
  private readonly journal: ModelStatic<JournalInstance>;
  private readonly attempt: ModelStatic<AttemptInstance>;

  constructor(database: Sequelize) {
    this.journal = defineJournalModel(database);
    this.attempt = defineAttemptModel(database);
  }

  async register(command: RegisterCompletionReceiptCommand): Promise<void> {
    assertCompletionReceiptId(command.attemptId, 'attemptId');
    assertCompletionReceiptId(command.runId, 'runId');
    assertNonNegativeTimestamp('registeredAtMs', command.registeredAtMs);
    const values: JournalRow = {
      attemptId: command.attemptId,
      runId: command.runId,
      state: 'pending',
      quarantineRef: null,
      purgeAfterMs: null,
      registeredAtMs: command.registeredAtMs,
      updatedAtMs: command.registeredAtMs,
    };
    try {
      await this.journal.create(values);
      return;
    } catch (error) {
      if (!(error instanceof UniqueConstraintError)) throw error;
    }
    const current = (await this.journal.findByPk(command.attemptId, {
      raw: true,
    })) as unknown as JournalRow | null;
    if (
      !current ||
      current.runId !== command.runId ||
      Number(current.registeredAtMs) !== command.registeredAtMs
    ) {
      throw new Error('Completion receipt journal registration conflicts');
    }
  }

  async markQuarantined(
    command: QuarantineCompletionReceiptCommand,
  ): Promise<void> {
    assertCompletionReceiptId(command.attemptId, 'attemptId');
    assertQuarantineRef(command.quarantineRef);
    assertNonNegativeTimestamp('updatedAtMs', command.updatedAtMs);
    assertNonNegativeTimestamp('purgeAfterMs', command.purgeAfterMs);
    if (command.purgeAfterMs < command.updatedAtMs) {
      throw new RangeError('purgeAfterMs must not precede updatedAtMs');
    }
    const [updated] = await this.journal.update(
      {
        state: 'quarantined',
        quarantineRef: command.quarantineRef,
        purgeAfterMs: command.purgeAfterMs,
        updatedAtMs: command.updatedAtMs,
      },
      { where: { attemptId: command.attemptId, state: 'pending' } },
    );
    if (updated === 1) return;
    const current = (await this.journal.findByPk(command.attemptId, {
      raw: true,
    })) as unknown as JournalRow | null;
    if (
      current?.state === 'quarantined' &&
      current.quarantineRef === command.quarantineRef &&
      Number(current.purgeAfterMs) === command.purgeAfterMs
    ) {
      return;
    }
    throw new Error('Completion receipt journal quarantine transition failed');
  }

  async resolve(attemptId: string): Promise<boolean> {
    assertCompletionReceiptId(attemptId, 'attemptId');
    return (await this.journal.destroy({ where: { attemptId } })) === 1;
  }

  async listCandidates({
    observedAtMs,
    cursor,
    limit = 32,
  }: {
    observedAtMs: number;
    cursor?: CompletionReceiptJournalCursor;
    limit?: number;
  }) {
    assertNonNegativeTimestamp('observedAtMs', observedAtMs);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_COMPLETION_RECEIPT_JOURNAL_BATCH_SIZE
    ) {
      throw new RangeError(
        'limit must be between 1 and MAX_COMPLETION_RECEIPT_JOURNAL_BATCH_SIZE',
      );
    }
    if (cursor) assertCursor(cursor);

    const eligible: WhereOptions<JournalRow> = {
      [Op.or]: [
        { state: 'pending' },
        {
          state: 'quarantined',
          purgeAfterMs: { [Op.lte]: observedAtMs },
        },
      ],
    };
    const afterCursor: WhereOptions<JournalRow> | undefined = cursor
      ? {
          [Op.or]: [
            { updatedAtMs: { [Op.gt]: cursor.updatedAtMs } },
            {
              updatedAtMs: cursor.updatedAtMs,
              attemptId: { [Op.gt]: cursor.attemptId },
            },
          ],
        }
      : undefined;
    const where: WhereOptions<JournalRow> = afterCursor
      ? { [Op.and]: [eligible, afterCursor] }
      : eligible;
    const rows = (await this.journal.findAll({
      where,
      order: [
        ['updatedAtMs', 'ASC'],
        ['attemptId', 'ASC'],
      ],
      limit: limit + 1,
      raw: true,
    })) as unknown as JournalRow[];
    const truncated = rows.length > limit;
    const bounded = rows.slice(0, limit);
    if (bounded.length === 0) return { candidates: [], truncated: false };

    const attempts = (await this.attempt.findAll({
      where: { id: { [Op.in]: bounded.map((row) => row.attemptId) } },
      raw: true,
    })) as unknown as AttemptRow[];
    const attemptById = new Map(attempts.map((row) => [row.id, row]));
    const candidates: CompletionReceiptJournalCandidate[] = bounded.map(
      (row) => {
        const attempt = attemptById.get(row.attemptId);
        if (!attempt) {
          throw new Error('Completion receipt journal Attempt is missing');
        }
        return {
          ...toRecord(row),
          attemptStatus: attempt.status as RunAttemptStatus,
          executorType: attempt.executorType,
          ...(attempt.finishedAtMs === null
            ? {}
            : { finishedAtMs: Number(attempt.finishedAtMs) }),
        };
      },
    );
    const last = bounded[bounded.length - 1];
    return {
      candidates,
      truncated,
      nextCursor: {
        updatedAtMs: Number(last.updatedAtMs),
        attemptId: last.attemptId,
      },
    };
  }
}
