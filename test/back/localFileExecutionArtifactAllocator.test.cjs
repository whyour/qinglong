require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  LocalFileExecutionArtifactAllocator,
} = require('../../back/runtime/adapters/fs/localFileExecutionArtifactAllocator');
const {
  durableLocalProcessOutput,
} = require('../../back/runtime/adapters/local-process/durableLocalProcessOutput');
const {
  localExecutionArtifactId,
} = require('../../back/runtime/domain/localExecutionArtifact');

const CAPACITY_POLICY = Object.freeze({
  maximumAttemptBytes: 64 * 1024,
  minimumFreeBytes: 0,
});

function candidate(overrides = {}) {
  return {
    runId: 'run-artifact',
    attemptId: 'attempt-artifact',
    projectId: 'default',
    taskId: 'task-artifact',
    taskRevision: 'revision-1',
    executorType: 'local_process',
    priority: 0,
    queuedAtMs: 1_760_000_000_000,
    attemptCreatedAtMs: 1_760_000_000_000,
    ...overrides,
  };
}

async function temporaryRoots(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-artifact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    artifacts: path.join(root, 'artifacts'),
    receipts: path.join(root, 'receipts'),
  };
}

function allocator(roots, policy = CAPACITY_POLICY, capacity) {
  return new LocalFileExecutionArtifactAllocator(
    roots.artifacts,
    roots.receipts,
    policy,
    capacity,
  );
}

test('allocates a private deterministic Artifact and serializes accepted writes', async (t) => {
  const roots = await temporaryRoots(t);
  const artifacts = allocator(roots);
  const prepared = await artifacts.prepare(candidate());
  assert.equal(prepared.logArtifactId, localExecutionArtifactId(candidate()));
  assert.equal(prepared.logArtifactId.length, 36);
  const capability = durableLocalProcessOutput(prepared.output);
  assert.ok(capability);
  assert.equal(capability.maximumBytes, CAPACITY_POLICY.maximumAttemptBytes);
  assert.equal(capability.logArtifactId, prepared.logArtifactId);
  assert.equal(JSON.stringify(prepared.output).includes(roots.root), false);

  await Promise.all([
    prepared.output.write({
      stream: 'stdout',
      chunk: Buffer.from('first\n'),
      observedAtMs: 1,
    }),
    prepared.output.write({
      stream: 'stderr',
      chunk: Buffer.from('second\n'),
      observedAtMs: 2,
    }),
  ]);
  await prepared.dispose();
  assert.equal(
    await fs.readFile(capability.outputFilePath, 'utf8'),
    'first\nsecond\n',
  );
  assert.equal((await fs.stat(capability.outputFilePath)).mode & 0o777, 0o600);
  assert.equal(
    (await fs.stat(path.dirname(capability.outputFilePath))).mode & 0o777,
    0o700,
  );
  await assert.rejects(
    prepared.output.write({
      stream: 'stdout',
      chunk: Buffer.from('late'),
      observedAtMs: 3,
    }),
    /closed/,
  );

  const replay = await artifacts.prepare(candidate());
  assert.equal(replay.logArtifactId, prepared.logArtifactId);
  await replay.output.write({
    stream: 'stdout',
    chunk: Buffer.from('replay\n'),
    observedAtMs: 4,
  });
  await replay.dispose();
  assert.equal(
    await fs.readFile(capability.outputFilePath, 'utf8'),
    'first\nsecond\nreplay\n',
  );
});

test('uses a different opaque Artifact for each Attempt', async (t) => {
  const roots = await temporaryRoots(t);
  const artifacts = allocator(roots);
  const first = await artifacts.prepare(candidate());
  const second = await artifacts.prepare(candidate({ attemptId: 'attempt-2' }));
  assert.notEqual(first.logArtifactId, second.logArtifactId);
  await Promise.all([first.dispose(), second.dispose()]);
});

test('drains writes accepted before asynchronous disposal closes the file', async (t) => {
  const roots = await temporaryRoots(t);
  const artifacts = allocator(roots);
  const prepared = await artifacts.prepare(candidate());
  const capability = durableLocalProcessOutput(prepared.output);
  const accepted = prepared.output.write({
    stream: 'stdout',
    chunk: Buffer.from('accepted-before-close'),
    observedAtMs: 1,
  });
  await prepared.dispose();
  await accepted;
  assert.equal(
    await fs.readFile(capability.outputFilePath, 'utf8'),
    'accepted-before-close',
  );
});

test('rejects relative roots and refuses a symlink Artifact target', async (t) => {
  assert.throws(
    () =>
      new LocalFileExecutionArtifactAllocator(
        'relative',
        '/tmp/receipts',
        CAPACITY_POLICY,
      ),
    /must be absolute/,
  );
  const roots = await temporaryRoots(t);
  const reference = candidate();
  const artifactId = localExecutionArtifactId(reference);
  const shard = artifactId.slice(6, 8);
  const directory = path.join(roots.artifacts, shard);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const outside = path.join(roots.root, 'outside.log');
  await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, path.join(directory, `${artifactId}.log`));
  const artifacts = allocator(roots);
  await assert.rejects(artifacts.prepare(reference));
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
});

test('hard-caps ordinary output and never writes a partial byte past quota', async (t) => {
  const roots = await temporaryRoots(t);
  const artifacts = allocator(roots);
  const prepared = await artifacts.prepare(candidate());
  const capability = durableLocalProcessOutput(prepared.output);
  const oversized = Buffer.alloc(
    CAPACITY_POLICY.maximumAttemptBytes + 37,
    0x61,
  );
  await assert.rejects(
    prepared.output.write({
      stream: 'stdout',
      chunk: oversized,
      observedAtMs: 1,
    }),
    /byte quota/,
  );
  await assert.rejects(
    prepared.output.write({
      stream: 'stderr',
      chunk: Buffer.from('must-not-append'),
      observedAtMs: 2,
    }),
    /byte quota/,
  );
  await prepared.dispose();
  const stored = await fs.readFile(capability.outputFilePath);
  assert.equal(stored.length, CAPACITY_POLICY.maximumAttemptBytes);
  assert.equal(stored.equals(oversized.subarray(0, stored.length)), true);
});

test('reserves free space before opening an Attempt Artifact', async (t) => {
  const roots = await temporaryRoots(t);
  let inspected = 0;
  const artifacts = allocator(
    roots,
    { maximumAttemptBytes: 64 * 1024, minimumFreeBytes: 128 * 1024 },
    {
      async inspect(root) {
        inspected += 1;
        assert.equal(root, roots.artifacts);
        return {
          availableBytes: BigInt(128 * 1024),
          totalBytes: BigInt(1024 * 1024),
        };
      },
    },
  );
  await assert.rejects(
    artifacts.prepare(candidate()),
    /capacity is unavailable/,
  );
  assert.equal(inspected, 1);
  const artifactId = localExecutionArtifactId(candidate());
  const target = path.join(
    roots.artifacts,
    artifactId.slice(6, 8),
    `${artifactId}.log`,
  );
  await assert.rejects(fs.lstat(target), /ENOENT/);
});
