const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterApprovalDecisionManagementConfigurationError,
  createClusterApprovalDecisionManagementService,
} = require('@qinglong/cluster-admin/approval-decision-management');

test('composes the shared Approval decision authority over a caller-owned pool', () => {
  const pool = {
    async query() {
      throw new Error('not used');
    },
    async connect() {
      throw new Error('not used');
    },
  };
  const service = createClusterApprovalDecisionManagementService({ pool });
  assert.equal(typeof service.decide, 'function');
  assert.equal(Object.isFrozen(service), true);
});

test('rejects missing pool authority and widened options', () => {
  for (const options of [
    {},
    { pool: { query() {} } },
    { pool: { query() {}, connect() {} }, transport: {} },
  ]) {
    assert.throws(
      () => createClusterApprovalDecisionManagementService(options),
      ClusterApprovalDecisionManagementConfigurationError,
    );
  }
});
