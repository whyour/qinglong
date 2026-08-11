'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { CompletionReceiptFileStore } = require('@qinglong/local-process');
const {
  WorkerFileLogArtifactAllocator,
  workerRemoteLogArtifactPolicy,
} = require('../dist/execution/workerFileLogArtifactAllocator');
const {
  WorkerPosixExecutionExecutor,
} = require('../dist/execution/workerPosixExecutionExecutor');

const RUN_ID = '019f70e0-0000-7000-8000-000000000101';
const ATTEMPT_ID = '019f70e0-0000-7000-8000-000000000102';
const TOKEN = Buffer.alloc(32, 0x5a);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-worker-posix-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    artifactRoot: path.join(root, 'artifacts'),
    receiptRoot: path.join(root, 'receipts'),
  };
}

function identityProvider() {
  return {
    async capture(pid) {
      return {
        platform: 'linux',
        bootId: '11111111-2222-3333-4444-555555555555',
        pid,
        processGroupId: pid,
        startTimeTicks: '1',
      };
    },
    async inspect(identity) {
      return { status: 'running', identityPid: identity.pid };
    },
  };
}

async function preparedOutput(artifactRoot, offerId = 'offer-posix-1') {
  const allocator = new WorkerFileLogArtifactAllocator({
    root: artifactRoot,
    policy: workerRemoteLogArtifactPolicy('edge'),
    capacity: { async availableBytes() { return 1024n ** 4n; } },
  });
  const prepared = await allocator.prepare({
    projectId: 'project-1',
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    offerId,
  });
  return { prepared, output: prepared.takeOutput() };
}

function launch(prepared, output, overrides = {}) {
  return {
    offerId: 'offer-posix-1',
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    executorStartedAtMs: 100,
    command: {
      kind: 'argv',
      file: process.execPath,
      args: [
        '-e',
        "process.stdout.write(process.env.QL3_RECEIPT_CALLBACK_TOKEN ? 'leaked' : 'worker-output')",
      ],
    },
    environment: [],
    logArtifactId: prepared.logArtifactId,
    output,
    completionCallback: { sequence: 1, token: Buffer.from(TOKEN) },
    ...overrides,
  };
}

async function waitForReceipt(root) {
  const store = new CompletionReceiptFileStore(root);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipt = await store.read(ATTEMPT_ID);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Worker completion receipt was not published');
}

test('verifies the Worker barrier, launches through the reviewed fd and writes a receipt', async (t) => {
  const roots = await fixture(t);
  const { prepared, output } = await preparedOutput(roots.artifactRoot);
  let barrier;
  const executor = new WorkerPosixExecutionExecutor({
    barrier: { async verify(input) { barrier = input; } },
    receiptRoot: roots.receiptRoot,
    identityProvider: identityProvider(),
    clock: { now: () => 100 },
    createHandleId: () => 'worker-handle-1',
  });
  const result = await executor.start(launch(prepared, output));
  assert.equal(result.status, 'started');
  assert.match(result.executorHandle, /^ql3lp1\./);
  assert.equal(barrier.logArtifactId, prepared.logArtifactId);
  assert.equal(barrier.executorStartedAtMs, 100);
  assert.match(barrier.callbackTokenDigest, /^[a-f0-9]{64}$/);
  const receipt = await waitForReceipt(roots.receiptRoot);
  assert.equal(receipt.runId, RUN_ID);
  assert.equal(receipt.attemptId, ATTEMPT_ID);
  assert.equal(receipt.callbackSequence, 1);
  assert.equal(receipt.token, TOKEN.toString('base64url'));
  assert.equal(receipt.exitCode, 0);
  const outputPath = path.join(
    roots.artifactRoot,
    prepared.logArtifactId.slice(5, 7),
    `${prepared.logArtifactId}.log`,
  );
  assert.equal(await fs.readFile(outputPath, 'utf8'), 'worker-output');
});

test('does not spawn when the durable Worker barrier rejects authority', async (t) => {
  const roots = await fixture(t);
  const marker = path.join(roots.root, 'spawned');
  const { prepared, output } = await preparedOutput(roots.artifactRoot);
  const executor = new WorkerPosixExecutionExecutor({
    barrier: { async verify() { throw new Error('stale inbox'); } },
    receiptRoot: roots.receiptRoot,
    identityProvider: identityProvider(),
  });
  const result = await executor.start(launch(prepared, output, {
    command: { kind: 'argv', file: '/usr/bin/touch', args: [marker] },
  }));
  assert.deepEqual(result, { status: 'rejected' });
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('rejects timeout without durable control-plane deadline before spawn', async (t) => {
  const roots = await fixture(t);
  const { prepared, output } = await preparedOutput(roots.artifactRoot);
  let barriers = 0;
  const executor = new WorkerPosixExecutionExecutor({
    barrier: { async verify() { barriers += 1; } },
    receiptRoot: roots.receiptRoot,
    identityProvider: identityProvider(),
  });
  const result = await executor.start(launch(prepared, output, {
    timeoutMs: 1_000,
  }));
  assert.deepEqual(result, { status: 'rejected' });
  assert.equal(barriers, 0);
});

test('accepts timeout only when starting ACK supplied a durable deadline', async (t) => {
  const roots = await fixture(t);
  const { prepared, output } = await preparedOutput(roots.artifactRoot);
  let barriers = 0;
  const executor = new WorkerPosixExecutionExecutor({
    barrier: { async verify() { barriers += 1; } },
    receiptRoot: roots.receiptRoot,
    identityProvider: identityProvider(),
  });
  const result = await executor.start(launch(prepared, output, {
    timeoutMs: 1_000,
    executionDeadlineAtMs: 2_000,
  }));
  assert.equal(result.status, 'started');
  assert.equal(barriers, 1);
});

test('propagates unknown outcome when durable identity capture fails after spawn', async (t) => {
  const roots = await fixture(t);
  const { prepared, output } = await preparedOutput(roots.artifactRoot);
  const executor = new WorkerPosixExecutionExecutor({
    barrier: { async verify() {} },
    receiptRoot: roots.receiptRoot,
    identityProvider: {
      async capture() { throw new Error('procfs unavailable'); },
      async inspect() { return { status: 'unknown' }; },
    },
  });
  await assert.rejects(
    executor.start(launch(prepared, output, {
      command: { kind: 'shell', command: 'sleep 5', shell: '/bin/sh' },
    })),
    (error) => error?.spawnOutcome === 'unknown',
  );
});
