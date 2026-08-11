const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createLocalPluginPackageApprovedActionDispatcher,
  LOCAL_PLUGIN_PACKAGE_DISPATCH_BATCH_LIMITS,
} = require('@qinglong/local-admin/package-approved-action');
const {
  LocalSqliteOperationAuthority,
} = require('@qinglong/local-sqlite/operation-authority');

test('composes caller-driven edge and standalone dispatchers behind one SQLite authority', async (t) => {
  const client = new DatabaseSync(':memory:');
  t.after(() => client.close());
  const authority = new LocalSqliteOperationAuthority(client);
  let id = 0;
  const limits = [];
  for (const profile of ['edge', 'standalone']) {
    const dispatcher = createLocalPluginPackageApprovedActionDispatcher({
      authority,
      profile,
      owner: `package_dispatcher_${profile}`,
      clock: () => 100,
      createId: () => `dispatcher-id-${++id}`,
    });
    dispatcher.repository.listDueExecutions = async (query) => {
      limits.push(query.limit);
      return { executions: [], truncated: false };
    };
    assert.deepEqual(await dispatcher.dispatchBatch(), {
      scanned: 0,
      claimed: 0,
      started: 0,
      succeeded: 0,
      failed: 0,
      blocked: 0,
      retrying: 0,
      deferred: 0,
      recoveryRequired: 0,
      alreadyTerminal: 0,
      unavailable: 0,
      truncated: false,
    });
  }
  assert.deepEqual(limits, [
    LOCAL_PLUGIN_PACKAGE_DISPATCH_BATCH_LIMITS.edge,
    LOCAL_PLUGIN_PACKAGE_DISPATCH_BATCH_LIMITS.standalone,
  ]);
  assert.equal(
    require('..').createLocalPluginPackageApprovedActionDispatcher,
    undefined,
  );
});
