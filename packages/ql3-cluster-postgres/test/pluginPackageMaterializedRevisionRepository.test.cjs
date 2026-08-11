const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  registerPluginPackageMaterializedRevisionRepositoryContract,
} = require('../../../test/contracts/pluginPackageMaterializedRevisionRepositoryContract.cjs');
const {
  PluginPackageResourceMaterializationConflictError,
  PluginPackageResourceMaterializationUnavailableError,
} = require('@qinglong/runtime-core/plugin-package-resource-materialization');
const {
  PostgresPluginPackageMaterializedRevisionRepository,
} = require('../dist/plugin-package/installation/pluginPackageMaterializedRevisionRepository');

function fakePool() {
  let row;
  const queries = [];
  return {
    queries,
    pool: {
      async query(text, values = []) {
        queries.push({ text, values });
        if (text.startsWith('INSERT')) {
          if (row) return { rows: [] };
          row = {
            generationDigest: values[0],
            projectId: values[1],
            packageName: values[2],
            generation: values[3],
            lockDigest: values[4],
            manifestDigest: values[5],
            revisionDigest: values[6],
            revisionJson: JSON.parse(values[7]),
            createdAtMs: 300,
          };
          return { rows: [{ generation_digest: values[0] }] };
        }
        if (text.startsWith('SELECT')) {
          return { rows: row ? [{ ...row }] : [] };
        }
        throw new Error(`unexpected SQL: ${text}`);
      },
    },
    corrupt() {
      row.revisionJson.resources[0].value.name = 'Changed';
    },
  };
}

registerPluginPackageMaterializedRevisionRepositoryContract({
  name: 'PostgreSQL Plugin Package materialized revision repository',
  namespace: 'postgres-materialized',
  profile: 'cluster-control',
  async createRepository(_t, fixture) {
    const value = fakePool();
    return {
      repository: new PostgresPluginPackageMaterializedRevisionRepository(
        value.pool,
        fixture.registry,
      ),
    };
  },
});

test('uses database time and fails closed on corrupted JSON', async () => {
  const {
    materializedRevisionFixture,
  } = require('../../../test/contracts/pluginPackageMaterializedRevisionRepositoryContract.cjs');
  const fixture = materializedRevisionFixture(
    'postgres-corrupt',
    'cluster-control',
  );
  const value = fakePool();
  const repository = new PostgresPluginPackageMaterializedRevisionRepository(
    value.pool,
    fixture.registry,
  );
  await repository.publish(fixture.revision);
  assert.match(
    value.queries.find(({ text }) => text.startsWith('INSERT')).text,
    /clock_timestamp\(\)/,
  );
  value.corrupt();
  await assert.rejects(
    repository.find(fixture.revision.generation.generationDigest),
    PluginPackageResourceMaterializationUnavailableError,
  );
});

test('maps PostgreSQL uniqueness rejection to a semantic conflict', async () => {
  const repository =
    new PostgresPluginPackageMaterializedRevisionRepository({
      async query() {
        const error = new Error('duplicate');
        error.code = '23505';
        throw error;
      },
    });
  await assert.rejects(
    repository.find('a'.repeat(64)),
    PluginPackageResourceMaterializationConflictError,
  );
});

test('publishes storage through package-executor and the explicit subpath', () => {
  assert.equal(
    require('@qinglong/cluster-postgres/plugin-package-materialized-revision')
      .PostgresPluginPackageMaterializedRevisionRepository,
    PostgresPluginPackageMaterializedRevisionRepository,
  );
  assert.equal(
    require('../dist/entrypoints/packageExecutor')
      .PostgresPluginPackageMaterializedRevisionRepository,
    PostgresPluginPackageMaterializedRevisionRepository,
  );
});
