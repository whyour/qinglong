const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { CompletionReceiptFileStore } = require('../dist');
const { LocalProcessLaunchError, LocalProcessLauncher } = require('../dist');

const RUN_ID = '019f70e0-0000-7000-8000-000000000001';
const ATTEMPT_ID = '019f70e0-0000-7000-8000-000000000002';
const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef';

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-process-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    receiptRoot: path.join(directory, 'receipts'),
  };
}

function identityProvider(onCapture = () => undefined) {
  return {
    async capture(pid) {
      onCapture(pid);
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

async function waitForReceipt(store) {
  for (let index = 0; index < 100; index += 1) {
    const receipt = await store.read(ATTEMPT_ID);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('receipt was not published');
}

test('persists the journal barrier before spawn and publishes a trusted receipt', async (t) => {
  const { receiptRoot } = fixture(t);
  let registered = false;
  const journal = {
    async register(command) {
      assert.deepEqual(command, {
        runId: RUN_ID,
        attemptId: ATTEMPT_ID,
        registeredAtMs: 100,
      });
      registered = true;
    },
  };
  const launcher = new LocalProcessLauncher(journal, {
    receiptRoot,
    clock: { now: () => 100 },
    createHandleId: () => 'handle-1',
    identityProvider: identityProvider(() => assert.equal(registered, true)),
  });
  const handle = await launcher.start({
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    callbackSequence: 1,
    callbackToken: TOKEN,
    command: {
      kind: 'shell',
      command:
        'test -z "${QL3_RECEIPT_CALLBACK_TOKEN-}" && test -z "${QL3_RECEIPT_TARGET-}"',
    },
    environment: { USER_VALUE: 'present' },
  });
  assert.equal(handle.startedAtMs, 100);
  assert.equal(handle.pid > 0, true);
  assert.match(handle.durableHandle, /^ql3lp1\./);
  assert.deepEqual(await handle.completion, { exitCode: 0, signal: null });
  const receipt = await waitForReceipt(
    new CompletionReceiptFileStore(receiptRoot),
  );
  assert.deepEqual(
    { ...receipt, finishedAtMs: 100 },
    {
      schemaVersion: 1,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      callbackSequence: 1,
      token: TOKEN,
      startedAtMs: 100,
      finishedAtMs: 100,
      exitCode: 0,
    },
  );
  assert.equal(receipt.finishedAtMs >= 100, true);
});

test('journal failure prevents spawn and filesystem side effects from user code', async (t) => {
  const { directory, receiptRoot } = fixture(t);
  const marker = path.join(directory, 'spawned');
  const launcher = new LocalProcessLauncher(
    {
      async register() {
        throw new Error('database unavailable');
      },
    },
    { receiptRoot, identityProvider: identityProvider() },
  );
  await assert.rejects(
    launcher.start({
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      callbackSequence: 1,
      callbackToken: TOKEN,
      command: { kind: 'argv', file: '/usr/bin/touch', args: [marker] },
    }),
    LocalProcessLaunchError,
  );
  assert.equal(fs.existsSync(marker), false);
});

test('a modified launcher is rejected before durable registration', async (t) => {
  const { directory, receiptRoot } = fixture(t);
  const launcherPath = path.join(directory, 'launcher.sh');
  fs.writeFileSync(launcherPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  let registered = false;
  const launcher = new LocalProcessLauncher(
    {
      async register() {
        registered = true;
      },
    },
    { receiptRoot, launcherPath, identityProvider: identityProvider() },
  );
  await assert.rejects(
    launcher.start({
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      callbackSequence: 1,
      callbackToken: TOKEN,
      command: { kind: 'argv', file: '/usr/bin/true', args: [] },
    }),
    /digest does not match review/,
  );
  assert.equal(registered, false);
});

test('executes the verified launcher fd when its path is replaced after registration', async (t) => {
  const { directory, receiptRoot } = fixture(t);
  const launcherPath = path.join(directory, 'launcher.sh');
  fs.copyFileSync(
    path.resolve(__dirname, '../assets/ql3-launcher.sh'),
    launcherPath,
  );
  const replacementPath = path.join(directory, 'replacement.sh');
  const launcher = new LocalProcessLauncher(
    {
      async register() {
        fs.writeFileSync(replacementPath, '#!/bin/sh\nexit 99\n', {
          mode: 0o700,
        });
        fs.renameSync(replacementPath, launcherPath);
      },
    },
    {
      receiptRoot,
      launcherPath,
      clock: { now: () => 100 },
      identityProvider: identityProvider(),
    },
  );

  const handle = await launcher.start({
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    callbackSequence: 1,
    callbackToken: TOKEN,
    command: { kind: 'argv', file: '/usr/bin/true', args: [] },
  });

  assert.deepEqual(await handle.completion, { exitCode: 0, signal: null });
  assert.equal(
    (await waitForReceipt(new CompletionReceiptFileStore(receiptRoot)))
      .exitCode,
    0,
  );
});

test('hard-caps durable output and publishes an immutable truncation fact', async (t) => {
  const { directory, receiptRoot } = fixture(t);
  const logArtifactId = `local-${'b'.repeat(30)}`;
  const outputDirectory = path.join(directory, 'artifacts', 'bb');
  const outputFilePath = path.join(outputDirectory, `${logArtifactId}.log`);
  const maximumBytes = 64 * 1024;
  const launcher = new LocalProcessLauncher(
    { register: async () => undefined },
    {
      receiptRoot,
      clock: { now: () => 100 },
      identityProvider: identityProvider(),
    },
  );
  const handle = await launcher.start({
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    callbackSequence: 1,
    callbackToken: TOKEN,
    command: {
      kind: 'argv',
      file: process.execPath,
      args: [
        '-e',
        [
          'if (process.env.QL3_OUTPUT_QUOTA_FIFO) process.exit(91);',
          'if (process.env.QL3_OUTPUT_TRUNCATION_TARGET) process.exit(92);',
          'process.stdout.write(Buffer.alloc(256 * 1024, 0x61), () => process.exit(0));',
        ].join(''),
      ],
    },
    output: {
      filePath: outputFilePath,
      maximumBytes,
      logArtifactId,
    },
  });
  assert.deepEqual(await handle.completion, { exitCode: 0, signal: null });
  assert.equal(fs.statSync(outputFilePath).size, maximumBytes);
  const factPath = path.join(
    outputDirectory,
    `.${logArtifactId}.log.truncated.json`,
  );
  const fact = JSON.parse(fs.readFileSync(factPath, 'utf8'));
  assert.deepEqual(
    {
      schemaVersion: fact.schemaVersion,
      runId: fact.runId,
      attemptId: fact.attemptId,
      logArtifactId: fact.logArtifactId,
      maximumBytes: fact.maximumBytes,
      quotaReached: fact.quotaReached,
    },
    {
      schemaVersion: 1,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      logArtifactId,
      maximumBytes,
      quotaReached: true,
    },
  );
  assert.equal(Number.isSafeInteger(fact.observedAtMs), true);
  assert.deepEqual(
    fs.readdirSync(outputDirectory).filter((name) => name.endsWith('.fifo')),
    [],
  );
});
