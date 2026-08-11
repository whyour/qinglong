const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  registerPluginPackageInstallRepositoryContract,
} = require('../../../test/contracts/pluginPackageInstallRepositoryContract.cjs');

const {
  PluginPackageInstallMutationConflictError,
  PluginPackageInstallTransitionConflictError,
  PluginPackageInstallUnavailableError,
  createPluginPackageInstall,
  createPluginPackageLock,
  pluginPackageInstallActionDigest,
  pluginPackageInstallCommit,
  pluginPackageInstallCreate,
  pluginPackageInstallPlanDigest,
  transitionPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package-install');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('../dist/plugin-package/pluginPackageInstallRepository');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');

const ARTIFACT_DIGEST = 'a'.repeat(64);
const CONTENT_DIGEST = 'b'.repeat(64);

function manifest(packageName = 'example-monitor') {
  return {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: packageName,
      displayName: packageName,
      version: '1.2.0',
      description: 'One bounded package',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['edge'],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '16Mi' },
        disk: { install: '4Mi', working: '16Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [],
        tools: [],
      },
      contents: {
        tasks: [],
        workflows: [],
        prompts: [],
        tools: [],
      },
    },
  };
}

function environment() {
  return {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'edge',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
}

function fixture(overrides = {}) {
  const packageManifest = manifest(overrides.packageName ?? 'example-monitor');
  const installEnvironment = environment();
  const plan = planPluginPackageInstall(packageManifest, installEnvironment);
  const source = {
    kind: 'offline',
    locator: `offline:sha256:${ARTIFACT_DIGEST}`,
    artifactDigest: ARTIFACT_DIGEST,
    artifactBytes: 2048,
    contentDigest: CONTENT_DIGEST,
  };
  const actionInput = {
    lockId: overrides.lockId ?? 'lock-001',
    projectId: 'default',
    manifest: packageManifest,
    plan,
    environment: installEnvironment,
    source,
    architecture: 'arm64',
    deploymentProfile: 'edge',
    targetGeneration: 1,
  };
  const lock = createPluginPackageLock({
    ...actionInput,
    approval: {
      requestId: `approval-${overrides.lockId ?? '001'}`,
      requestVersion: 1,
      dispatchId: `dispatch-${overrides.lockId ?? '001'}`,
      actionDigest: pluginPackageInstallActionDigest(actionInput),
      previewDigest: pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 10_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200,
  });
  const install = createPluginPackageInstall(lock, {
    installationId: overrides.installationId ?? 'install-001',
    mutationId: overrides.mutationId ?? 'mutation-create',
    occurredAtMs: overrides.occurredAtMs ?? 201,
  });
  return { lock, install };
}

function stage(lock, install, overrides = {}) {
  return transitionPluginPackageInstall(lock, install, {
    type: 'stage_completed',
    mutationId: overrides.mutationId ?? 'mutation-stage',
    occurredAtMs: overrides.occurredAtMs ?? install.updatedAtMs + 1,
    stageRef: `local-stage:${lock.lockDigest}`,
    artifactDigest: lock.source.artifactDigest,
    manifestDigest: lock.manifestDigest,
    contentDigest: lock.source.contentDigest,
    evidenceDigest: 'e'.repeat(64),
  });
}

async function repository(t) {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  t.after(() => client.close());
  return {
    client,
    repository: new LocalSqlitePluginPackageInstallRepository(client),
  };
}

registerPluginPackageInstallRepositoryContract({
  name: 'SQLite Plugin Package install repository',
  async createRepository() {
    const client = new DatabaseSync(':memory:');
    client.exec('PRAGMA foreign_keys = ON');
    await migrateLocalSqliteDatabase(client);
    return {
      repository: new LocalSqlitePluginPackageInstallRepository(client),
      close: () => client.close(),
    };
  },
});

test('creates and finds one queued install with a durable head and mutation', async (t) => {
  const { client, repository: store } = await repository(t);
  const value = fixture();
  const result = await store.create(
    pluginPackageInstallCreate(value.lock, value.install, null),
  );
  assert.equal(result.status, 'created');
  assert.deepEqual(
    await store.find('default', 'example-monitor'),
    value.install,
  );
  assert.deepEqual(await store.findLock(value.lock.lockDigest), value.lock);
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT
           (SELECT count(*) FROM "QingLong3PluginPackageInstalls") AS installs,
           (SELECT count(*) FROM "QingLong3PluginPackageInstallHeads") AS heads,
           (SELECT count(*) FROM "QingLong3PluginPackageInstallMutations") AS mutations`,
        )
        .get(),
    },
    { installs: 1, heads: 1, mutations: 1 },
  );
});

test('replays an exact create and rejects reuse with different locked facts', async (t) => {
  const { repository: store } = await repository(t);
  const value = fixture();
  const command = pluginPackageInstallCreate(value.lock, value.install, null);
  await store.create(command);
  const replay = await store.create(command);
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.record, value.install);

  const drift = fixture({
    lockId: 'lock-drift',
    installationId: value.install.installationId,
    mutationId: value.install.lastMutationId,
  });
  await assert.rejects(
    store.create(pluginPackageInstallCreate(drift.lock, drift.install, null)),
    PluginPackageInstallMutationConflictError,
  );
});

test('commits exact CAS transitions and rejects stale durable state', async (t) => {
  const { repository: store } = await repository(t);
  const value = fixture();
  await store.create(
    pluginPackageInstallCreate(value.lock, value.install, null),
  );
  const staged = stage(value.lock, value.install);
  const command = pluginPackageInstallCommit(value.install, staged);
  const committed = await store.commit(command);
  assert.equal(committed.status, 'committed');
  assert.deepEqual(await store.find('default', 'example-monitor'), staged);
  assert.equal((await store.commit(command)).status, 'existing');

  const competing = stage(value.lock, value.install, {
    mutationId: 'mutation-competing-stage',
  });
  await assert.rejects(
    store.commit(pluginPackageInstallCommit(value.install, competing)),
    PluginPackageInstallTransitionConflictError,
  );
});

test('keeps old mutation replay idempotent after the record advances', async (t) => {
  const { repository: store } = await repository(t);
  const value = fixture();
  const create = pluginPackageInstallCreate(value.lock, value.install, null);
  await store.create(create);
  const staged = stage(value.lock, value.install);
  await store.commit(pluginPackageInstallCommit(value.install, staged));
  const activating = transitionPluginPackageInstall(value.lock, staged, {
    type: 'activation_started',
    mutationId: 'mutation-activate',
    occurredAtMs: 203,
  });
  await store.commit(pluginPackageInstallCommit(staged, activating));

  const replay = await store.create(create);
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.record, activating);
});

test('replaces only an exact terminal head and preserves install history', async (t) => {
  const { client, repository: store } = await repository(t);
  const first = fixture();
  await store.create(
    pluginPackageInstallCreate(first.lock, first.install, null),
  );
  const failed = transitionPluginPackageInstall(first.lock, first.install, {
    type: 'failed',
    mutationId: 'mutation-fail',
    occurredAtMs: 202,
    reason: 'stage_failed',
  });
  await store.commit(pluginPackageInstallCommit(first.install, failed));

  const retry = fixture({
    lockId: 'lock-retry',
    installationId: 'install-002',
    mutationId: 'mutation-retry',
    occurredAtMs: 203,
  });
  await store.create(
    pluginPackageInstallCreate(retry.lock, retry.install, failed),
  );
  assert.deepEqual(
    await store.find('default', 'example-monitor'),
    retry.install,
  );
  assert.equal(
    client
      .prepare(`SELECT count(*) AS count FROM "QingLong3PluginPackageInstalls"`)
      .get().count,
    2,
  );

  const stale = fixture({
    lockId: 'lock-stale',
    installationId: 'install-003',
    mutationId: 'mutation-stale',
    occurredAtMs: 204,
  });
  await assert.rejects(
    store.create(pluginPackageInstallCreate(stale.lock, stale.install, failed)),
    PluginPackageInstallTransitionConflictError,
  );
});

test('paginates only current recoverable heads with a stable cursor', async (t) => {
  const { repository: store } = await repository(t);
  const alpha = fixture({
    packageName: 'alpha',
    lockId: 'lock-alpha',
    installationId: 'install-alpha',
    mutationId: 'mutation-alpha',
  });
  const beta = fixture({
    packageName: 'beta',
    lockId: 'lock-beta',
    installationId: 'install-beta',
    mutationId: 'mutation-beta',
  });
  await store.create(
    pluginPackageInstallCreate(alpha.lock, alpha.install, null),
  );
  await store.create(pluginPackageInstallCreate(beta.lock, beta.install, null));
  const first = await store.listRecoveryPage({ limit: 1 });
  assert.equal(first.truncated, true);
  assert.deepEqual(first.records, [alpha.install]);
  assert.deepEqual(first.next, {
    packageName: 'alpha',
    installationId: 'install-alpha',
  });
  const second = await store.listRecoveryPage({
    limit: 1,
    after: first.next,
  });
  assert.deepEqual(second.records, [beta.install]);
  assert.equal(second.truncated, false);

  const failed = transitionPluginPackageInstall(alpha.lock, alpha.install, {
    type: 'failed',
    mutationId: 'mutation-alpha-fail',
    occurredAtMs: 202,
    reason: 'source_unavailable',
  });
  await store.commit(pluginPackageInstallCommit(alpha.install, failed));
  assert.deepEqual((await store.listRecoveryPage({ limit: 64 })).records, [
    beta.install,
  ]);
});

test('lists every current installation head by project with a bounded cursor', async (t) => {
  const { repository: store } = await repository(t);
  const alpha = fixture({
    packageName: 'alpha',
    lockId: 'inventory-alpha',
    installationId: 'inventory-alpha',
    mutationId: 'inventory-alpha-create',
  });
  const beta = fixture({
    packageName: 'beta',
    lockId: 'inventory-beta',
    installationId: 'inventory-beta',
    mutationId: 'inventory-beta-create',
  });
  await store.create(
    pluginPackageInstallCreate(alpha.lock, alpha.install, null),
  );
  await store.create(pluginPackageInstallCreate(beta.lock, beta.install, null));
  const failed = transitionPluginPackageInstall(alpha.lock, alpha.install, {
    type: 'failed',
    mutationId: 'inventory-alpha-failed',
    occurredAtMs: 202,
    reason: 'source_unavailable',
  });
  await store.commit(pluginPackageInstallCommit(alpha.install, failed));

  const first = await store.listCurrentPage({
    projectId: 'default',
    limit: 1,
  });
  assert.equal(first.truncated, true);
  assert.deepEqual(first.items, [{ record: failed, quarantine: null }]);
  assert.deepEqual(first.next, { packageName: 'alpha' });

  const second = await store.listCurrentPage({
    projectId: 'default',
    limit: 1,
    after: first.next,
  });
  assert.deepEqual(second.items, [{ record: beta.install, quarantine: null }]);
  assert.equal(second.truncated, false);
  assert.equal(second.next, undefined);
  assert.deepEqual(
    await store.listCurrentPage({ projectId: 'missing', limit: 64 }),
    { items: [], truncated: false },
  );
});

test('fails closed for archived projects and corrupt persisted JSON', async (t) => {
  const { client, repository: store } = await repository(t);
  client
    .prepare(
      `UPDATE "QingLong3Projects" SET "status" = 'archived' WHERE "id" = 'default'`,
    )
    .run();
  const value = fixture();
  await assert.rejects(
    store.create(pluginPackageInstallCreate(value.lock, value.install, null)),
    PluginPackageInstallTransitionConflictError,
  );
  client
    .prepare(
      `UPDATE "QingLong3Projects" SET "status" = 'active' WHERE "id" = 'default'`,
    )
    .run();
  await store.create(
    pluginPackageInstallCreate(value.lock, value.install, null),
  );
  client.exec('PRAGMA ignore_check_constraints = ON');
  client
    .prepare(
      `UPDATE "QingLong3PluginPackageInstalls"
       SET "lock_json" = '{"schema":"corrupt"}'
       WHERE "installation_id" = ?`,
    )
    .run(value.install.installationId);
  await assert.rejects(
    store.findLock(value.lock.lockDigest),
    PluginPackageInstallUnavailableError,
  );
  client
    .prepare(
      `UPDATE "QingLong3PluginPackageInstalls"
       SET "lock_json" = ?
       WHERE "installation_id" = ?`,
    )
    .run(JSON.stringify(value.lock), value.install.installationId);
  client
    .prepare(
      `UPDATE "QingLong3PluginPackageInstalls"
       SET "record_json" = '{"schema":"corrupt"}'
       WHERE "installation_id" = ?`,
    )
    .run(value.install.installationId);
  await assert.rejects(
    store.find('default', 'example-monitor'),
    PluginPackageInstallUnavailableError,
  );
});

test('publishes the repository only through its explicit SQLite subpath', () => {
  const root = require('../dist');
  const subpath = require('@qinglong/local-sqlite/plugin-package-install');
  assert.equal(root.LocalSqlitePluginPackageInstallRepository, undefined);
  assert.equal(
    subpath.LocalSqlitePluginPackageInstallRepository,
    LocalSqlitePluginPackageInstallRepository,
  );
});
