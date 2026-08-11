import { createHash } from 'crypto';
import { DataTypes } from 'sequelize';
import type { Migration } from './types';

type ColumnType = 'string' | 'integer' | 'text' | 'json';

interface LegacyColumn {
  table: string;
  column: string;
  type: ColumnType;
}

const columns: LegacyColumn[] = [
  { table: 'CrontabViews', column: 'filterRelation', type: 'string' },
  { table: 'Subscriptions', column: 'proxy', type: 'string' },
  { table: 'CrontabViews', column: 'type', type: 'integer' },
  { table: 'Subscriptions', column: 'autoAddCron', type: 'integer' },
  { table: 'Subscriptions', column: 'autoDelCron', type: 'integer' },
  { table: 'Crontabs', column: 'sub_id', type: 'integer' },
  { table: 'Crontabs', column: 'extra_schedules', type: 'json' },
  { table: 'Crontabs', column: 'task_before', type: 'text' },
  { table: 'Crontabs', column: 'task_after', type: 'text' },
  { table: 'Crontabs', column: 'log_name', type: 'string' },
  {
    table: 'Crontabs',
    column: 'allow_multiple_instances',
    type: 'integer',
  },
  { table: 'Crontabs', column: 'work_dir', type: 'string' },
  { table: 'Envs', column: 'isPinned', type: 'integer' },
  { table: 'Envs', column: 'labels', type: 'json' },
];

export const legacyColumnOwnership: readonly {
  table: string;
  column: string;
  type: ColumnType;
}[] = columns;

function dataType(type: ColumnType) {
  switch (type) {
    case 'integer':
      return DataTypes.INTEGER;
    case 'text':
      return DataTypes.TEXT;
    case 'json':
      return DataTypes.JSON;
    default:
      return DataTypes.STRING;
  }
}

export const legacyColumnsMigration: Migration = {
  id: '0001-legacy-columns',
  checksum: createHash('sha256').update(JSON.stringify(columns)).digest('hex'),
  async up({ queryInterface, transaction }) {
    const descriptions = new Map<string, Record<string, unknown>>();

    for (const definition of columns) {
      let description = descriptions.get(definition.table);
      if (!description) {
        description = await queryInterface.describeTable(definition.table);
        descriptions.set(definition.table, description);
      }

      if (
        Object.prototype.hasOwnProperty.call(description, definition.column)
      ) {
        continue;
      }

      await queryInterface.addColumn(
        definition.table,
        definition.column,
        {
          type: dataType(definition.type),
          allowNull: true,
        },
        { transaction },
      );
      description[definition.column] = {};
    }
  },
};
