'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  WorkerFileLogArtifactAllocator,
  createWorkerRemoteLogArtifactId,
  workerRemoteLogArtifactPolicy,
} = require('../dist/execution/workerFileLogArtifactAllocator');

const REQUEST = Object.freeze({
  projectId: 'project-1',
  runId: 'run-1',
  attemptId: 'attempt-1',
  offerId: 'offer-1',
});

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-worker-log-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function policy(overrides = {}) {
  return {
    maximumAttemptBytes: 16,
    minimumFreeBytes: 32,
    maximumWriteChunkBytes: 8,
    ...overrides,
  };
}

function capacity(availableBytes = 1_000_000n) {
  return { async availableBytes() { return availableBytes; } };
}

function artifactPath(root, artifactId) {
  return path.join(root, artifactId.slice(5, 7), `${artifactId}.log`);
}

test('provides explicit edge and node capacity policies', () => {
  assert.deepEqual(workerRemoteLogArtifactPolicy('edge'), {
    maximumAttemptBytes: 4 * 1024 * 1024,
    minimumFreeBytes: 32 * 1024 * 1024,
    maximumWriteChunkBytes: 1024 * 1024,
  });
  assert.deepEqual(workerRemoteLogArtifactPolicy('node'), {
    maximumAttemptBytes: 64 * 1024 * 1024,
    minimumFreeBytes: 256 * 1024 * 1024,
    maximumWriteChunkBytes: 1024 * 1024,
  });
});

test('derives one opaque log identity per exact offer authority', () => {
  const first = createWorkerRemoteLogArtifactId(REQUEST);
  assert.equal(first, createWorkerRemoteLogArtifactId({ ...REQUEST }));
  assert.notEqual(first, createWorkerRemoteLogArtifactId({
    ...REQUEST,
    offerId: 'offer-2',
  }));
  assert.match(first, /^wlog-[a-f0-9]{30}$/);
  assert.equal(first.length, 35);
  assert.equal(first.includes(REQUEST.runId), false);
});

test('hands off once, appends both streams, and keeps private ownership', async (t) => {
  const root = await temporaryRoot(t);
  const allocator = new WorkerFileLogArtifactAllocator({
    root,
    policy: policy(),
    capacity: capacity(),
  });
  const prepared = await allocator.prepare(REQUEST);
  const output = prepared.takeOutput();
  assert.throws(() => prepared.takeOutput(), /closed/);
  await prepared.release();
  const mutable = Buffer.from('abc');
  const firstWrite = output.write({
    stream: 'stdout',
    chunk: mutable,
    observedAtMs: 1,
  });
  mutable.fill(0x7a);
  await firstWrite;
  await output.write({
    stream: 'stderr',
    chunk: Buffer.from('def'),
    observedAtMs: 2,
  });
  await output.close();
  await output.close();
  await assert.rejects(
    output.write({ stream: 'stdout', chunk: Buffer.from('x'), observedAtMs: 3 }),
    /closed/,
  );
  const file = artifactPath(root, prepared.logArtifactId);
  assert.equal(await fs.readFile(file, 'utf8'), 'abcdef');
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('preserves an accepted prefix across reopen without truncation', async (t) => {
  const root = await temporaryRoot(t);
  const allocator = new WorkerFileLogArtifactAllocator({
    root,
    policy: policy(),
    capacity: capacity(),
  });
  const first = await allocator.prepare(REQUEST);
  const firstOutput = first.takeOutput();
  await firstOutput.write({
    stream: 'stdout',
    chunk: Buffer.from('before-'),
    observedAtMs: 1,
  });
  const replay = await allocator.prepare(REQUEST);
  const replayOutput = replay.takeOutput();
  await replayOutput.write({
    stream: 'stdout',
    chunk: Buffer.from('after'),
    observedAtMs: 2,
  });
  await Promise.all([firstOutput.close(), replayOutput.close()]);
  assert.equal(first.logArtifactId, replay.logArtifactId);
  assert.equal(
    await fs.readFile(artifactPath(root, first.logArtifactId), 'utf8'),
    'before-after',
  );
});

test('streams a bounded Artifact and authenticates its truncation fact', async (t) => {
  const root = await temporaryRoot(t);
  const streamingPolicy = policy({ maximumWriteChunkBytes: 16 });
  const allocator = new WorkerFileLogArtifactAllocator({
    root,
    policy: streamingPolicy,
    capacity: capacity(),
  });
  const prepared = await allocator.prepare(REQUEST);
  const output = prepared.takeOutput();
  await output.write({
    stream: 'stdout',
    chunk: Buffer.from('streamed-log'),
    observedAtMs: 1,
  });
  await output.close();
  const file = artifactPath(root, prepared.logArtifactId);
  await fs.writeFile(
    path.join(path.dirname(file), `.${prepared.logArtifactId}.log.truncated.json`),
    JSON.stringify({
      schemaVersion: 1,
      runId: REQUEST.runId,
      attemptId: REQUEST.attemptId,
      logArtifactId: prepared.logArtifactId,
      maximumBytes: streamingPolicy.maximumAttemptBytes,
      quotaReached: false,
      observedAtMs: 2,
    }),
    { mode: 0o600 },
  );

  const lease = await allocator.open({
    runId: REQUEST.runId,
    attemptId: REQUEST.attemptId,
    logArtifactId: prepared.logArtifactId,
  });
  assert.ok(lease);
  assert.equal(lease.byteLength, 12);
  assert.equal(lease.truncated, false);
  const chunks = [];
  for await (const chunk of lease.chunks()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'streamed-log');
  await lease.close();
  assert.throws(() => lease.chunks(), /closed/);
});

test('writes only the remaining prefix and then enforces the hard quota', async (t) => {
  const root = await temporaryRoot(t);
  const allocator = new WorkerFileLogArtifactAllocator({
    root,
    policy: policy({ maximumAttemptBytes: 5 }),
    capacity: capacity(),
  });
  const prepared = await allocator.prepare(REQUEST);
  const output = prepared.takeOutput();
  await output.write({
    stream: 'stdout',
    chunk: Buffer.from('abc'),
    observedAtMs: 1,
  });
  await assert.rejects(
    output.write({ stream: 'stderr', chunk: Buffer.from('defg'), observedAtMs: 2 }),
    /quota_exceeded/,
  );
  await output.close();
  assert.equal(
    await fs.readFile(artifactPath(root, prepared.logArtifactId), 'utf8'),
    'abcde',
  );
});

test('rejects oversized write chunks without changing the Artifact', async (t) => {
  const root = await temporaryRoot(t);
  const allocator = new WorkerFileLogArtifactAllocator({
    root,
    policy: policy({ maximumWriteChunkBytes: 3 }),
    capacity: capacity(),
  });
  const prepared = await allocator.prepare(REQUEST);
  const output = prepared.takeOutput();
  await assert.rejects(
    output.write({ stream: 'stdout', chunk: Buffer.from('four'), observedAtMs: 1 }),
    /invalid_output/,
  );
  await output.close();
  assert.equal((await fs.stat(artifactPath(root, prepared.logArtifactId))).size, 0);
});

test('fails capacity admission before creating a shard or output file', async (t) => {
  const root = await temporaryRoot(t);
  const allocator = new WorkerFileLogArtifactAllocator({
    root,
    policy: policy(),
    capacity: capacity(47n),
  });
  await assert.rejects(allocator.prepare(REQUEST), /capacity_unavailable/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('fails closed when the deterministic output target is a symlink', async (t) => {
  const root = await temporaryRoot(t);
  const artifactId = createWorkerRemoteLogArtifactId(REQUEST);
  const directory = path.dirname(artifactPath(root, artifactId));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const victim = path.join(root, 'victim');
  await fs.writeFile(victim, 'unchanged', { mode: 0o600 });
  await fs.symlink(victim, artifactPath(root, artifactId));
  const allocator = new WorkerFileLogArtifactAllocator({
    root,
    policy: policy(),
    capacity: capacity(),
  });
  await assert.rejects(allocator.prepare(REQUEST), /unsafe_path/);
  assert.equal(await fs.readFile(victim, 'utf8'), 'unchanged');
});

test('release closes an unclaimed preparation and prevents later handoff', async (t) => {
  const root = await temporaryRoot(t);
  const allocator = new WorkerFileLogArtifactAllocator({
    root,
    policy: policy(),
    capacity: capacity(),
  });
  const prepared = await allocator.prepare(REQUEST);
  await prepared.release();
  await prepared.release();
  assert.throws(() => prepared.takeOutput(), /closed/);
});
