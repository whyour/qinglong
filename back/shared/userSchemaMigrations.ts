import { QueryTypes, Sequelize } from 'sequelize';
export async function migrateUserSchema(database: Sequelize): Promise<void> {
  const columns = [
    { table: 'Users', column: 'sessions', type: "JSON NOT NULL DEFAULT '[]'" },
    ...['Envs', 'Crontabs', 'Subscriptions', 'Dependences'].map((table) => ({
      table,
      column: 'userId',
      type: 'INTEGER',
    })),
  ];
  await database.transaction(async (transaction) => {
    for (const { table, column, type } of columns) {
      const fields = await database.query<{ name: string }>(
        `PRAGMA table_info("${table}")`,
        { type: QueryTypes.SELECT, transaction },
      );
      if (!fields.length)
        throw new Error(`User migration table is missing: ${table}`);
      if (!fields.some((field) => field.name === column))
        await database.query(
          `ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`,
          { transaction },
        );
    }
  });
}
