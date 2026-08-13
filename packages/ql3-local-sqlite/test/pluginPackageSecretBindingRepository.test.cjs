const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  PluginPackageSecretBindingConflictError,
  PluginPackageSecretBindingUnavailableError,
  createPluginPackageSecretBinding,
} = require('@qinglong/runtime-core/plugin-package-secret-binding');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  LocalSqlitePluginPackageSecretBindingRepository,
} = require('../dist/plugin-package/secret-binding/repository');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');

const LOCK_DIGEST = 'a'.repeat(64);
const MANIFEST = {
  apiVersion: 'qinglong.io/v1alpha1',
  kind: 'Package',
  metadata: {
    name: 'example-monitor',
    displayName: 'Example Monitor',
    version: '1.0.0',
    description: 'Secret binding repository fixture',
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
      memory: { recommended: '32Mi' },
      disk: { install: '4Mi', working: '8Mi' },
    },
    permissions: {
      network: { allowedHosts: [] },
      secrets: [{ name: 'TOKEN', required: true }],
      tools: [],
    },
    contents: { tasks: [], workflows: [], prompts: [], tools: [] },
  },
};

function fixture(boundAtMs = 100) {
  const generation = createPluginPackageResourceGeneration({
    installationId: 'install-1',
    projectId: 'project-1',
    packageName: 'example-monitor',
    lockDigest: LOCK_DIGEST,
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: 'b'.repeat(64),
    contents: MANIFEST.spec.contents,
  });
  const binding = createPluginPackageSecretBinding({
    generation,
    manifest: MANIFEST,
    assignments: [
      {
        name: 'TOKEN',
        secretRef: createSecretRef({
          projectId: 'project-1',
          name: 'runtime-token',
          version: 2,
        }),
      },
    ],
    authority: {
      kind: 'local-owner-confirmation',
      evidenceDigest: 'c'.repeat(64),
    },
    boundAtMs,
  });
  return { binding, generation };
}

async function harness(active = true) {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  const { binding, generation } = fixture();
  client
    .prepare(
      `INSERT INTO "QingLong3Projects"
       (id, name, slug, status, version, created_at_ms, updated_at_ms)
       VALUES ('project-1', 'Project 1', 'project-1', 'active', 1, 1, 1)`,
    )
    .run();
  const recordDigest = 'd'.repeat(64);
  const lockJson = JSON.stringify({
    lockDigest: LOCK_DIGEST,
    projectId: 'project-1',
    packageName: 'example-monitor',
    manifestDigest: binding.target.manifestDigest,
  });
  const recordJson = JSON.stringify({
    installationId: 'install-1',
    projectId: 'project-1',
    packageName: 'example-monitor',
    lockDigest: LOCK_DIGEST,
    state: active ? 'active' : 'failed',
    version: 1,
    recordDigest,
  });
  client
    .prepare(
      `INSERT INTO "QingLong3PluginPackageInstalls" (
         installation_id, project_id, package_name, package_version,
         operation, lock_digest, target_generation,
         previous_active_lock_digest, active_lock_digest, state, version,
         last_mutation_id, last_mutation_digest, lock_json, record_json,
         record_digest, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, '1.0.0', 'install', ?, 1, NULL, ?, ?, 1,
                 'mutation-1', ?, ?, ?, ?, 1, 1)`,
    )
    .run(
      'install-1',
      'project-1',
      'example-monitor',
      LOCK_DIGEST,
      active ? LOCK_DIGEST : null,
      active ? 'active' : 'failed',
      'e'.repeat(64),
      lockJson,
      recordJson,
      recordDigest,
    );
  client
    .prepare(
      `INSERT INTO "QingLong3PluginPackageInstallHeads"
       (project_id, package_name, installation_id)
       VALUES ('project-1', 'example-monitor', 'install-1')`,
    )
    .run();
  return {
    client,
    binding,
    generation,
    repository: new LocalSqlitePluginPackageSecretBindingRepository(client),
  };
}

test('publishes and exact-replays one active generation binding', async (t) => {
  const value = await harness();
  t.after(() => value.client.close());
  const created = await value.repository.publish(value.binding);
  assert.equal(created.status, 'created');
  assert.deepEqual(created.binding, value.binding);
  const replay = await value.repository.publish(value.binding);
  assert.equal(replay.status, 'existing');
  assert.deepEqual(
    await value.repository.find(value.generation.generationDigest),
    value.binding,
  );
});

test('rejects inactive targets and conflicting content', async (t) => {
  const inactive = await harness(false);
  t.after(() => inactive.client.close());
  await assert.rejects(
    inactive.repository.publish(inactive.binding),
    PluginPackageSecretBindingConflictError,
  );

  const active = await harness();
  t.after(() => active.client.close());
  await active.repository.publish(active.binding);
  await assert.rejects(
    active.repository.publish(fixture(101).binding),
    PluginPackageSecretBindingConflictError,
  );
});

test('fails closed when durable binding JSON is changed in place', async (t) => {
  const value = await harness();
  t.after(() => value.client.close());
  await value.repository.publish(value.binding);
  value.client.exec('PRAGMA ignore_check_constraints = ON');
  value.client
    .prepare(
      `UPDATE "QingLong3PluginPackageSecretBindings"
       SET binding_json = json_set(binding_json, '$.boundAtMs', 999)
       WHERE generation_digest = ?`,
    )
    .run(value.generation.generationDigest);
  await assert.rejects(
    value.repository.find(value.generation.generationDigest),
    PluginPackageSecretBindingUnavailableError,
  );
});

test('publishes storage only through the explicit subpath', () => {
  assert.equal(
    require('@qinglong/local-sqlite/plugin-package-secret-binding')
      .LocalSqlitePluginPackageSecretBindingRepository,
    LocalSqlitePluginPackageSecretBindingRepository,
  );
  assert.equal(
    require('../dist').LocalSqlitePluginPackageSecretBindingRepository,
    undefined,
  );
});
