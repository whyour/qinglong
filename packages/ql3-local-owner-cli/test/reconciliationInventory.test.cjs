const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  classifyLocalReconciliationFact,
} = require('../dist/deployment/reconciliation/planning/inventory.js');

test('classifies known Legacy tables in source and adopted target inventories', () => {
  const knownLegacyTables = new Map([
    ['Crontabs', 'automation'],
    ['CrontabViews', 'automation'],
    ['Subscriptions', 'automation'],
    ['Envs', 'secret_and_config'],
    ['Auths', 'identity_policy_audit'],
    ['Dependences', 'plugin_package'],
    ['Apps', 'plugin_package'],
    ['CrontabStats', 'run_history'],
    ['RunningInstances', 'run_history'],
  ]);
  for (const [tableName, domain] of knownLegacyTables) {
    assert.equal(classifyLocalReconciliationFact('legacy', tableName), domain);
    assert.equal(classifyLocalReconciliationFact('target', tableName), domain);
  }
  assert.equal(
    classifyLocalReconciliationFact('legacy', 'PluginOwnedState'),
    'unknown',
  );
  assert.equal(
    classifyLocalReconciliationFact('target', 'PluginOwnedState'),
    'unknown',
  );
});
