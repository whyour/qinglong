const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  LocalRunAttemptLogCapacityProbe,
  LocalRunAttemptLogRetirementError,
  LocalRunAttemptLogRetirementStore,
} = require('../dist/artifact-read/localRunAttemptLogRetirementStore.js');

const ARTIFACT_ID = `local-${'a'.repeat(30)}`;

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-log-retire-'));
  const root = path.join(parent, 'artifacts');
  fs.mkdirSync(root, { mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const directory = path.join(root, 'aa');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return {
    parent,
    root,
    directory,
    target: path.join(directory, `${ARTIFACT_ID}.log`),
    fact: path.join(directory, `.${ARTIFACT_ID}.log.truncated.json`),
  };
}

function candidate() {
  return {
    projectId: 'prj_default',
    runId: 'run_1',
    attemptId: 'attempt_1',
    logArtifactId: ARTIFACT_ID,
    executorType: 'local_process',
    finishedAtMs: 1,
  };
}

function privateFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function fact() {
  return JSON.stringify({
    schemaVersion: 1,
    runId: 'run_1',
    attemptId: 'attempt_1',
    logArtifactId: ARTIFACT_ID,
    maximumBytes: 64 * 1024,
    quotaReached: true,
    observedAtMs: 2,
  });
}

test('deletes only the exact private log and truncation fact', async (t) => {
  const value = fixture(t);
  privateFile(value.target, 'hello');
  privateFile(value.fact, fact());
  privateFile(path.join(value.directory, 'unrelated'), 'keep');

  const retired = await new LocalRunAttemptLogRetirementStore(
    value.root,
  ).retire(candidate());
  assert.deepEqual(retired, {
    disposition: 'deleted',
    byteLength: 5,
    truncation: {
      truncated: true,
      maximumBytes: 64 * 1024,
      observedAtMs: 2,
    },
  });
  assert.equal(fs.existsSync(value.target), false);
  assert.equal(fs.existsSync(value.fact), false);
  assert.equal(fs.existsSync(path.join(value.directory, 'unrelated')), true);
});

test('converges an unlink-before-tombstone crash and removes its orphan fact', async (t) => {
  const value = fixture(t);
  privateFile(value.fact, fact());
  const retired = await new LocalRunAttemptLogRetirementStore(
    value.root,
  ).retire(candidate());
  assert.equal(retired.disposition, 'already_absent');
  assert.equal(retired.byteLength, 0);
  assert.equal(retired.truncation.truncated, true);
  assert.equal(fs.existsSync(value.fact), false);
});

test('fails closed for links, unsafe modes and fact identity drift', async (t) => {
  const cases = [];

  const hardLink = fixture(t);
  privateFile(hardLink.target, 'hello');
  fs.linkSync(hardLink.target, path.join(hardLink.directory, 'second-link'));
  cases.push(hardLink);

  const unsafeMode = fixture(t);
  privateFile(unsafeMode.target, 'hello');
  fs.chmodSync(unsafeMode.target, 0o644);
  cases.push(unsafeMode);

  const drift = fixture(t);
  privateFile(drift.target, 'hello');
  privateFile(drift.fact, fact().replace('"attempt_1"', '"attempt_other"'));
  cases.push(drift);

  for (const value of cases) {
    await assert.rejects(
      new LocalRunAttemptLogRetirementStore(value.root).retire(candidate()),
      LocalRunAttemptLogRetirementError,
    );
    assert.equal(fs.existsSync(value.target), true);
  }
});

test('capacity probe uses the nearest existing parent without creating roots', async (t) => {
  const value = fixture(t);
  const missing = path.join(value.parent, 'future', 'artifacts');
  const snapshot = await new LocalRunAttemptLogCapacityProbe(missing).inspect();
  assert.equal(snapshot.totalBytes > 0n, true);
  assert.equal(snapshot.availableBytes >= 0n, true);
  assert.equal(snapshot.availableBytes <= snapshot.totalBytes, true);
  assert.equal(fs.existsSync(missing), false);
});
