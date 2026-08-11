const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  LocalApplicationStartupReceiptError,
  buildLocalApplicationStartupReceipt,
  localApplicationStartupReceiptPath,
  observeLocalApplicationStartup,
  parseLinuxProcessStartTicks,
  parseLocalApplicationStartupReceipt,
  publishLocalApplicationStartupReceipt,
} = require('../dist/production-process/startupReceipt.js');

function directory(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-startup-receipt-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function receipt(activeBootAgeMs = 1_250, processId = 41) {
  return buildLocalApplicationStartupReceipt({
    instanceId: 'edge-router-1',
    profile: 'edge',
    aiStatus: 'deployment_excluded',
    observation: {
      bootId: '12345678-1234-4abc-8def-123456789abc',
      activeBootAgeMs,
      processId,
      processStartTicks: String(100 + processId),
      nodeExecutable: '/usr/bin/node',
      nodeVersion: 'v24.18.0',
    },
  });
}

test('parses Linux stat after the final command delimiter', () => {
  const fields = [
    'S',
    ...Array.from({ length: 18 }, (_, index) => String(index + 1)),
    '987654',
    '21',
  ];
  assert.equal(
    parseLinuxProcessStartTicks(`41 (node worker) name) ${fields.join(' ')}`),
    '987654',
  );
  assert.throws(
    () => parseLinuxProcessStartTicks('41 invalid'),
    LocalApplicationStartupReceiptError,
  );
});

test('publishes one bounded current receipt with atomic replacement', (t) => {
  const root = directory(t);
  const configFilePath = path.join(root, 'local-application.json');
  const first = receipt();
  const target = publishLocalApplicationStartupReceipt(configFilePath, first);
  assert.equal(target, localApplicationStartupReceiptPath(configFilePath));
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${target}.stage`), false);
  assert.deepEqual(
    parseLocalApplicationStartupReceipt(fs.readFileSync(target, 'utf8')),
    first,
  );

  const second = receipt(1_500, 42);
  assert.equal(
    publishLocalApplicationStartupReceipt(configFilePath, second),
    target,
  );
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(target).nlink, 1);
  assert.deepEqual(
    parseLocalApplicationStartupReceipt(fs.readFileSync(target, 'utf8')),
    second,
  );
});

test('rejects a forged digest and an unsafe deterministic stage', (t) => {
  const root = directory(t);
  const configFilePath = path.join(root, 'local-application.json');
  const target = localApplicationStartupReceiptPath(configFilePath);
  const valid = receipt();
  const forged = { ...valid, activeBootAgeMs: valid.activeBootAgeMs + 1 };
  assert.throws(
    () => parseLocalApplicationStartupReceipt(JSON.stringify(forged)),
    /digest is invalid/,
  );

  const outside = path.join(root, 'outside');
  fs.writeFileSync(outside, 'do-not-replace', { mode: 0o600 });
  fs.symlinkSync(outside, `${target}.stage`);
  assert.throws(
    () => publishLocalApplicationStartupReceipt(configFilePath, valid),
    /existing receipt stage is not a private regular file/,
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'do-not-replace');
  assert.equal(fs.existsSync(target), false);
});

test(
  'observes the live Linux boot and direct Node process when available',
  { skip: process.platform !== 'linux' },
  () => {
    const observed = observeLocalApplicationStartup();
    assert.equal(observed.processId, process.pid);
    assert.match(observed.bootId, /^[0-9a-f-]{36}$/);
    assert.match(observed.processStartTicks, /^[1-9][0-9]+$/);
    assert.equal(path.isAbsolute(observed.nodeExecutable), true);
    assert.equal(observed.nodeVersion, process.version);
  },
);
