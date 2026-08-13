const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CLUSTER_PLUGIN_PACKAGE_DISPATCH_BATCH_LIMIT,
  createClusterPluginPackageApprovedActionDispatcher,
} = require('@qinglong/cluster-admin/plugin-package-approved-action');

test('composes one bounded caller-driven cluster Package dispatcher', async () => {
  const pool = {
    async query() {
      throw new Error('construction must not touch PostgreSQL');
    },
    async connect() {
      throw new Error('construction must not open PostgreSQL');
    },
  };
  const dispatcher = createClusterPluginPackageApprovedActionDispatcher({
    pool,
    owner: 'cluster_package_dispatcher_1',
    clock: () => 100,
    createId: () => 'dispatcher-id-1',
    secretExistenceInspector: {
      async assertExists() {},
    },
  });
  let observedLimit = null;
  dispatcher.repository.listDueExecutions = async (query) => {
    observedLimit = query.limit;
    return { executions: [], truncated: false };
  };
  const summary = await dispatcher.dispatchBatch();
  assert.equal(summary.scanned, 0);
  assert.equal(summary.truncated, false);
  assert.equal(observedLimit, CLUSTER_PLUGIN_PACKAGE_DISPATCH_BATCH_LIMIT);
  assert.equal(
    require('@qinglong/cluster-admin')
      .createClusterPluginPackageApprovedActionDispatcher,
    undefined,
  );
});
