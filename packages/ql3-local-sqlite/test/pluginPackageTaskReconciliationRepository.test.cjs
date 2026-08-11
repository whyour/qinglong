const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  PluginPackageTaskReconciliationConflictError,
} = require('@qinglong/runtime-core/plugin-package-task-reconciliation');
const {
  TaskDefinitionConflictError,
} = require('@qinglong/runtime-core/task-definition');
const {
  registerPluginPackageTaskReconciliationRepositoryContract,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  LocalSqlitePluginPackageTaskReconciliationRepository,
} = require('../dist/plugin-package/pluginPackageTaskReconciliationRepository');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('../dist/plugin-package/pluginPackageMaterializedRevisionRepository');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('../dist/plugin-package/pluginPackageInstallRepository');
const {
  LocalSqliteTaskDefinitionRepository,
} = require('../dist/task-definition/taskDefinitionRepository');
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
    repository:
      new LocalSqlitePluginPackageTaskReconciliationRepository(
        client,
        fixture.registry,
      ),
    materializedRepository:
      new LocalSqlitePluginPackageMaterializedRevisionRepository(
        client,
        fixture.registry,
      ),
    installRepository: new LocalSqlitePluginPackageInstallRepository(client),
    taskRepository: new LocalSqliteTaskDefinitionRepository(
      client,
      fixture.registry,
    ),
    close: () => client.close(),
  };
}

registerPluginPackageTaskReconciliationRepositoryContract({
  name: 'SQLite Plugin Package Task reconciliation repository',
  namespace: 'sqlite-task-reconcile',
  profile: 'edge',
  createRepository,
  async assertGenericWriteRejected(harness, fixture) {
    const task = await harness.taskRepository.findCurrentTaskDefinition(
      fixture.projectId,
      `pkg:${fixture.packageName}:alpha`,
    );
    await assert.rejects(
      harness.taskRepository.appendTaskDefinitionRevision({
        projectId: task.projectId,
        taskId: task.taskId,
        expectedRevision: task.revision,
        mutationId: '019f9000-0000-4000-a000-000000000001',
        name: 'Bypass',
        kind: task.kind,
        spec: task.spec,
        labels: task.labels,
        enabled: task.enabled,
        occurredAtMs: task.updatedAtMs + 1,
      }),
      TaskDefinitionConflictError,
    );
  },
  async assertDurableUpgrade(harness, fixture) {
    const beta = await harness.taskRepository.findCurrentTaskDefinition(
      fixture.projectId,
      `pkg:${fixture.packageName}:beta`,
    );
    assert.equal(beta.revision, 2);
    assert.equal(beta.enabled, false);
    assert.equal(
      harness.client
        .prepare(
          `SELECT COUNT(*) AS count
           FROM "QingLong3PluginPackageTaskOwnerships"
           WHERE project_id = ? AND package_name = ?`,
        )
        .get(fixture.projectId, fixture.packageName).count,
      3,
    );
  },
});

test('rolls back when the external generation fence changes', async (t) => {
  const {
    pluginPackageTaskReconciliationFixture,
    activateInstall,
  } = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
  const fixture = pluginPackageTaskReconciliationFixture(
    'sqlite-task-reconcile-fence',
  );
  const harness = await createRepository(t, fixture);
  t.after(() => harness.close());
  await activateInstall(harness.installRepository, fixture);
  await harness.materializedRepository.publish(fixture.revision);
  await assert.rejects(
    harness.repository.reconcile(fixture.revision, {
      async findActiveResourceGeneration() {
        return null;
      },
    }),
    PluginPackageTaskReconciliationConflictError,
  );
  assert.equal(
    harness.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3TaskDefinitions" WHERE project_id = ?`,
      )
      .get(fixture.projectId).count,
    0,
  );
  assert.equal(
    await harness.repository.find(fixture.revision.generation.generationDigest),
    null,
  );
});

test('publishes storage only through the explicit subpath', () => {
  const entrypoint = require('@qinglong/local-sqlite/plugin-package-task-reconciliation');
  assert.equal(
    entrypoint.LocalSqlitePluginPackageTaskReconciliationRepository,
    LocalSqlitePluginPackageTaskReconciliationRepository,
  );
  assert.equal(
    require('../dist').LocalSqlitePluginPackageTaskReconciliationRepository,
    undefined,
  );
});
