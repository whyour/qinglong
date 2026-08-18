require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  MANUAL_PRIMARY_RUNTIME_RECEIPT_FILE,
  parseManualPrimaryRuntimeReceipt,
} = require('../../back/runtime/domain/manualPrimaryRuntimeReceipt');
const {
  ManualPrimaryRuntimeReceiptConflictError,
  ManualPrimaryRuntimeReceiptStore,
} = require('../../back/runtime/adapters/fs/manualPrimaryRuntimeReceiptStore');

const IDENTITY = {
  platform: 'linux',
  bootId: '11111111-2222-3333-4444-555555555555',
  pid: 321,
  processGroupId: 320,
  startTimeTicks: '123456',
};

function audit() {
  return {
    event: 'runtime.rollout_config_evaluated',
    evaluatedAtMs: 1_000,
    sourcePath: '/data/config/qinglong3-rollout.json',
    sourceSha256: 'a'.repeat(64),
    revision: 'manual-primary-edge-live-1',
    status: 'accepted',
  };
}

function fixture(t, inspection = 'exited') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-runtime-receipt-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 10_000;
  const options = {
    clock: { now: () => now++ },
    platform: 'linux',
    pid: IDENTITY.pid,
    randomId: () => '1'.repeat(32),
    identityProvider: {
      async capture() {
        return IDENTITY;
      },
      async inspect() {
        return { status: inspection };
      },
    },
  };
  return {
    root,
    store: new ManualPrimaryRuntimeReceiptStore(root, 'edge', options),
    options,
  };
}

test('publishes one private current receipt and transitions it around shutdown', async (t) => {
  const { root, store } = fixture(t);
  const target = path.join(root, MANUAL_PRIMARY_RUNTIME_RECEIPT_FILE);

  await store.activated(audit());
  let receipt = parseManualPrimaryRuntimeReceipt(
    JSON.parse(fs.readFileSync(target, 'utf8')),
  );
  assert.equal(receipt.state, 'active');
  assert.equal(receipt.process.kind, 'linux-proc');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);

  await store.stopping();
  receipt = parseManualPrimaryRuntimeReceipt(
    JSON.parse(fs.readFileSync(target, 'utf8')),
  );
  assert.equal(receipt.state, 'stopping');

  await store.stopped();
  receipt = parseManualPrimaryRuntimeReceipt(
    JSON.parse(fs.readFileSync(target, 'utf8')),
  );
  assert.equal(receipt.state, 'stopped');
  assert.equal(receipt.activationId, '1'.repeat(32));
});

test('refuses to replace a receipt whose exact Linux process is still live', async (t) => {
  const first = fixture(t);
  await first.store.activated(audit());
  const second = new ManualPrimaryRuntimeReceiptStore(first.root, 'edge', {
    ...first.options,
    randomId: () => '2'.repeat(32),
    identityProvider: {
      ...first.options.identityProvider,
      async inspect() {
        return { status: 'running' };
      },
    },
  });
  await assert.rejects(
    second.activated(audit()),
    ManualPrimaryRuntimeReceiptConflictError,
  );
});

test('replaces a stale process generation and rejects receipt tampering', async (t) => {
  const first = fixture(t);
  await first.store.activated(audit());
  const second = new ManualPrimaryRuntimeReceiptStore(first.root, 'edge', {
    ...first.options,
    randomId: () => '2'.repeat(32),
  });
  await second.activated(audit());
  const target = path.join(first.root, MANUAL_PRIMARY_RUNTIME_RECEIPT_FILE);
  const receipt = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(receipt.activationId, '2'.repeat(32));
  receipt.state = 'stopped';
  assert.throws(
    () => parseManualPrimaryRuntimeReceipt(receipt),
    /digest is invalid/,
  );
});

test('portable receipts remain observable but cannot claim Linux liveness', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-runtime-receipt-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ManualPrimaryRuntimeReceiptStore(root, 'standalone', {
    clock: { now: () => 20_000 },
    platform: 'darwin',
    pid: 432,
    randomId: () => '3'.repeat(32),
    identityProvider: {
      async capture() {
        return null;
      },
      async inspect() {
        return { status: 'unsupported' };
      },
    },
  });
  await store.activated(audit());
  const receipt = parseManualPrimaryRuntimeReceipt(
    JSON.parse(
      fs.readFileSync(
        path.join(root, MANUAL_PRIMARY_RUNTIME_RECEIPT_FILE),
        'utf8',
      ),
    ),
  );
  assert.deepEqual(receipt.process, {
    kind: 'portable',
    platform: 'darwin',
    pid: 432,
  });
});
