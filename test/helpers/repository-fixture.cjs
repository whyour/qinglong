const { Repository } = require('../../back/data/repository');
const { initialSchema } = require('../../back/data/schema');
const { migrateSchema } = require('../../back/shared/schemaMigrations');
async function initialize(db) {
  await db.transaction(async () => {
    for (const sql of initialSchema) await db.query(sql);
    await migrateSchema(db);
  });
}
// Historical concurrency fixtures omitted required instance metadata unrelated
// to their assertions. Supply it explicitly at this test-only fixture boundary.
function repository(db, name) {
  const repo = new Repository(name, () => db);
  if (name === 'RunningInstance') {
    const insert = repo.insert.bind(repo);
    repo.insert = (data) =>
      insert({ cron_id: 1, started_at: 100, status: 0, ...data });
  }
  return repo;
}
module.exports = { repository, initialize };
