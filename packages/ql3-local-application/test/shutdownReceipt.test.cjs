const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  LocalApplicationShutdownReceiptError,
  buildLocalApplicationShutdownReceipt,
  localApplicationShutdownReceiptPath,
  observeLocalApplicationShutdown,
  parseLocalApplicationShutdownReceipt,
  publishLocalApplicationShutdownReceipt,
} = require('../dist/production-process/shutdownReceipt.js');

function directory(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-stop-receipt-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function receipt(stoppedBootAgeMs = 2_500, processId = 41) {
  return buildLocalApplicationShutdownReceipt({
    instanceId: 'edge-router-1',
    profile: 'edge',
    signal: 'SIGTERM',
    startupReceiptDigest: 'a'.repeat(64),
    observation: {
      bootId: '12345678-1234-4abc-8def-123456789abc',
      stoppedBootAgeMs,
      processId,
      processStartTicks: String(100 + processId),
      nodeExecutable: '/usr/bin/node',
      nodeVersion: 'v24.18.0',
    },
  });
}

test('publishes one bounded graceful shutdown receipt', (t) => {
  const root = directory(t);
  const configFilePath = path.join(root, 'local-application.json');
  const target = publishLocalApplicationShutdownReceipt(
    configFilePath,
    receipt(),
  );
  assert.equal(target, localApplicationShutdownReceiptPath(configFilePath));
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(target).nlink, 1);
  assert.equal(fs.existsSync(`${target}.stage`), false);
  const parsed = parseLocalApplicationShutdownReceipt(
    fs.readFileSync(target, 'utf8'),
  );
  assert.equal(parsed.signal, 'SIGTERM');
  assert.equal(parsed.stopResult, 'stopped');
  assert.equal(parsed.startupReceiptDigest, 'a'.repeat(64));
});

test('atomically replaces the prior process shutdown receipt', (t) => {
  const root = directory(t);
  const configFilePath = path.join(root, 'local-application.json');
  const target = publishLocalApplicationShutdownReceipt(
    configFilePath,
    receipt(),
  );
  const replacement = receipt(3_000, 42);
  assert.equal(
    publishLocalApplicationShutdownReceipt(configFilePath, replacement),
    target,
  );
  assert.deepEqual(
    parseLocalApplicationShutdownReceipt(fs.readFileSync(target, 'utf8')),
    replacement,
  );
});

test('canonicalizes the Linux runtime observation property order', () => {
  const runtimeOrderedObservation = {
    bootId: '12345678-1234-4abc-8def-123456789abc',
    processId: 41,
    processStartTicks: '141',
    nodeExecutable: '/usr/bin/node',
    nodeVersion: 'v24.18.0',
    stoppedBootAgeMs: 2_500,
  };
  const built = buildLocalApplicationShutdownReceipt({
    instanceId: 'edge-router-1',
    profile: 'edge',
    signal: 'SIGTERM',
    startupReceiptDigest: 'a'.repeat(64),
    observation: runtimeOrderedObservation,
  });
  assert.deepEqual(
    parseLocalApplicationShutdownReceipt(JSON.stringify(built)),
    built,
  );
});

test('rejects a forged digest and unsafe deterministic stage', (t) => {
  const root = directory(t);
  const configFilePath = path.join(root, 'local-application.json');
  const valid = receipt();
  assert.throws(
    () =>
      parseLocalApplicationShutdownReceipt(
        JSON.stringify({
          ...valid,
          stoppedBootAgeMs: valid.stoppedBootAgeMs + 1,
        }),
      ),
    /digest is invalid/,
  );
  const target = localApplicationShutdownReceiptPath(configFilePath);
  const outside = path.join(root, 'outside');
  fs.writeFileSync(outside, 'do-not-replace', { mode: 0o600 });
  fs.symlinkSync(outside, `${target}.stage`);
  assert.throws(
    () => publishLocalApplicationShutdownReceipt(configFilePath, valid),
    LocalApplicationShutdownReceiptError,
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'do-not-replace');
  assert.equal(fs.existsSync(target), false);
});

test(
  'observes the still-live Linux process after application shutdown',
  { skip: process.platform !== 'linux' },
  () => {
    const observed = observeLocalApplicationShutdown();
    assert.equal(observed.processId, process.pid);
    assert.match(observed.bootId, /^[0-9a-f-]{36}$/);
    assert.ok(observed.stoppedBootAgeMs >= 0);
  },
);
