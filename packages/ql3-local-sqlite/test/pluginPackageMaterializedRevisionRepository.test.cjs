const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  materializedRevisionFixture,
  registerPluginPackageMaterializedRevisionRepositoryContract,
} = require('../../../test/contracts/pluginPackageMaterializedRevisionRepositoryContract.cjs');
const {
  PluginPackageResourceMaterializationUnavailableError,
} = require('@qinglong/runtime-core/plugin-package-resource-materialization');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('../dist/plugin-package/pluginPackageMaterializedRevisionRepository');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');

async function createRepository(_t, fixture) {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  client
    .prepare(
      `INSERT INTO "QingLong3Projects"
       (id, name, slug, status, version, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'active', 1, 1, 1)`,
    )
    .run(fixture.projectId, fixture.projectId, fixture.projectId);
  return {
    client,
    repository: new LocalSqlitePluginPackageMaterializedRevisionRepository(
      client,
      fixture.registry,
    ),
    close: () => client.close(),
  };
}

registerPluginPackageMaterializedRevisionRepositoryContract({
  name: 'SQLite Plugin Package materialized revision repository',
  namespace: 'sqlite-materialized',
  profile: 'edge',
  createRepository,
});

test('fails closed when durable semantic JSON is changed in place', async (t) => {
  const fixture = materializedRevisionFixture('sqlite-corrupt');
  const harness = await createRepository(t, fixture);
  t.after(() => harness.close());
  await harness.repository.publish(fixture.revision);
  harness.client.exec('PRAGMA ignore_check_constraints = ON');
  harness.client
    .prepare(
      `UPDATE "QingLong3PluginPackageMaterializedRevisions"
       SET revision_json =
         json_set(revision_json, '$.resources[0].value.name', 'Changed')
       WHERE generation_digest = ?`,
    )
    .run(fixture.revision.generation.generationDigest);
  await assert.rejects(
    harness.repository.find(fixture.revision.generation.generationDigest),
    PluginPackageResourceMaterializationUnavailableError,
  );
});

test('publishes storage only through the explicit subpath', () => {
  const entrypoint = require('@qinglong/local-sqlite/plugin-package-materialized-revision');
  assert.equal(
    entrypoint.LocalSqlitePluginPackageMaterializedRevisionRepository,
    LocalSqlitePluginPackageMaterializedRevisionRepository,
  );
  assert.equal(
    require('../dist').LocalSqlitePluginPackageMaterializedRevisionRepository,
    undefined,
  );
});
