const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  LocalRunAttemptLogRangeReadError,
  LocalRunAttemptLogRangeReader,
} = require('../dist/artifact-read/localRunAttemptLogRangeReader.js');

const artifactId = `local-${'a'.repeat(30)}`;
const identity = Object.freeze({
  projectId: 'prj_default',
  runId: 'run_123',
  attemptId: 'attempt_123',
  logArtifactId: artifactId,
});

async function fixture(t, content = Buffer.from('0123456789')) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-log-read-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'artifacts');
  const shard = path.join(root, 'aa');
  await fs.mkdir(shard, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  await fs.chmod(shard, 0o700);
  const log = path.join(shard, `${artifactId}.log`);
  await fs.writeFile(log, content, { mode: 0o600 });
  await fs.chmod(log, 0o600);
  return { parent, root, shard, log };
}

async function fact(shard, overrides = {}) {
  const file = path.join(shard, `.${artifactId}.log.truncated.json`);
  await fs.writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      runId: identity.runId,
      attemptId: identity.attemptId,
      logArtifactId: identity.logArtifactId,
      maximumBytes: 64 * 1024,
      quotaReached: false,
      observedAtMs: 9,
      ...overrides,
    }),
    { mode: 0o600 },
  );
  await fs.chmod(file, 0o600);
  return file;
}

test('reads one bounded private-file snapshot and canonical truncation fact', async (t) => {
  const value = await fixture(t);
  await fact(value.shard, { quotaReached: true });
  const result = await new LocalRunAttemptLogRangeReader(value.root).read(
    identity,
    { offset: 2, length: 4 },
  );
  assert.equal(result.status, 'available');
  assert.equal(Buffer.from(result.content).toString(), '2345');
  assert.deepEqual(
    {
      start: result.start,
      endExclusive: result.endExclusive,
      totalBytes: result.totalBytes,
      nextOffset: result.nextOffset,
      truncation: result.truncation,
    },
    {
      start: 2,
      endExclusive: 6,
      totalBytes: 10,
      nextOffset: 6,
      truncation: {
        truncated: true,
        maximumBytes: 64 * 1024,
        observedAtMs: 9,
      },
    },
  );
});

test('returns unknown truncation and a stable empty range beyond the snapshot', async (t) => {
  const value = await fixture(t);
  const result = await new LocalRunAttemptLogRangeReader(value.root).read(
    identity,
    { offset: 99, length: 4 },
  );
  assert.equal(result.status, 'available');
  assert.equal(result.content.byteLength, 0);
  assert.equal(result.start, 10);
  assert.equal(result.endExclusive, 10);
  assert.equal(result.totalBytes, 10);
  assert.equal(result.nextOffset, undefined);
  assert.deepEqual(result.truncation, { truncated: 'unknown' });
});

test('treats absent root, shard and log as missing', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-log-missing-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'artifacts');
  const reader = new LocalRunAttemptLogRangeReader(root);
  assert.deepEqual(await reader.read(identity, { offset: 0, length: 1 }), {
    status: 'missing',
  });
  await fs.mkdir(root, { mode: 0o700 });
  assert.deepEqual(await reader.read(identity, { offset: 0, length: 1 }), {
    status: 'missing',
  });
  const shard = path.join(root, 'aa');
  await fs.mkdir(shard, { mode: 0o700 });
  assert.deepEqual(await reader.read(identity, { offset: 0, length: 1 }), {
    status: 'missing',
  });
});

test('fails closed for symlink targets and widened file permissions', async (t) => {
  const symlink = await fixture(t);
  await fs.rm(symlink.log);
  await fs.symlink(path.join(symlink.parent, 'outside'), symlink.log);
  await assert.rejects(
    new LocalRunAttemptLogRangeReader(symlink.root).read(identity, {
      offset: 0,
      length: 1,
    }),
    LocalRunAttemptLogRangeReadError,
  );

  const widened = await fixture(t);
  await fs.chmod(widened.log, 0o644);
  await assert.rejects(
    new LocalRunAttemptLogRangeReader(widened.root).read(identity, {
      offset: 0,
      length: 1,
    }),
    LocalRunAttemptLogRangeReadError,
  );
});

test('fails closed for truncation identity drift and an aborted request', async (t) => {
  const value = await fixture(t);
  await fact(value.shard, { attemptId: 'attempt_other' });
  const reader = new LocalRunAttemptLogRangeReader(value.root);
  await assert.rejects(
    reader.read(identity, { offset: 0, length: 1 }),
    (error) =>
      error instanceof LocalRunAttemptLogRangeReadError &&
      error.reason === 'integrity_mismatch',
  );
  const abort = new AbortController();
  abort.abort(new Error('cancelled'));
  await assert.rejects(
    reader.read(identity, { offset: 0, length: 1 }, abort.signal),
    /cancelled/,
  );
});
