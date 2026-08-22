'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  HOST_BOUND_TESTS,
  collectReadonlyOwnerTests,
} = require('../../scripts/ql3-local-owner-readonly-contract.cjs');

const repositoryRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/ql3-ci.yml');

test('classifies only reviewed host-bound Owner tests outside the read-only gate', () => {
  const plan = collectReadonlyOwnerTests(repositoryRoot);
  assert.deepEqual(Object.keys(HOST_BOUND_TESTS).sort(), [
    'packages/ql3-local-owner-cli/test/adoptedDeploymentBundle.test.cjs',
    'packages/ql3-local-owner-cli/test/localDeployment.test.cjs',
    'packages/ql3-local-owner-cli/test/reconciliationCapturePrepare.test.cjs',
    'packages/ql3-local-owner-cli/test/serviceBridgeRoot.test.cjs',
  ]);
  assert.equal(plan.tests.length > 0, true);
  for (const file of plan.tests) {
    assert.equal(fs.existsSync(path.join(repositoryRoot, file)), true);
    assert.equal(file in HOST_BOUND_TESTS, false);
  }
});

test('runs the reviewed Owner contract as root and non-root in read-only containers', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const job = workflow.match(
    /  local-profiles:\n([\s\S]*?)\n  cluster-postgres:/,
  )?.[1];
  assert.ok(job, 'local-profiles job is missing');
  assert.equal(job.match(/docker run --rm --read-only/g)?.length, 2);
  assert.equal(
    job.match(/scripts\/ql3-local-owner-readonly-contract\.cjs/g)?.length,
    2,
  );
  assert.match(job, /--mode=root/);
  assert.match(job, /--user 65532:65532[\s\S]*--mode=nonroot/);
  assert.doesNotMatch(job, /packages\/ql3-local-owner-\*\/test\/\*\.test\.cjs/);
});
