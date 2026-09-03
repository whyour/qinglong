const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { quotaEnvironment } = require('./helpers/quotaEnvironment.cjs');
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
    environment: quotaEnvironment(directory),
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

for (const kind of ['argv', 'shell']) {
  test(`publishes sparse binary ${kind} output before the process exits`, async (t) => {
    const { directory, receiptRoot } = fixture(t);
    const logArtifactId = `local-${'c'.repeat(30)}`;
    const outputFilePath = path.join(directory, `${logArtifactId}.log`);
    const release = path.join(directory, 'release');
    const marker = Buffer.from([0x00, 0xff, 0x71, 0x6c, 0x33]);
    const script = path.join(directory, 'producer.cjs');
    fs.writeFileSync(script, `
      const fs = require('node:fs');
      process.stdout.write(Buffer.from([0x00, 0xff, 0x71, 0x6c, 0x33]));
      const deadline = setTimeout(() => process.exit(92), 15000);
      const timer = setInterval(() => {
        if (!fs.existsSync(process.argv[2])) return;
        clearInterval(timer);
        clearTimeout(deadline);
        process.stderr.write('tail', () => process.exit(7));
      }, 10);
    `, { mode: 0o600 });
    const launcher = new LocalProcessLauncher(
      { register: async () => undefined },
      { receiptRoot, identityProvider: identityProvider() },
    );
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const handle = await launcher.start({
      runId: RUN_ID, attemptId: ATTEMPT_ID,
      callbackSequence: 1, callbackToken: TOKEN,
      environment: quotaEnvironment(directory),
      command: kind === 'argv'
        ? { kind, file: process.execPath, args: [script, release] }
        : { kind, command: [process.execPath, script, release].map(quote).join(' ') },
      output: { filePath: outputFilePath, maximumBytes: 65536, logArtifactId },
    });
    try {
      const deadline = Date.now() + 5000;
      while (fs.statSync(outputFilePath).size < marker.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(fs.readFileSync(outputFilePath), marker,
        'sparse bytes must be readable while the producer is waiting for release');
      assert.equal(await new CompletionReceiptFileStore(receiptRoot).read(ATTEMPT_ID), undefined);
      fs.writeFileSync(release, '', { mode: 0o600 });
      assert.deepEqual(await handle.completion, { exitCode: 7, signal: null });
      assert.deepEqual(fs.readFileSync(outputFilePath), Buffer.concat([marker, Buffer.from('tail')]));
      const fact = JSON.parse(fs.readFileSync(path.join(directory, `.${logArtifactId}.log.truncated.json`)));
      assert.equal(fact.quotaReached, false);
      assert.equal((await waitForReceipt(new CompletionReceiptFileStore(receiptRoot))).exitCode, 7);
    } finally {
      fs.writeFileSync(release, '', { mode: 0o600 });
      await handle.completion;
    }
  });
}

for (const [label, initialBytes, producedBytes] of [
  ['empty output', 0, 0],
  ['exact quota', 0, 65536],
  ['one-byte overflow', 0, 65537],
  ['partial final block', 65513, 31],
  ['exhausted quota', 65536, 23],
  ['exhausted quota without overflow', 65536, 0],
]) {
  test(`keeps byte-exact capture and truncation for ${label}`, async (t) => {
    const { directory, receiptRoot } = fixture(t);
    const logArtifactId = `local-${'d'.repeat(30)}`;
    const filePath = path.join(directory, `${logArtifactId}.log`);
    const initial = Buffer.alloc(initialBytes, 0x5a);
    fs.writeFileSync(filePath, initial, { mode: 0o600 });
    const produced = Buffer.from(Array.from({ length: producedBytes }, (_, i) => i % 256));
    const launcher = new LocalProcessLauncher(
      { register: async () => undefined },
      { receiptRoot, identityProvider: identityProvider() },
    );
    const handle = await launcher.start({
      runId: RUN_ID, attemptId: ATTEMPT_ID,
      callbackSequence: 1, callbackToken: TOKEN,
      environment: quotaEnvironment(directory),
      command: { kind: 'argv', file: process.execPath, args: ['-e', `
        const data = Buffer.from(Array.from({length: ${producedBytes}}, (_, i) => i % 256));
        let offset = 0;
        function write() {
          if (offset === data.length) return process.exit(9);
          const end = Math.min(data.length, offset + 997);
          const chunk = data.subarray(offset, end);
          offset = end;
          process.stdout.write(chunk, () => setImmediate(write));
        }
        write();
      `] },
      output: { filePath, maximumBytes: 65536, logArtifactId },
    });
    assert.deepEqual(await handle.completion, { exitCode: 9, signal: null });
    assert.deepEqual(fs.readFileSync(filePath), Buffer.concat([initial, produced]).subarray(0, 65536));
    const fact = JSON.parse(fs.readFileSync(path.join(directory, `.${logArtifactId}.log.truncated.json`)));
    assert.equal(fact.quotaReached, initialBytes + producedBytes > 65536);
    assert.equal((await waitForReceipt(new CompletionReceiptFileStore(receiptRoot))).exitCode, 9);
  });
}

for (const availability of ['missing', 'not-executable', 'rejecting']) {
  test(`rejects unsupported capture utilities (${availability}) before running user code`, async (t) => {
    const { directory, receiptRoot } = fixture(t);
    const bin = path.join(directory, 'unsupported-bin');
    fs.mkdirSync(bin, { mode: 0o700 });
    if (availability !== 'missing') {
      for (const name of ['busybox', 'head', 'stdbuf']) {
        fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n', {
          mode: availability === 'not-executable' ? 0o600 : 0o700,
        });
      }
    }
    const marker = path.join(directory, 'must-not-run');
    const logArtifactId = `local-${'e'.repeat(30)}`;
    const filePath = path.join(directory, `${logArtifactId}.log`);
    const launcher = new LocalProcessLauncher(
      { register: async () => undefined },
      { receiptRoot, identityProvider: identityProvider() },
    );
    const handle = await launcher.start({
      runId: RUN_ID, attemptId: ATTEMPT_ID,
      callbackSequence: 1, callbackToken: TOKEN,
      // Keep this negative fixture isolated even on a noexec tmpfs: a shell
      // must not fall through an unexecutable stub to real system utilities.
      environment: { PATH: bin },
      // Use the actual installed Node binary so an accidental launch always
      // writes the marker, rather than failing because /usr/bin/touch is absent.
      command: { kind: 'argv', file: process.execPath, args: [
        '-e', "require('node:fs').writeFileSync(process.argv[1], 'ran');", marker,
      ] },
      output: { filePath, maximumBytes: 65536, logArtifactId },
    });
    assert.deepEqual(await handle.completion, { exitCode: 125, signal: null });
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.statSync(filePath).size, 0);
    assert.equal(await new CompletionReceiptFileStore(receiptRoot).read(ATTEMPT_ID), undefined);
    assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.fifo')), false);
  });
}

test('capture failure drains output without forging a truncation fact or changing user exit', async (t) => {
  const { directory, receiptRoot } = fixture(t);
  const bin = path.join(directory, 'failing-bin');
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'busybox'), `#!/bin/sh
case " $* " in
  *' count=0 '*) exit 0 ;;
esac
printf 'capture failure must not bypass the log quota' >&2
exit 1
`, { mode: 0o700 });
  const logArtifactId = `local-${'f'.repeat(30)}`;
  const filePath = path.join(directory, `${logArtifactId}.log`);
  const launcher = new LocalProcessLauncher(
    { register: async () => undefined },
    { receiptRoot, identityProvider: identityProvider() },
  );
  const handle = await launcher.start({
    runId: RUN_ID, attemptId: ATTEMPT_ID,
    callbackSequence: 1, callbackToken: TOKEN,
    environment: { PATH: `${bin}:/usr/bin:/bin` },
    command: { kind: 'argv', file: process.execPath, args: [
      '-e', 'process.stdout.write(Buffer.alloc(256 * 1024), () => process.exit(9));',
    ] },
    output: { filePath, maximumBytes: 65536, logArtifactId },
  });
  assert.deepEqual(await handle.completion, { exitCode: 9, signal: null });
  assert.equal(fs.statSync(filePath).size, 0);
  assert.equal(fs.existsSync(path.join(directory, `.${logArtifactId}.log.truncated.json`)), false);
  assert.equal((await waitForReceipt(new CompletionReceiptFileStore(receiptRoot))).exitCode, 9);
});
