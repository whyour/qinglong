'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'scripts/ql3-local-console-image-inventory.cjs');
const packages = [
  '@qinglong/local-admin',
  '@qinglong/local-api',
  '@qinglong/local-application',
  '@qinglong/local-command-file',
  '@qinglong/local-execution',
  '@qinglong/local-owner-console',
  '@qinglong/local-process',
  '@qinglong/local-secret',
  '@qinglong/local-sqlite',
  '@qinglong/runtime-core',
  'croner',
  'semver',
];

function inventoryFixture(t) {
  const inventoryRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-console-inventory-')),
  );
  t.after(() => fs.rmSync(inventoryRoot, { recursive: true, force: true }));
  for (const packageName of packages) {
    const packageRoot = path.join(inventoryRoot, packageName);
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify({
        name: packageName,
        version: '3.0.0-alpha.1',
      })}\n`,
    );
  }
  return inventoryRoot;
}

function runInventory(inventoryRoot) {
  return spawnSync(
    process.execPath,
    [script, `--inventory-root=${inventoryRoot}`],
    { encoding: 'utf8' },
  );
}

test('accepts the exact bounded Local Console package closure', (t) => {
  const inventoryRoot = inventoryFixture(t);
  const run = runInventory(inventoryRoot);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.image, 'local-console');
  assert.equal(report.packageCount, 12);
  assert.equal(report.ai, 'excluded');
  assert.equal(report.listener, 'loopback-only');
  assert.equal(report.maxFiles, 768);
  assert.equal(report.maxBytes, 20 * 1024 * 1024);
  assert.equal(report.compatible, true);
});

test('rejects one unreviewed runtime package', (t) => {
  const inventoryRoot = inventoryFixture(t);
  const extra = path.join(inventoryRoot, 'unreviewed');
  fs.mkdirSync(extra);
  fs.writeFileSync(
    path.join(extra, 'package.json'),
    '{"name":"unreviewed","version":"1.0.0"}\n',
  );
  const run = runInventory(inventoryRoot);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /package closure drifted/);
});
