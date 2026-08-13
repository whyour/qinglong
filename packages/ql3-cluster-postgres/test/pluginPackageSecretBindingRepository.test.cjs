const assert = require('node:assert/strict');
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
  PostgresPluginPackageSecretBindingRepository,
} = require('../dist/plugin-package/installation/pluginPackageSecretBindingRepository');

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
      deploymentProfiles: ['cluster-control'],
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
    lockDigest: 'a'.repeat(64),
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: 'b'.repeat(64),
    contents: MANIFEST.spec.contents,
  });
  return createPluginPackageSecretBinding({
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
      kind: 'approved-action-execution',
      evidenceDigest: 'c'.repeat(64),
    },
    boundAtMs,
  });
}

function fakePool(active = true) {
  let row;
  const queries = [];
  return {
    queries,
    pool: {
      async query(text, values = []) {
        queries.push({ text, values });
        if (text.startsWith('SELECT')) return { rows: row ? [{ ...row }] : [] };
        if (text.startsWith('INSERT')) {
          if (!active || row) return { rows: [] };
          const binding = JSON.parse(values[11]);
          row = {
            generationDigest: values[0],
            projectId: values[1],
            packageName: values[2],
            installationId: values[3],
            lockDigest: values[4],
            generation: values[5],
            manifestDigest: values[6],
            authorityKind: values[7],
            evidenceDigest: values[8],
            boundAtMs: values[9],
            bindingDigest: values[10],
            bindingJson: binding,
          };
          return { rows: [{ generation_digest: values[0] }] };
        }
        throw new Error(`unexpected SQL: ${text}`);
      },
    },
    corrupt() {
      row.bindingJson.boundAtMs = 999;
    },
  };
}

test('publishes, exact-replays and finds one binding', async () => {
  const value = fakePool();
  const repository = new PostgresPluginPackageSecretBindingRepository(
    value.pool,
  );
  const binding = fixture();
  assert.equal((await repository.publish(binding)).status, 'created');
  assert.equal((await repository.publish(binding)).status, 'existing');
  assert.deepEqual(
    await repository.find(binding.target.generationDigest),
    binding,
  );
  assert.match(
    value.queries.find(({ text }) => text.startsWith('INSERT')).text,
    /install\.state = 'active'/,
  );
  assert.match(
    value.queries.find(({ text }) => text.startsWith('INSERT')).text,
    /install\.state = 'staged'/,
  );
  assert.match(
    value.queries.find(({ text }) => text.startsWith('INSERT')).text,
    /MAX\(history\.target_generation\)/,
  );
});

test('rejects inactive targets and conflicting content', async () => {
  const inactive = fakePool(false);
  await assert.rejects(
    new PostgresPluginPackageSecretBindingRepository(inactive.pool).publish(
      fixture(),
    ),
    PluginPackageSecretBindingConflictError,
  );
  const active = fakePool();
  const repository = new PostgresPluginPackageSecretBindingRepository(
    active.pool,
  );
  await repository.publish(fixture());
  await assert.rejects(
    repository.publish(fixture(101)),
    PluginPackageSecretBindingConflictError,
  );
});

test('fails closed on corrupted JSON and maps PostgreSQL constraints', async () => {
  const value = fakePool();
  const repository = new PostgresPluginPackageSecretBindingRepository(
    value.pool,
  );
  const binding = fixture();
  await repository.publish(binding);
  value.corrupt();
  await assert.rejects(
    repository.find(binding.target.generationDigest),
    PluginPackageSecretBindingUnavailableError,
  );
  const failing = new PostgresPluginPackageSecretBindingRepository({
    async query() {
      const error = new Error('duplicate');
      error.code = '23505';
      throw error;
    },
  });
  await assert.rejects(
    failing.find('a'.repeat(64)),
    PluginPackageSecretBindingConflictError,
  );
});

test('publishes storage through package-executor and explicit subpath', () => {
  assert.equal(
    require('@qinglong/cluster-postgres/plugin-package-secret-binding')
      .PostgresPluginPackageSecretBindingRepository,
    PostgresPluginPackageSecretBindingRepository,
  );
  assert.equal(
    require('../dist/entrypoints/packageExecutor')
      .PostgresPluginPackageSecretBindingRepository,
    PostgresPluginPackageSecretBindingRepository,
  );
});

test('casts reused INSERT parameters to their durable PostgreSQL column types', async () => {
  let statement = '';
  const repository = new PostgresPluginPackageSecretBindingRepository({
    async query(text) {
      if (text.includes('INSERT INTO')) {
        statement = text;
        return { rows: [{ generation_digest: 'a'.repeat(64) }], rowCount: 1 };
      }
      return { rows: [] };
    },
  });
  await assert.rejects(repository.publish(fixture()));
  assert.match(statement, /\$2::varchar\(128\)/);
  assert.match(statement, /\$3::varchar\(63\)/);
  assert.match(statement, /\$6::integer/);
  assert.match(statement, /\$10::bigint/);
});
