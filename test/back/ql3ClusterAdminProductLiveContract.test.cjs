'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const {
  parseArguments,
} = require('../../scripts/ql3-cluster-admin-product-live-contract.cjs');

const script = path.resolve(
  __dirname,
  '../../scripts/ql3-cluster-admin-product-live-contract.cjs',
);

test('accepts one bounded image reference', () => {
  assert.equal(
    parseArguments(['--image=registry.example.com/qinglong/admin@sha256:abc']),
    'registry.example.com/qinglong/admin@sha256:abc',
  );
});

test('rejects missing, duplicate, unknown, empty or unsafe image arguments', () => {
  for (const argv of [
    [],
    ['--image=one', '--image=two'],
    ['--profile=admin'],
    ['--image='],
    ['--image=admin image'],
    [`--image=${'a'.repeat(257)}`],
  ]) {
    assert.throws(() => parseArguments(argv), /live contract failed/);
  }
});

test('fails closed before Docker without explicit opt-in', () => {
  const result = spawnSync(
    process.execPath,
    [script, '--image=missing:latest'],
    {
      encoding: 'utf8',
      env: { ...process.env, QL3_CLUSTER_ADMIN_PRODUCT_LIVE: '0' },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /QL3_CLUSTER_ADMIN_PRODUCT_LIVE=1 is required/);
  assert.equal(result.stderr.includes('spawn'), false);
});
