require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const {
  InvalidCompletionReceiptError,
  MAX_COMPLETION_RECEIPT_BYTES,
  parseCompletionReceipt,
  serializeCompletionReceipt,
} = require('../../back/runtime/domain/completionReceipt');
const {
  CompletionReceiptAlreadyExistsError,
  CompletionReceiptFileStore,
} = require('../../back/runtime/adapters/fs/completionReceiptFileStore');

const roots = [];
const RUN_ID = '019f7200-0000-7000-8000-000000000001';
const ATTEMPT_ID = '019f7200-0000-7000-8000-000000000002';

function receipt(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    callbackSequence: 1,
    token: 'a'.repeat(43),
    startedAtMs: 1_750_200_000_000,
    finishedAtMs: 1_750_200_000_100,
    exitCode: 0,
    ...overrides,
  };
}

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-receipts-'));
  roots.push(root);
  return { root, store: new CompletionReceiptFileStore(root) };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

test('completion receipt codec round-trips one canonical bounded payload', () => {
  const serialized = serializeCompletionReceipt(receipt());
  assert.ok(Buffer.byteLength(serialized) < MAX_COMPLETION_RECEIPT_BYTES);
  assert.equal(
    serializeCompletionReceipt(parseCompletionReceipt(serialized)),
    serialized,
  );
  assert.deepEqual(parseCompletionReceipt(serialized), receipt());
});

test('completion receipt codec rejects ambiguous and extensible payloads', () => {
  const value = receipt();
  const unknown = JSON.stringify({ ...value, command: 'secret' });
  assert.throws(
    () => parseCompletionReceipt(unknown),
    InvalidCompletionReceiptError,
  );

  const duplicate = serializeCompletionReceipt(value).replace(
    '"attemptId"',
    `"runId":"${RUN_ID}","attemptId"`,
  );
  assert.throws(() => parseCompletionReceipt(duplicate), /duplicate key/);
  assert.throws(
    () => serializeCompletionReceipt(receipt({ finishedAtMs: 1 })),
    /finishedAtMs/,
  );
  assert.throws(
    () => serializeCompletionReceipt(receipt({ exitCode: 256 })),
    /exitCode/,
  );
  assert.throws(
    () => parseCompletionReceipt('x'.repeat(MAX_COMPLETION_RECEIPT_BYTES + 1)),
    /size/,
  );
});

test('file store publishes without overwrite and removes only a known receipt', async () => {
  const { root, store } = await createStore();
  await store.publish(receipt());
  assert.deepEqual(await store.read(ATTEMPT_ID), receipt());
  const target = path.join(root, ATTEMPT_ID.slice(0, 2), `${ATTEMPT_ID}.json`);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);

  await assert.rejects(
    store.publish(receipt({ exitCode: 1 })),
    CompletionReceiptAlreadyExistsError,
  );
  assert.equal((await store.read(ATTEMPT_ID)).exitCode, 0);
  assert.equal(await store.remove(ATTEMPT_ID), true);
  assert.equal(await store.remove(ATTEMPT_ID), false);
  assert.equal(await store.read(ATTEMPT_ID), undefined);
});

test('does not expose a final receipt when storage reports ENOSPC', async () => {
  const { store } = await createStore();
  const originalOpen = fs.open;
  fs.open = async (target, ...args) => {
    if (String(target).endsWith('.tmp')) {
      throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
    }
    return originalOpen(target, ...args);
  };
  try {
    await assert.rejects(store.publish(receipt()), { code: 'ENOSPC' });
    assert.equal(await store.read(ATTEMPT_ID), undefined);
  } finally {
    fs.open = originalOpen;
  }
});

test('file store moves a known receipt to a private quarantine path', async () => {
  const { root, store } = await createStore();
  await store.publish(receipt());

  const quarantineRef = await store.quarantine(ATTEMPT_ID);
  assert.match(quarantineRef, /^\.quarantine\/[0-9a-f]{2}\/019f7200-.+\.json$/);
  assert.equal(await store.read(ATTEMPT_ID), undefined);
  const quarantined = path.join(root, ...quarantineRef.split('/'));
  assert.equal((await fs.stat(quarantined)).mode & 0o777, 0o600);
  assert.equal(await store.quarantine(ATTEMPT_ID), quarantineRef);
  assert.equal(await store.purgeQuarantine(ATTEMPT_ID), true);
  assert.equal(await store.purgeQuarantine(ATTEMPT_ID), false);
});

test('file store rejects traversal, oversized files, symlinks, and path mismatch', async () => {
  const { root, store } = await createStore();
  await assert.rejects(store.read('../../etc/passwd'), /UUIDv7/);

  const directory = path.join(root, ATTEMPT_ID.slice(0, 2));
  const target = path.join(directory, `${ATTEMPT_ID}.json`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(target, 'x'.repeat(MAX_COMPLETION_RECEIPT_BYTES + 1));
  await assert.rejects(store.read(ATTEMPT_ID), /byte limit/);

  await fs.unlink(target);
  const other = receipt({
    attemptId: '019f7200-0000-7000-8000-000000000003',
  });
  await fs.writeFile(target, serializeCompletionReceipt(other));
  await assert.rejects(store.read(ATTEMPT_ID), /do not match/);

  await fs.unlink(target);
  const source = path.join(directory, 'source.json');
  await fs.writeFile(source, serializeCompletionReceipt(receipt()));
  await fs.symlink(source, target);
  await assert.rejects(store.read(ATTEMPT_ID), InvalidCompletionReceiptError);
});
