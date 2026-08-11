'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const generic = require('../dist/run/clusterRunLostRetry');

test('publishes profile-neutral lost retry names without breaking Cluster consumers', () => {
  assert.equal(
    generic.MAX_RUN_LOST_RETRY_PAGE_SIZE,
    generic.MAX_CLUSTER_RUN_LOST_RETRY_PAGE_SIZE,
  );
  assert.equal(
    generic.buildRunLostRetryTransition,
    generic.buildClusterRunLostRetryTransition,
  );
  assert.equal(
    generic.RunLostRetryCoordinator,
    generic.ClusterRunLostRetryCoordinator,
  );
  assert.equal(
    generic.RunLostRetryUnavailableError,
    generic.ClusterRunLostRetryUnavailableError,
  );
});
