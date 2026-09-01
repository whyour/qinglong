const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  classifyLocalReconciliationFact,
} = require('../dist/deployment/reconciliation/planning/inventory.js');

test('classifies Legacy runtime instances as preserved run history', () => {
  assert.equal(
    classifyLocalReconciliationFact('legacy', 'RunningInstances'),
    'run_history',
  );
  assert.equal(
    classifyLocalReconciliationFact('legacy', 'PluginOwnedState'),
    'unknown',
  );
});
