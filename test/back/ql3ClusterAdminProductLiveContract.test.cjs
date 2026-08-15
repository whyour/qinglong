'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
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

test('binds the live image gate to native and container-published loopback', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /function runConsoleContract\(image\)/);
  assert.match(source, /\[facade, 'copilot-console'/);
  assert.match(source, /body\.includes\('Cluster field ledger'\)/);
  assert.match(source, /runConsoleContract\(image\);/);
  assert.match(source, /consoleLoopback: true/);
  assert.match(source, /consoleAssets: true/);
  assert.match(source, /consoleEvidenceBundle: true/);
  assert.match(source, /createClusterConsoleEvidenceBundle/);
  assert.match(source, /function runPublishedConsoleContract\(image\)/);
  assert.match(
    source,
    /127\.0\.0\.1:\$\{containerPort\}:\$\{containerPort\}\/tcp/,
  );
  assert.match(source, /runPublishedConsoleContract\(image\);/);
  assert.match(source, /consolePublishedHostAddress: '127\.0\.0\.1'/);
  assert.match(source, /consoleDistributionEmbedded: true/);
});
