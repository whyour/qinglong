const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterPluginPackageExecutorProcessConfigError,
  loadClusterPluginPackageExecutorProcessConfig,
  runClusterPluginPackageExecutorProcess,
} = require('@qinglong/cluster-admin/plugin-package-executor-process');

function environment(overrides = {}) {
  return {
    QL3_PLUGIN_PACKAGE_EXECUTOR_ENABLED: 'true',
    QL3_PLUGIN_PACKAGE_EXECUTOR_OWNER: 'cluster_package_executor_1',
    QL3_PLUGIN_PACKAGE_EXECUTOR_APPROVAL_BATCH_SIZE: '4',
    QL3_PLUGIN_PACKAGE_EXECUTOR_DISPATCH_BATCH_SIZE: '4',
    QL3_PLUGIN_PACKAGE_EXECUTOR_MAX_BATCHES: '2',
    QL3_PLUGIN_PACKAGE_EXECUTOR_LEASE_DURATION_MS: '600000',
    QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_PAGE_SIZE: '8',
    QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_MAX_PAGES: '4',
    QL3_PLUGIN_PACKAGE_EXECUTOR_SECRET_ROOT:
      '/var/run/secrets/qinglong3/plugin-package-values',
    QL3_POSTGRES_PACKAGE_EXECUTOR_URL:
      'postgresql://ql3_package_executor:secret@postgres/qinglong',
    QL3_POSTGRES_TLS_MODE: 'disable',
    QL3_POSTGRES_ALLOW_INSECURE: 'true',
    ...overrides,
  };
}

test('disabled executor opens no PostgreSQL authority', async () => {
  let opened = 0;
  const result = await runClusterPluginPackageExecutorProcess({
    environment: { QL3_PLUGIN_PACKAGE_EXECUTOR_ENABLED: 'false' },
    async openDatabase() {
      opened += 1;
      throw new Error('must not open');
    },
  });
  assert.deepEqual(result, { status: 'disabled' });
  assert.equal(opened, 0);
});

test('loads bounded low-footprint Package-executor configuration', () => {
  const config = loadClusterPluginPackageExecutorProcessConfig(environment());
  assert.equal(config.enabled, true);
  assert.equal(config.owner, 'cluster_package_executor_1');
  assert.equal(config.approvalBatchSize, 4);
  assert.equal(config.dispatchBatchSize, 4);
  assert.equal(config.maxBatches, 2);
  assert.equal(config.revocationPageSize, 8);
  assert.equal(config.revocationMaxPages, 4);
  assert.equal(
    config.secretProjectionRoot,
    '/var/run/secrets/qinglong3/plugin-package-values',
  );
  assert.equal(config.database.pool.maxConnections, 2);
  assert.equal(config.database.connection.tls.mode, 'disable');
});

test('rejects implicit insecure PostgreSQL and unbounded work', () => {
  for (const invalid of [
    environment({ QL3_POSTGRES_ALLOW_INSECURE: undefined }),
    environment({ QL3_PLUGIN_PACKAGE_EXECUTOR_MAX_BATCHES: '65' }),
    environment({ QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_PAGE_SIZE: '129' }),
    environment({ QL3_PLUGIN_PACKAGE_EXECUTOR_OWNER: 'not safe' }),
    environment({ QL3_PLUGIN_PACKAGE_EXECUTOR_SECRET_ROOT: 'relative/path' }),
  ]) {
    assert.throws(
      () => loadClusterPluginPackageExecutorProcessConfig(invalid),
      ClusterPluginPackageExecutorProcessConfigError,
    );
  }
});

test('keeps executor authority off the cluster-admin root', () => {
  const root = require('@qinglong/cluster-admin');
  const manifest = require('../package.json');
  assert.equal(root.runClusterPluginPackageExecutorProcess, undefined);
  assert.equal(
    manifest.bin['ql3-plugin-package-execute'],
    'dist/plugin-package/executor/pluginPackageExecutorCli.js',
  );
});
