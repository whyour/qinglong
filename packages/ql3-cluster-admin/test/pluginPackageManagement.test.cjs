const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CLUSTER_PLUGIN_PACKAGE_MANAGEMENT_DECISION_MODE,
  createClusterPluginPackageManagementService,
} = require('@qinglong/cluster-admin/plugin-package-management');

test('composes cluster Package management as short-lived separation-of-duty authority', () => {
  const pool = {
    async query() {
      throw new Error('construction must not touch PostgreSQL');
    },
    async connect() {
      throw new Error('construction must not open PostgreSQL');
    },
  };
  const service = createClusterPluginPackageManagementService({
    pool,
    now: () => 100,
  });
  assert.equal(
    CLUSTER_PLUGIN_PACKAGE_MANAGEMENT_DECISION_MODE,
    'separation_of_duty',
  );
  assert.equal(typeof service.propose, 'function');
  assert.equal(typeof service.decide, 'function');
  assert.equal(typeof service.inspect, 'function');
  assert.equal(typeof service.inspectAuthorized, 'function');
  assert.equal(typeof service.inspectInstallationAuthorized, 'function');
  assert.equal(typeof service.listInstallationsAuthorized, 'function');
  assert.deepEqual(Object.keys(service).sort(), [
    'decide',
    'inspect',
    'inspectAuthorized',
    'inspectInstallationAuthorized',
    'listInstallationsAuthorized',
    'propose',
  ]);
  assert.equal(
    require('@qinglong/cluster-admin')
      .createClusterPluginPackageManagementService,
    undefined,
  );
});
