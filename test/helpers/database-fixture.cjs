const { DatabaseClient } = require('../../back/data/databaseClient');
const { Repository } = require('../../back/data/repository');
const { initialSchema } = require('../../back/data/schema');
const { migrateSchema } = require('../../back/shared/schemaMigrations');
async function createDatabase(t, storage = ':memory:') {
  const database = new DatabaseClient(storage);
  t.after(() => database.close());
  await database.transaction(async () => {
    for (const statement of initialSchema) await database.query(statement);
    await migrateSchema(database);
  });
  return {
    database,
    repository: (name) => new Repository(name, () => database),
  };
}
module.exports = { createDatabase };
