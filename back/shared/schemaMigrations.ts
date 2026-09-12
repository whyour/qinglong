import { QueryTypes, Sequelize } from 'sequelize';

// Append new entries; IDs are persisted and must not be renumbered or reused.
const columns = [
  {
    table: 'CrontabViews',
    column: 'filterRelation',
    type: 'VARCHAR(255)',
  },
  { table: 'Subscriptions', column: 'proxy', type: 'VARCHAR(255)' },
  { table: 'CrontabViews', column: 'type', type: 'NUMBER' },
  { table: 'Subscriptions', column: 'autoAddCron', type: 'NUMBER' },
  { table: 'Subscriptions', column: 'autoDelCron', type: 'NUMBER' },
  { table: 'Crontabs', column: 'sub_id', type: 'NUMBER' },
  { table: 'Crontabs', column: 'extra_schedules', type: 'JSON' },
  { table: 'Crontabs', column: 'task_before', type: 'TEXT' },
  { table: 'Crontabs', column: 'task_after', type: 'TEXT' },
  { table: 'Crontabs', column: 'log_name', type: 'VARCHAR(255)' },
  {
    table: 'Crontabs',
    column: 'allow_multiple_instances',
    type: 'NUMBER',
  },
  { table: 'Crontabs', column: 'work_dir', type: 'VARCHAR(255)' },
  { table: 'Envs', column: 'isPinned', type: 'NUMBER' },
  { table: 'Envs', column: 'labels', type: 'JSON' },
  { table: 'Crontabs', column: 'queued_token', type: 'VARCHAR(255)' },
];

export async function migrateSchema(database: Sequelize): Promise<void> {
  await database.transaction(async (transaction) => {
    await database.query(
      'CREATE TABLE IF NOT EXISTS "SchemaMigrations" ("id" TEXT PRIMARY KEY, "applied_at" TEXT NOT NULL)',
      { transaction },
    );
    const applied = await database.query<{ id: string }>(
      'SELECT "id" FROM "SchemaMigrations"',
      { type: QueryTypes.SELECT, transaction },
    );
    const appliedIds = new Set(applied.map(({ id }) => id));
    for (const { table, column, type } of columns) {
      const id = `add-${table}-${column}`;
      const fields = await database.query<{ name: string }>(
        `PRAGMA table_info("${table}")`,
        {
          type: QueryTypes.SELECT,
          transaction,
        },
      );
      if (fields.length === 0)
        throw new Error(`Migration table is missing: ${table}`);
      if (!fields.some((field) => field.name === column)) {
        // table/column/type come only from the static migration manifest above.
        await database.query(
          `ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`,
          { transaction },
        );
      }
      if (!appliedIds.has(id)) {
        await database.query(
          'INSERT INTO "SchemaMigrations" ("id", "applied_at") VALUES (:id, :appliedAt)',
          {
            replacements: { id, appliedAt: new Date().toISOString() },
            transaction,
          },
        );
      }
    }
  });
}
