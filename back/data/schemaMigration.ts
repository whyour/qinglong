import { DataTypes, Model, ModelStatic, Sequelize } from 'sequelize';
import { sequelize } from '.';

export interface SchemaMigrationAttributes {
  id: string;
  checksum: string;
  applied_at: number;
}

export interface SchemaMigrationInstance
  extends Model<SchemaMigrationAttributes, SchemaMigrationAttributes>,
    SchemaMigrationAttributes {}

export function defineSchemaMigrationModel(
  database: Sequelize,
): ModelStatic<SchemaMigrationInstance> {
  return database.define<SchemaMigrationInstance>(
    'SchemaMigration',
    {
      id: {
        type: DataTypes.STRING,
        primaryKey: true,
      },
      checksum: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      applied_at: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
    },
    {
      tableName: 'SchemaMigrations',
      timestamps: false,
    },
  );
}

export const SchemaMigrationModel = defineSchemaMigrationModel(sequelize);
