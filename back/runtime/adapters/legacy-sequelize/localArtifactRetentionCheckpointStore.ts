import {
  DataTypes,
  Model,
  type ModelStatic,
  Sequelize,
  UniqueConstraintError,
} from 'sequelize';
import { LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE } from '../../../migrations/0016-local-artifact-maintenance-cursor';
import {
  normalizeLocalArtifactRetentionCursor,
  assertLocalArtifactRetentionTimestamp,
} from '../../domain/localArtifactRetention';
import {
  normalizeLocalArtifactRetentionCheckpoint,
  type LocalArtifactRetentionCheckpoint,
} from '../../domain/localArtifactRetentionCheckpoint';
import type { LocalArtifactRetentionCheckpointStore } from '../../ports/localArtifactRetentionCheckpointStore';

const RETENTION_SCOPE = 'retention';

interface CursorRow {
  scope: string;
  cursorFinishedAtMs: number | string | null;
  cursorAttemptId: string | null;
  version: number | string;
  updatedAtMs: number | string;
}

interface CursorInstance extends Model<CursorRow, CursorRow>, CursorRow {}

function defineCursorModel(database: Sequelize): ModelStatic<CursorInstance> {
  return database.define<CursorInstance>(
    'Ql3LocalArtifactMaintenanceCursor',
    {
      scope: { type: DataTypes.STRING(32), allowNull: false, primaryKey: true },
      cursorFinishedAtMs: {
        field: 'cursor_finished_at_ms',
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      cursorAttemptId: {
        field: 'cursor_attempt_id',
        type: DataTypes.STRING(36),
        allowNull: true,
      },
      version: { type: DataTypes.BIGINT, allowNull: false },
      updatedAtMs: {
        field: 'updated_at_ms',
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    {
      tableName: LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
}

function rowToCheckpoint(
  row: CursorRow,
): Readonly<LocalArtifactRetentionCheckpoint> {
  const finishedAtMs =
    row.cursorFinishedAtMs === null ? null : Number(row.cursorFinishedAtMs);
  const attemptId = row.cursorAttemptId;
  if ((finishedAtMs === null) !== (attemptId === null)) {
    throw new TypeError('Local Artifact retention cursor row is corrupt');
  }
  return normalizeLocalArtifactRetentionCheckpoint({
    version: Number(row.version),
    ...(finishedAtMs === null || attemptId === null
      ? {}
      : { cursor: { finishedAtMs, attemptId } }),
  });
}

export class LegacySequelizeLocalArtifactRetentionCheckpointStore
  implements LocalArtifactRetentionCheckpointStore
{
  private readonly cursors: ModelStatic<CursorInstance>;

  constructor(database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Local Artifact retention checkpoint store is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
    this.cursors = defineCursorModel(database);
  }

  async load(): Promise<Readonly<LocalArtifactRetentionCheckpoint>> {
    const row = await this.cursors.findByPk(RETENTION_SCOPE, { raw: true });
    return row
      ? rowToCheckpoint(row)
      : normalizeLocalArtifactRetentionCheckpoint({ version: 0 });
  }

  async compareAndSet({
    expectedVersion,
    cursor,
    updatedAtMs,
  }: Parameters<
    LocalArtifactRetentionCheckpointStore['compareAndSet']
  >[0]): Promise<boolean> {
    const checkpoint = normalizeLocalArtifactRetentionCheckpoint({
      version: expectedVersion,
      ...(cursor ? { cursor } : {}),
    });
    assertLocalArtifactRetentionTimestamp('updatedAtMs', updatedAtMs);
    const next = {
      scope: RETENTION_SCOPE,
      cursorFinishedAtMs: checkpoint.cursor?.finishedAtMs ?? null,
      cursorAttemptId: checkpoint.cursor?.attemptId ?? null,
      version: checkpoint.version + 1,
      updatedAtMs,
    };
    if (checkpoint.version === 0) {
      try {
        await this.cursors.create(next);
        return true;
      } catch (error) {
        if (error instanceof UniqueConstraintError) return false;
        throw error;
      }
    }
    const [updated] = await this.cursors.update(next, {
      where: { scope: RETENTION_SCOPE, version: checkpoint.version },
    });
    return updated === 1;
  }
}
