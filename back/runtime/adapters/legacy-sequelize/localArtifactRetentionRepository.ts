import {
  DataTypes,
  Model,
  ModelStatic,
  QueryTypes,
  Sequelize,
  UniqueConstraintError,
} from 'sequelize';
import { COMPLETION_RECEIPT_JOURNAL_TABLE } from '../../../migrations/0007-completion-receipt-journal';
import {
  RUN_ATTEMPT_TABLE,
  RUN_TABLE,
} from '../../../migrations/0002-run-schema';
import { LOCAL_ARTIFACT_RETENTION_TABLE } from '../../../migrations/0015-local-artifact-retention';
import {
  normalizeLocalArtifactRetentionCandidate,
  normalizeLocalArtifactRetentionCursor,
  normalizeLocalArtifactRetentionRecord,
  assertLocalArtifactRetentionTimestamp,
  type LocalArtifactRetentionCandidate,
  type LocalArtifactRetentionRecord,
} from '../../domain/localArtifactRetention';
import type {
  LocalArtifactRetentionPage,
  LocalArtifactRetentionRepository,
} from '../../ports/localArtifactRetentionRepository';
import { MAX_LOCAL_ARTIFACT_RETENTION_PAGE_SIZE } from '../../ports/localArtifactRetentionRepository';

interface LocalArtifactRetentionRow {
  attemptId: string;
  logArtifactId: string;
  finishedAtMs: number | string;
  eligibleAtMs: number | string;
  disposition: string;
  bytesReclaimed: number | string;
  recordedAtMs: number | string;
}

interface LocalArtifactRetentionInstance
  extends Model<LocalArtifactRetentionRow, LocalArtifactRetentionRow>,
    LocalArtifactRetentionRow {}

interface CandidateRow {
  attempt_id: string;
  log_artifact_id: string;
  finished_at_ms: number | string;
}

function defineRetentionModel(
  database: Sequelize,
): ModelStatic<LocalArtifactRetentionInstance> {
  return database.define<LocalArtifactRetentionInstance>(
    'Ql3LocalArtifactRetention',
    {
      attemptId: {
        field: 'attempt_id',
        type: DataTypes.STRING(36),
        allowNull: false,
        primaryKey: true,
      },
      logArtifactId: {
        field: 'log_artifact_id',
        type: DataTypes.STRING(36),
        allowNull: false,
      },
      finishedAtMs: {
        field: 'finished_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      eligibleAtMs: {
        field: 'eligible_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      disposition: { type: DataTypes.STRING(16), allowNull: false },
      bytesReclaimed: {
        field: 'bytes_reclaimed',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      recordedAtMs: {
        field: 'recorded_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    {
      tableName: LOCAL_ARTIFACT_RETENTION_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
}

function rowToRecord(
  row: LocalArtifactRetentionRow,
): LocalArtifactRetentionRecord {
  return normalizeLocalArtifactRetentionRecord({
    attemptId: row.attemptId,
    logArtifactId: row.logArtifactId,
    finishedAtMs: Number(row.finishedAtMs),
    eligibleAtMs: Number(row.eligibleAtMs),
    disposition: row.disposition as LocalArtifactRetentionRecord['disposition'],
    bytesReclaimed: Number(row.bytesReclaimed),
    recordedAtMs: Number(row.recordedAtMs),
  });
}

function sameRetirementIdentity(
  left: LocalArtifactRetentionRecord,
  right: LocalArtifactRetentionRecord,
): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.logArtifactId === right.logArtifactId &&
    left.finishedAtMs === right.finishedAtMs
  );
}

export class LocalArtifactRetentionRecordConflictError extends Error {
  constructor() {
    super('Local Artifact retention record conflicts with existing evidence');
    this.name = 'LocalArtifactRetentionRecordConflictError';
  }
}

export class LegacySequelizeLocalArtifactRetentionRepository
  implements LocalArtifactRetentionRepository
{
  private readonly retention: ModelStatic<LocalArtifactRetentionInstance>;

  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Local Artifact retention repository is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
    this.retention = defineRetentionModel(database);
  }

  async list({
    cutoffMs,
    cursor,
    limit,
  }: Parameters<
    LocalArtifactRetentionRepository['list']
  >[0]): Promise<LocalArtifactRetentionPage> {
    assertLocalArtifactRetentionTimestamp('cutoffMs', cutoffMs);
    const normalizedCursor = cursor
      ? normalizeLocalArtifactRetentionCursor(cursor)
      : undefined;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_LOCAL_ARTIFACT_RETENTION_PAGE_SIZE
    ) {
      throw new RangeError('Local Artifact retention page size is invalid');
    }
    const replacements: Record<string, string | number> = {
      cutoffMs,
      fetchLimit: limit + 1,
      ...(normalizedCursor
        ? {
            cursorFinishedAtMs: normalizedCursor.finishedAtMs,
            cursorAttemptId: normalizedCursor.attemptId,
          }
        : {}),
    };
    const cursorPredicate = normalizedCursor
      ? `AND (
           attempt.finished_at_ms > :cursorFinishedAtMs OR
           (attempt.finished_at_ms = :cursorFinishedAtMs AND attempt.id > :cursorAttemptId)
         )`
      : '';
    const rows = await this.database.query<CandidateRow>(
      `SELECT attempt.id AS attempt_id,
              attempt.log_artifact_id,
              attempt.finished_at_ms
         FROM "${RUN_ATTEMPT_TABLE}" AS attempt
         JOIN "${RUN_TABLE}" AS run ON run.id = attempt.run_id
        WHERE run.execution_owner = 'runtime'
          AND run.status IN ('succeeded','failed','cancelled','timed_out')
          AND attempt.status IN ('succeeded','failed','cancelled','timed_out')
          AND attempt.executor_type = 'local_process'
          AND attempt.log_artifact_id LIKE 'local-%'
          AND attempt.finished_at_ms IS NOT NULL
          AND attempt.finished_at_ms <= :cutoffMs
          AND NOT EXISTS (
            SELECT 1 FROM "${COMPLETION_RECEIPT_JOURNAL_TABLE}" AS receipt
             WHERE receipt.attempt_id = attempt.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM "${LOCAL_ARTIFACT_RETENTION_TABLE}" AS retained
             WHERE retained.attempt_id = attempt.id
          )
          ${cursorPredicate}
        ORDER BY attempt.finished_at_ms ASC, attempt.id ASC
        LIMIT :fetchLimit`,
      { type: QueryTypes.SELECT, replacements },
    );
    const truncated = rows.length > limit;
    const selected = truncated ? rows.slice(0, limit) : rows;
    const candidates: LocalArtifactRetentionCandidate[] = selected.map((row) =>
      normalizeLocalArtifactRetentionCandidate({
        attemptId: row.attempt_id,
        logArtifactId: row.log_artifact_id,
        finishedAtMs: Number(row.finished_at_ms),
      }),
    );
    const last = candidates[candidates.length - 1];
    return Object.freeze({
      candidates: Object.freeze(candidates),
      truncated,
      ...(truncated && last
        ? {
            nextCursor: Object.freeze({
              finishedAtMs: last.finishedAtMs,
              attemptId: last.attemptId,
            }),
          }
        : {}),
    });
  }

  async record(
    value: LocalArtifactRetentionRecord,
  ): Promise<'inserted' | 'existing'> {
    const record = normalizeLocalArtifactRetentionRecord(value);
    const row: LocalArtifactRetentionRow = {
      attemptId: record.attemptId,
      logArtifactId: record.logArtifactId,
      finishedAtMs: record.finishedAtMs,
      eligibleAtMs: record.eligibleAtMs,
      disposition: record.disposition,
      bytesReclaimed: record.bytesReclaimed,
      recordedAtMs: record.recordedAtMs,
    };
    try {
      await this.retention.create(row);
      return 'inserted';
    } catch (error) {
      if (!(error instanceof UniqueConstraintError)) throw error;
    }
    const existing = await this.retention.findByPk(record.attemptId, {
      raw: true,
    });
    if (existing && sameRetirementIdentity(rowToRecord(existing), record))
      return 'existing';
    throw new LocalArtifactRetentionRecordConflictError();
  }
}
