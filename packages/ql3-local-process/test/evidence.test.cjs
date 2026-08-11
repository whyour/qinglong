const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  CompletionReceiptAlreadyExistsError,
  CompletionReceiptFileStore,
  InvalidCompletionReceiptError,
  LocalProcessPersistedExecutionInspector,
  createLocalProcessDurableHandle,
  parseLocalProcessDurableHandle,
} = require('../dist');

const RUN_ID = '019f70c0-0000-7000-8000-000000000001';
const ATTEMPT_ID = '019f70c0-0000-7000-8000-000000000002';

function receipt() {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    callbackSequence: 1,
    token: 'A'.repeat(32),
    startedAtMs: 1,
    finishedAtMs: 2,
    exitCode: 0,
  };
}

test('publishes one immutable bounded receipt and never overwrites it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-run-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new CompletionReceiptFileStore(root);

  await store.publish(receipt());
  assert.deepEqual(await store.read(ATTEMPT_ID), receipt());
  await assert.rejects(
    store.publish(receipt()),
    CompletionReceiptAlreadyExistsError,
  );
  assert.equal(await store.remove(ATTEMPT_ID), true);
  assert.equal(await store.read(ATTEMPT_ID), undefined);
});

test('publishes a Workflow portable receipt identity without widening paths', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-run-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new CompletionReceiptFileStore(root);
  const workflowReceipt = {
    ...receipt(),
    runId: 'workflow-run-1',
    attemptId: 'wta:0123456789abcdef0123456789abcdef',
  };

  await store.publish(workflowReceipt);
  assert.deepEqual(
    await store.read(workflowReceipt.attemptId),
    workflowReceipt,
  );
  for (const attemptId of [
    '../attempt-1',
    'attempt/1',
    'attempt\\1',
    `attempt-${'a'.repeat(36)}`,
  ]) {
    await assert.rejects(store.read(attemptId), InvalidCompletionReceiptError);
  }
});

test('rejects a filesystem root as a receipt authority', () => {
  assert.throws(
    () => new CompletionReceiptFileStore(path.parse(process.cwd()).root),
    /bounded non-root absolute path/,
  );
});

test('refuses a symbolic-link receipt without following it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-run-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, ATTEMPT_ID.slice(0, 2));
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(root, 'untrusted.json');
  fs.writeFileSync(source, JSON.stringify(receipt()));
  fs.symlinkSync(source, path.join(directory, `${ATTEMPT_ID}.json`));

  await assert.rejects(
    new CompletionReceiptFileStore(root).read(ATTEMPT_ID),
    InvalidCompletionReceiptError,
  );
});

test('durable process handles are exact and evidence preserves the bound PID', async () => {
  const identity = {
    platform: 'linux',
    bootId: 'boot-1',
    pid: 123,
    processGroupId: 123,
    startTimeTicks: '456',
  };
  const handle = createLocalProcessDurableHandle('handle-1', identity);
  assert.deepEqual(parseLocalProcessDurableHandle(handle), {
    handleId: 'handle-1',
    identity,
  });
  assert.equal(parseLocalProcessDurableHandle('invalid'), null);

  const inspector = new LocalProcessPersistedExecutionInspector({
    inspect: async (value) => {
      assert.deepEqual(value, identity);
      return { status: 'running', identityPid: value.pid };
    },
  });
  assert.deepEqual(await inspector.inspect(handle), {
    status: 'running',
    identityPid: 123,
  });
});
