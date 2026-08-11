require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { afterEach, test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const {
  CompletionReceiptFileStore,
} = require('../../back/runtime/adapters/fs/completionReceiptFileStore');
const {
  LocalArtifactTruncationFactStore,
  localArtifactTruncationFactFileName,
} = require('../../back/runtime/adapters/fs/localArtifactTruncationFactStore');
const {
  enableDurableLocalProcessOutput,
} = require('../../back/runtime/adapters/local-process/durableLocalProcessOutput');
const {
  LocalProcessExecutor,
} = require('../../back/runtime/adapters/local-process/localProcessExecutor');
const {
  encodeLocalArtifactTruncationFact,
} = require('../../back/runtime/domain/localArtifactTruncation');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const LAUNCHER_PATH = path.join(REPOSITORY_ROOT, 'shell', 'ql3-launcher.sh');
const RUN_ID = '019f7300-0000-7000-8000-000000000001';
const ATTEMPT_ID = '019f7300-0000-7000-8000-000000000002';
const CALLBACK_TOKEN = 'a'.repeat(43);
const LOG_ARTIFACT_ID = `local-${'b'.repeat(30)}`;
const roots = [];

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-launcher-'));
  roots.push(root);
  return root;
}

function specification(overrides = {}) {
  return {
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    projectId: 'default',
    taskId: 'durable-launcher-test',
    taskRevision: 'revision-1',
    command: {
      kind: 'argv',
      file: process.execPath,
      args: ['-e', "process.stdout.write('durable-output')"],
    },
    environmentPolicy: 'isolated',
    terminationGraceMs: 100,
    ...overrides,
  };
}

function durableContext(root, outputFilePath, write, capability = {}) {
  return {
    environment: {},
    completionCallback: {
      token: CALLBACK_TOKEN,
      callbackSequence: 1,
    },
    output: enableDurableLocalProcessOutput(
      {
        async write(value) {
          await write?.(value);
        },
      },
      {
        outputFilePath,
        completionReceiptRoot: path.join(root, 'receipts'),
        ...capability,
      },
    ),
  };
}

async function waitForReceipt(store, attemptId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await store.read(attemptId);
    if (value) return value;
    await delay(25);
  }
  throw new Error('Timed out waiting for completion receipt');
}

async function waitForFileContent(filePath, expected, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fs.readFile(filePath, 'utf8')).includes(expected)) return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${expected} in ${filePath}`);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

test(
  'writes stdout and stderr directly and publishes one canonical receipt',
  { timeout: 10_000 },
  async () => {
    const root = await temporaryRoot();
    const outputFilePath = path.join(root, 'logs', 'attempt.log');
    let sinkWrites = 0;
    const executor = new LocalProcessExecutor({
      durableLauncherPath: LAUNCHER_PATH,
    });
    const handle = await executor.start(
      specification({
        command: {
          kind: 'shell',
          command:
            "test -z \"${QL3_RECEIPT_CALLBACK_TOKEN+x}\" || exit 91; printf 'stdout-value'; printf 'stderr-value' >&2; exit 7",
          shell: '/bin/sh',
        },
      }),
      durableContext(root, outputFilePath, async () => {
        sinkWrites += 1;
      }),
    );

    const result = await handle.completion;
    assert.equal(result.outcome, 'failed');
    assert.equal(result.exitCode, 7);
    assert.equal(sinkWrites, 0);
    assert.equal(
      await fs.readFile(outputFilePath, 'utf8'),
      'stdout-valuestderr-value',
    );
    assert.equal((await fs.stat(outputFilePath)).mode & 0o777, 0o600);

    const receipt = await new CompletionReceiptFileStore(
      path.join(root, 'receipts'),
    ).read(ATTEMPT_ID);
    assert.equal(receipt.runId, RUN_ID);
    assert.equal(receipt.attemptId, ATTEMPT_ID);
    assert.equal(receipt.callbackSequence, 1);
    assert.equal(receipt.token, CALLBACK_TOKEN);
    assert.equal(receipt.exitCode, 7);
    assert.ok(receipt.finishedAtMs >= receipt.startedAtMs);
  },
);

test(
  'hard-caps durable output while draining the child to successful completion',
  { timeout: 10_000 },
  async () => {
    const root = await temporaryRoot();
    const outputDirectory = path.join(root, 'logs');
    const outputShard = path.join(outputDirectory, LOG_ARTIFACT_ID.slice(6, 8));
    const outputFilePath = path.join(outputShard, `${LOG_ARTIFACT_ID}.log`);
    const maximumBytes = 64 * 1024;
    const executor = new LocalProcessExecutor({
      durableLauncherPath: LAUNCHER_PATH,
    });
    const handle = await executor.start(
      specification({
        command: {
          kind: 'argv',
          file: process.execPath,
          args: [
            '-e',
            [
              'if (process.env.QL3_OUTPUT_QUOTA_FIFO) process.exit(91);',
              'if (process.env.QL3_OUTPUT_TRUNCATION_TARGET) process.exit(92);',
              'const chunk = Buffer.alloc(256 * 1024, 0x61);',
              'process.stdout.write(chunk, () => process.exit(0));',
            ].join(''),
          ],
        },
      }),
      durableContext(root, outputFilePath, undefined, {
        maximumBytes,
        logArtifactId: LOG_ARTIFACT_ID,
      }),
    );
    const result = await handle.completion;
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.exitCode, 0);
    assert.equal((await fs.stat(outputFilePath)).size, maximumBytes);
    const truncation = await new LocalArtifactTruncationFactStore(
      outputDirectory,
    ).read(LOG_ARTIFACT_ID);
    assert.deepEqual(
      {
        schemaVersion: truncation.schemaVersion,
        runId: truncation.runId,
        attemptId: truncation.attemptId,
        logArtifactId: truncation.logArtifactId,
        maximumBytes: truncation.maximumBytes,
        quotaReached: truncation.quotaReached,
      },
      {
        schemaVersion: 1,
        runId: RUN_ID,
        attemptId: ATTEMPT_ID,
        logArtifactId: LOG_ARTIFACT_ID,
        maximumBytes,
        quotaReached: true,
      },
    );
    assert.ok(Number.isSafeInteger(truncation.observedAtMs));
    assert.deepEqual(
      (await fs.readdir(outputShard)).filter((name) => name.endsWith('.fifo')),
      [],
    );
    assert.deepEqual(
      (await fs.readdir(outputShard)).filter((name) => name.endsWith('.tmp')),
      [],
    );
    assert.equal(
      (
        await waitForReceipt(
          new CompletionReceiptFileStore(path.join(root, 'receipts')),
          ATTEMPT_ID,
        )
      ).exitCode,
      0,
    );
  },
);

test('publishes a negative truncation fact when output stays below quota', async () => {
  const root = await temporaryRoot();
  const outputDirectory = path.join(root, 'logs');
  const outputFilePath = path.join(
    outputDirectory,
    LOG_ARTIFACT_ID.slice(6, 8),
    `${LOG_ARTIFACT_ID}.log`,
  );
  const executor = new LocalProcessExecutor({
    durableLauncherPath: LAUNCHER_PATH,
  });
  const handle = await executor.start(
    specification(),
    durableContext(root, outputFilePath, undefined, {
      maximumBytes: 64 * 1024,
      logArtifactId: LOG_ARTIFACT_ID,
    }),
  );
  assert.equal((await handle.completion).exitCode, 0);
  const fact = await new LocalArtifactTruncationFactStore(outputDirectory).read(
    LOG_ARTIFACT_ID,
  );
  assert.equal(fact.quotaReached, false);
  assert.equal(fact.maximumBytes, 64 * 1024);
});

test('never overwrites an already published truncation fact', async () => {
  const root = await temporaryRoot();
  const outputDirectory = path.join(root, 'logs');
  const outputShard = path.join(outputDirectory, LOG_ARTIFACT_ID.slice(6, 8));
  const outputFilePath = path.join(outputShard, `${LOG_ARTIFACT_ID}.log`);
  await fs.mkdir(outputShard, { recursive: true, mode: 0o700 });
  const existing = {
    schemaVersion: 1,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    logArtifactId: LOG_ARTIFACT_ID,
    maximumBytes: 64 * 1024,
    quotaReached: false,
    observedAtMs: 1,
  };
  await fs.writeFile(
    path.join(
      outputShard,
      localArtifactTruncationFactFileName(LOG_ARTIFACT_ID),
    ),
    encodeLocalArtifactTruncationFact(existing),
    { mode: 0o600 },
  );
  const executor = new LocalProcessExecutor({
    durableLauncherPath: LAUNCHER_PATH,
  });
  const handle = await executor.start(
    specification({
      command: {
        kind: 'argv',
        file: process.execPath,
        args: ['-e', 'process.stdout.write(Buffer.alloc(256 * 1024, 0x61))'],
      },
    }),
    durableContext(root, outputFilePath, undefined, {
      maximumBytes: 64 * 1024,
      logArtifactId: LOG_ARTIFACT_ID,
    }),
  );
  assert.equal((await handle.completion).exitCode, 0);
  assert.deepEqual(
    await new LocalArtifactTruncationFactStore(outputDirectory).read(
      LOG_ARTIFACT_ID,
    ),
    existing,
  );
});

test(
  'keeps the launcher alive through TERM until its child exits',
  { timeout: 10_000 },
  async () => {
    const root = await temporaryRoot();
    const receiptRoot = path.join(root, 'receipts');
    const outputFilePath = path.join(root, 'cancelled.log');
    const executor = new LocalProcessExecutor({
      durableLauncherPath: LAUNCHER_PATH,
    });
    const handle = await executor.start(
      specification({
        command: {
          kind: 'argv',
          file: process.execPath,
          args: [
            '-e',
            "process.on('SIGTERM', () => setTimeout(() => process.exit(23), 100)); process.stdout.write('ready'); setInterval(() => undefined, 1000)",
          ],
        },
        terminationGraceMs: 1_000,
      }),
      durableContext(root, outputFilePath),
    );
    await waitForFileContent(outputFilePath, 'ready');
    const stopped = await executor.stop(handle, {
      kind: 'user',
      requestedAtMs: Date.now(),
    });
    const result = await handle.completion;

    assert.equal(stopped.killSignalSent, false);
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.exitCode, 23);
    assert.equal(
      (
        await waitForReceipt(
          new CompletionReceiptFileStore(receiptRoot),
          ATTEMPT_ID,
        )
      ).exitCode,
      23,
    );
  },
);

test(
  'never overwrites an already published completion receipt',
  { timeout: 10_000 },
  async () => {
    const root = await temporaryRoot();
    const receiptRoot = path.join(root, 'receipts');
    const store = new CompletionReceiptFileStore(receiptRoot);
    const original = {
      schemaVersion: 1,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      callbackSequence: 1,
      token: 'b'.repeat(43),
      startedAtMs: 1_750_000_000_000,
      finishedAtMs: 1_750_000_000_100,
      exitCode: 19,
    };
    await store.publish(original);

    const executor = new LocalProcessExecutor({
      durableLauncherPath: LAUNCHER_PATH,
    });
    const handle = await executor.start(
      specification(),
      durableContext(root, path.join(root, 'attempt.log')),
    );
    assert.equal((await handle.completion).outcome, 'succeeded');
    assert.deepEqual(await store.read(ATTEMPT_ID), original);
  },
);

test(
  'preserves the user exit code when receipt storage is unavailable',
  { timeout: 10_000 },
  async () => {
    const root = await temporaryRoot();
    const blocked = path.join(root, 'blocked');
    await fs.mkdir(blocked, { mode: 0o500 });
    const target = path.join(blocked, `${ATTEMPT_ID}.json`);
    const temporary = path.join(
      blocked,
      `.${ATTEMPT_ID}.${'a'.repeat(32)}.tmp`,
    );
    const child = spawn(
      '/bin/sh',
      [LAUNCHER_PATH, 'argv', '/bin/sh', '-c', 'exit 17'],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          PATH: process.env.PATH,
          QL3_RECEIPT_RUN_ID: RUN_ID,
          QL3_RECEIPT_ATTEMPT_ID: ATTEMPT_ID,
          QL3_RECEIPT_CALLBACK_SEQUENCE: '1',
          QL3_RECEIPT_CALLBACK_TOKEN: CALLBACK_TOKEN,
          QL3_RECEIPT_STARTED_AT_MS: String(Date.now()),
          QL3_RECEIPT_TARGET: target,
          QL3_RECEIPT_TEMPORARY: temporary,
        },
        stdio: 'ignore',
      },
    );
    assert.deepEqual(await waitForExit(child), { code: 17, signal: null });
    await assert.rejects(fs.lstat(target), /ENOENT/);
  },
);

test(
  'keeps appending output and publishes completion after the parent exits',
  { timeout: 15_000 },
  async () => {
    const root = await temporaryRoot();
    const outputFilePath = path.join(root, 'survives-parent.log');
    const receiptRoot = path.join(root, 'receipts');
    const durableOutputModule = path.join(
      REPOSITORY_ROOT,
      'back/runtime/adapters/local-process/durableLocalProcessOutput',
    );
    const executorModule = path.join(
      REPOSITORY_ROOT,
      'back/runtime/adapters/local-process/localProcessExecutor',
    );
    const childProgram = [
      "process.stdout.write('before-parent-exit\\n');",
      "setTimeout(() => { process.stdout.write('after-parent-exit\\n'); process.exit(0); }, 300);",
    ].join('');
    const controller = `
      require('ts-node/register/transpile-only');
      const { enableDurableLocalProcessOutput } = require(${JSON.stringify(
        durableOutputModule,
      )});
      const { LocalProcessExecutor } = require(${JSON.stringify(
        executorModule,
      )});
      const executor = new LocalProcessExecutor({ durableLauncherPath: ${JSON.stringify(
        LAUNCHER_PATH,
      )} });
      executor.start(${JSON.stringify(
        specification({
          command: {
            kind: 'argv',
            file: process.execPath,
            args: ['-e', childProgram],
          },
        }),
      )}, {
        environment: {},
        completionCallback: { token: ${JSON.stringify(
          CALLBACK_TOKEN,
        )}, callbackSequence: 1 },
        output: enableDurableLocalProcessOutput({ async write() {} }, {
          outputFilePath: ${JSON.stringify(outputFilePath)},
          completionReceiptRoot: ${JSON.stringify(receiptRoot)},
        }),
      }).then(() => process.exit(0), () => process.exit(1));
    `;
    const controllerProcess = spawn(process.execPath, ['-e', controller], {
      cwd: REPOSITORY_ROOT,
      stdio: 'ignore',
    });
    assert.deepEqual(await waitForExit(controllerProcess), {
      code: 0,
      signal: null,
    });

    const receipt = await waitForReceipt(
      new CompletionReceiptFileStore(receiptRoot),
      ATTEMPT_ID,
    );
    assert.equal(receipt.exitCode, 0);
    assert.equal(
      await fs.readFile(outputFilePath, 'utf8'),
      'before-parent-exit\nafter-parent-exit\n',
    );
  },
);
