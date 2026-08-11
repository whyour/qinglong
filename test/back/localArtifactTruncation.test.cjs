require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  LocalArtifactTruncationFactStore,
  UnsafeLocalArtifactTruncationFactError,
  localArtifactTruncationFactFileName,
} = require('../../back/runtime/adapters/fs/localArtifactTruncationFactStore');
const {
  decodeLocalArtifactTruncationFact,
  encodeLocalArtifactTruncationFact,
} = require('../../back/runtime/domain/localArtifactTruncation');

const LOG_ARTIFACT_ID = `local-${'c'.repeat(30)}`;
const OTHER_ARTIFACT_ID = `local-${'d'.repeat(30)}`;
const FACT = {
  schemaVersion: 1,
  runId: '019f7500-0000-7000-8000-000000000001',
  attemptId: '019f7500-0000-7000-8000-000000000002',
  logArtifactId: LOG_ARTIFACT_ID,
  maximumBytes: 64 * 1024,
  quotaReached: true,
  observedAtMs: 1_800_000_000_000,
};

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-truncation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o700);
  return root;
}

test('round-trips one exact canonical truncation fact', () => {
  const encoded = encodeLocalArtifactTruncationFact(FACT);
  assert.deepEqual(decodeLocalArtifactTruncationFact(encoded), FACT);
  assert.throws(
    () =>
      decodeLocalArtifactTruncationFact(
        JSON.stringify({ ...FACT, unknown: true }),
      ),
    /shape is invalid/,
  );
  assert.throws(
    () =>
      decodeLocalArtifactTruncationFact(
        JSON.stringify({ attemptId: FACT.attemptId, ...FACT }),
      ),
    /not canonical/,
  );
  assert.throws(
    () => encodeLocalArtifactTruncationFact({ ...FACT, maximumBytes: 1 }),
    /maximumBytes is invalid/,
  );
});

test('reads only the exact private Artifact fact and handles absence', async (t) => {
  const root = await temporaryRoot(t);
  const store = new LocalArtifactTruncationFactStore(root);
  assert.equal(await store.read(LOG_ARTIFACT_ID), null);
  const directory = path.join(root, LOG_ARTIFACT_ID.slice(6, 8));
  await fs.mkdir(directory, { mode: 0o700 });
  const target = path.join(
    directory,
    localArtifactTruncationFactFileName(LOG_ARTIFACT_ID),
  );
  await fs.writeFile(target, encodeLocalArtifactTruncationFact(FACT), {
    mode: 0o600,
  });
  assert.deepEqual(await store.read(LOG_ARTIFACT_ID), FACT);

  await fs.writeFile(
    target,
    encodeLocalArtifactTruncationFact({
      ...FACT,
      logArtifactId: OTHER_ARTIFACT_ID,
    }),
  );
  await assert.rejects(
    store.read(LOG_ARTIFACT_ID),
    UnsafeLocalArtifactTruncationFactError,
  );
});

test('refuses symlink files and shard escapes', async (t) => {
  const root = await temporaryRoot(t);
  const store = new LocalArtifactTruncationFactStore(root);
  const outside = path.join(root, 'outside.json');
  await fs.writeFile(outside, encodeLocalArtifactTruncationFact(FACT));
  const directory = path.join(root, LOG_ARTIFACT_ID.slice(6, 8));
  await fs.mkdir(directory, { mode: 0o700 });
  const target = path.join(
    directory,
    localArtifactTruncationFactFileName(LOG_ARTIFACT_ID),
  );
  await fs.symlink(outside, target);
  await assert.rejects(
    store.read(LOG_ARTIFACT_ID),
    UnsafeLocalArtifactTruncationFactError,
  );
  await fs.unlink(target);
  await fs.rmdir(directory);
  await fs.symlink(path.dirname(outside), directory);
  await assert.rejects(
    store.read(LOG_ARTIFACT_ID),
    UnsafeLocalArtifactTruncationFactError,
  );
});
