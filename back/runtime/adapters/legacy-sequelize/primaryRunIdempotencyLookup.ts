import { DataTypes, Model, ModelStatic, Sequelize } from 'sequelize';
import { RUN_TABLE } from '../../../migrations/0002-run-schema';
import type { PrimaryRunIdempotencyLookup } from '../../ports/primaryRunIdempotencyLookup';

interface IdempotentRunRow {
  id: string;
  projectId: string;
  idempotencyKey: string | null;
}

interface IdempotentRunInstance
  extends Model<IdempotentRunRow, IdempotentRunRow>,
    IdempotentRunRow {}

function defineIdempotentRunModel(
  database: Sequelize,
): ModelStatic<IdempotentRunInstance> {
  return database.define<IdempotentRunInstance>(
    'Ql3PrimaryIdempotentRun',
    {
      id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true },
      projectId: {
        field: 'project_id',
        type: DataTypes.STRING(128),
        allowNull: false,
      },
      idempotencyKey: {
        field: 'idempotency_key',
        type: DataTypes.STRING(255),
        allowNull: true,
      },
    },
    {
      tableName: RUN_TABLE,
      timestamps: false,
      freezeTableName: true,
    },
  );
}

export class LegacySequelizePrimaryRunIdempotencyLookup
  implements PrimaryRunIdempotencyLookup
{
  private readonly run: ModelStatic<IdempotentRunInstance>;

  constructor(database: Sequelize) {
    this.run = defineIdempotentRunModel(database);
  }

  async findRunId(
    projectId: string,
    idempotencyKey: string,
  ): Promise<string | null> {
    if (!projectId || projectId.length > 128) {
      throw new RangeError('projectId must be between 1 and 128 characters');
    }
    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw new RangeError(
        'idempotencyKey must be between 1 and 255 characters',
      );
    }
    const row = await this.run.findOne({
      attributes: ['id'],
      where: { projectId, idempotencyKey },
      raw: true,
    });
    return row?.id ?? null;
  }
}
