require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  localPrimaryResourcePolicy,
  parseDeploymentProfile,
} = require('../../back/runtime/domain/deploymentProfile');

test('uses standalone by default and parses only explicit deployment profiles', () => {
  assert.equal(parseDeploymentProfile(undefined), 'standalone');
  assert.equal(parseDeploymentProfile(''), 'standalone');
  for (const profile of ['edge', 'standalone', 'cluster-control', 'worker']) {
    assert.equal(parseDeploymentProfile(profile), profile);
  }
  for (const profile of ['EDGE', ' edge', 'router', 'cluster']) {
    assert.throws(() => parseDeploymentProfile(profile), TypeError);
  }
});

test('keeps edge scans smaller and slower than standalone scans', () => {
  const edge = localPrimaryResourcePolicy('edge');
  const standalone = localPrimaryResourcePolicy('standalone');

  assert.ok(edge.completion.intervalMs > standalone.completion.intervalMs);
  assert.ok(edge.cancellation.intervalMs > standalone.cancellation.intervalMs);
  assert.ok(edge.timeout.intervalMs > standalone.timeout.intervalMs);
  assert.ok(edge.retry.intervalMs > standalone.retry.intervalMs);
  assert.ok(
    edge.approvedAction.intervalMs > standalone.approvedAction.intervalMs,
  );
  assert.ok(
    edge.artifactRetention.intervalMs > standalone.artifactRetention.intervalMs,
  );
  assert.ok(edge.cancellation.pageSize < standalone.cancellation.pageSize);
  assert.ok(edge.timeout.maxPages < standalone.timeout.maxPages);
  assert.ok(edge.completion.pageSize < standalone.completion.pageSize);
  assert.ok(edge.retry.pageSize < standalone.retry.pageSize);
  assert.ok(
    edge.approvedAction.dispatch.pageSize <
      standalone.approvedAction.dispatch.pageSize,
  );
  assert.ok(
    edge.approvedAction.recovery.maxPages <
      standalone.approvedAction.recovery.maxPages,
  );
  assert.ok(
    edge.artifactRetention.pageSize < standalone.artifactRetention.pageSize,
  );
  assert.ok(
    edge.artifactRetention.maximumDeletions <
      standalone.artifactRetention.maximumDeletions,
  );
  assert.equal(edge.retry.maxPages, 1);
  assert.equal(standalone.retry.maxPages, 1);
  assert.equal(edge.receiptPublishGraceMs, 50);
  assert.equal(standalone.receiptPublishGraceMs, 100);
  assert.equal(edge.receiptTerminalMissingRetentionMs, 120_000);
  assert.equal(standalone.receiptTerminalMissingRetentionMs, 60_000);
  assert.ok(
    edge.receiptQuarantineRetentionMs < standalone.receiptQuarantineRetentionMs,
  );

  edge.completion.pageSize = 64;
  edge.retry.pageSize = 64;
  edge.approvedAction.dispatch.pageSize = 64;
  edge.approvedAction.recovery.pageSize = 64;
  edge.artifactRetention.pageSize = 64;
  assert.notEqual(
    localPrimaryResourcePolicy('edge').completion.pageSize,
    edge.completion.pageSize,
  );
  assert.notEqual(
    localPrimaryResourcePolicy('edge').retry.pageSize,
    edge.retry.pageSize,
  );
  assert.notEqual(
    localPrimaryResourcePolicy('edge').approvedAction.dispatch.pageSize,
    edge.approvedAction.dispatch.pageSize,
  );
  assert.notEqual(
    localPrimaryResourcePolicy('edge').approvedAction.recovery.pageSize,
    edge.approvedAction.recovery.pageSize,
  );
  assert.notEqual(
    localPrimaryResourcePolicy('edge').artifactRetention.pageSize,
    edge.artifactRetention.pageSize,
  );
});

test('refuses unsupported local control-plane topologies', () => {
  assert.throws(
    () => localPrimaryResourcePolicy('cluster-control'),
    /cannot host the local SQLite Primary stack/,
  );
  assert.throws(
    () => localPrimaryResourcePolicy('worker'),
    /cannot host the local SQLite Primary stack/,
  );
});
