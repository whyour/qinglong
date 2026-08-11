const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  ProjectToolDefinitionSnapshotUnavailableError,
} = require('@qinglong/runtime-core/project-tool-definition-snapshot');
const {
  registerProjectToolDefinitionSnapshotRepositoryContract,
  projectToolDefinitionSnapshotForFixture,
} = require('../../../test/contracts/projectToolDefinitionSnapshotRepositoryContract.cjs');
const {
  LocalSqliteOperationAuthority,
} = require('../dist/authority/operationAuthority');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('../dist/plugin-package/pluginPackageInstallRepository');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('../dist/plugin-package/pluginPackageMaterializedRevisionRepository');
const {
  LocalSqliteProjectToolDefinitionSnapshotRepository,
} = require('../dist/tool-execution/projectToolDefinitionSnapshotRepository');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

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
  const authority = new LocalSqliteOperationAuthority(client);
  return {
    client,
    repository:
      new LocalSqliteProjectToolDefinitionSnapshotRepository(authority),
    installRepository:
      new LocalSqlitePluginPackageInstallRepository(authority),
    materializedRepository:
      new LocalSqlitePluginPackageMaterializedRevisionRepository(
        authority,
        fixture.registry,
      ),
    close: () => authority.close(),
  };
}

registerProjectToolDefinitionSnapshotRepositoryContract({
  name: 'SQLite Project Tool Definition snapshot repository',
  namespace: 'sqlite-tool-snapshot',
  profile: 'edge',
  createRepository,
  assertDurableSource(harness, value) {
    assert.deepEqual(
      {
        ...harness.client
          .prepare(
            `SELECT installation_id AS "installationId",
                    generation_digest AS "generationDigest",
                    revision_digest AS "revisionDigest"
             FROM "QingLong3ProjectToolDefinitionSnapshotSources"`,
          )
          .get(),
      },
      {
        installationId: value.install.active.installationId,
        generationDigest: value.revision.generation.generationDigest,
        revisionDigest: value.revision.revisionDigest,
      },
    );
  },
});

test('SQLite Project Tool Definition snapshot fails closed on source loss', async (t) => {
  const value = pluginPackageTaskReconciliationFixture(
    'sqlite-tool-snapshot-corrupt',
    { profile: 'edge' },
  );
  const harness = await createRepository(t, value);
  t.after(() => harness.close());
  await activateInstall(harness.installRepository, value);
  await harness.materializedRepository.publish(value.revision);
  await harness.repository.publish(
    projectToolDefinitionSnapshotForFixture(value),
  );
  harness.client.exec('PRAGMA foreign_keys = OFF');
  harness.client
    .prepare(
      `DELETE FROM "QingLong3ProjectToolDefinitionSnapshotSources"
       WHERE project_id = ?`,
    )
    .run(value.projectId);
  await assert.rejects(
    harness.repository.findCurrent(value.projectId),
    ProjectToolDefinitionSnapshotUnavailableError,
  );
});

test('publishes snapshot storage only through the explicit subpath', () => {
  const entrypoint = require('@qinglong/local-sqlite/project-tool-definition-snapshot');
  assert.equal(
    entrypoint.LocalSqliteProjectToolDefinitionSnapshotRepository,
    LocalSqliteProjectToolDefinitionSnapshotRepository,
  );
  assert.equal(
    require('../dist').LocalSqliteProjectToolDefinitionSnapshotRepository,
    undefined,
  );
});
