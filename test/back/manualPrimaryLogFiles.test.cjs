require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const {
  LegacyManualPrimaryLogFiles,
} = require('../../back/runtime/adapters/legacy/defaultManualPrimaryRuntime');

const temporaryDirectories = [];

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-manual-log-'));
  temporaryDirectories.push(root);
  return root;
}

function input(logName) {
  return {
    cron: {
      id: 31,
      command: 'demo.js',
      extraSchedules: [],
      logName,
    },
    acceptedAtMs: 1_750_000_000_000,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

test('writes manual Primary output below the configured log root', async () => {
  const root = await temporaryRoot();
  const logs = new LegacyManualPrimaryLogFiles(root);
  const prepared = await logs.prepare(input('nested/task-31'));

  assert.match(prepared.logPath, /^nested\/task-31\/.+\.log$/);
  await prepared.output.write({
    stream: 'stdout',
    chunk: Buffer.from('hello primary\n'),
    observedAtMs: 1_750_000_000_001,
  });
  await prepared.close();

  const absolutePath = path.resolve(root, ...prepared.logPath.split('/'));
  assert.equal(await fs.readFile(absolutePath, 'utf8'), 'hello primary\n');
});

test('resolves the receipt journal only after live completion cleanup', async () => {
  const root = await temporaryRoot();
  const receiptRoot = await temporaryRoot();
  const resolved = [];
  const logs = new LegacyManualPrimaryLogFiles(root, receiptRoot, {
    async resolve(attemptId) {
      resolved.push(attemptId);
      return true;
    },
  });
  const prepared = await logs.prepare(input('nested/task-31'));
  const attemptId = '019f7900-0000-7000-8000-000000000099';

  await prepared.completionCommitted(attemptId);
  assert.deepEqual(resolved, [attemptId]);
  await prepared.close();
});

test('rejects relative and absolute paths outside the configured log root', async () => {
  const root = await temporaryRoot();
  const logs = new LegacyManualPrimaryLogFiles(root);

  await assert.rejects(logs.prepare(input('../outside')));
  await assert.rejects(logs.prepare(input(path.resolve(root, '../outside'))));
});
