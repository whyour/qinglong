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
  { table: 'Subscriptions', column: 'skipFiles', type: 'TEXT' },
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
    await migrateDependencyIdentity(database, transaction);
  });
}

async function migrateDependencyIdentity(
  database: Sequelize,
  transaction: any,
) {
  const tables = await database.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Dependences'",
    { type: QueryTypes.SELECT, transaction },
  );
  if (!tables.length) return;
  const id = 'deduplicate-dependency-identity';
  const applied = await database.query(
    'SELECT id FROM SchemaMigrations WHERE id = :id',
    { replacements: { id }, type: QueryTypes.SELECT, transaction },
  );
  if (applied.length) return;
  // Archive complete original rows before normalizing or removing duplicates.
  // Keep an installed row where possible, otherwise the oldest row/ID.
  await database.query(
    'CREATE TABLE IF NOT EXISTS DependenceDuplicates AS SELECT * FROM Dependences WHERE 0',
    { transaction },
  );
  const duplicates = `SELECT d.id FROM Dependences d WHERE EXISTS (
    SELECT 1 FROM Dependences keep WHERE keep.type = d.type AND trim(keep.name) = trim(d.name)
    AND (CASE WHEN keep.status = 1 THEN 0 ELSE 1 END < CASE WHEN d.status = 1 THEN 0 ELSE 1 END
    OR (CASE WHEN keep.status = 1 THEN 0 ELSE 1 END = CASE WHEN d.status = 1 THEN 0 ELSE 1 END AND keep.id < d.id)))`;
  await database.query(
    `INSERT INTO DependenceDuplicates SELECT * FROM Dependences WHERE id IN (${duplicates})`,
    { transaction },
  );
  await database.query(`DELETE FROM Dependences WHERE id IN (${duplicates})`, {
    transaction,
  });
  await database.query('UPDATE Dependences SET name = trim(name)', {
    transaction,
  });
  await database.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS dependence_type_name ON Dependences (type, name)',
    { transaction },
  );
  await database.query(
    'INSERT INTO SchemaMigrations (id, applied_at) VALUES (:id, :appliedAt)',
    {
      replacements: { id, appliedAt: new Date().toISOString() },
      transaction,
    },
  );
}
