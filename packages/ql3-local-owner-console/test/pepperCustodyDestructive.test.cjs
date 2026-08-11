const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  LocalOwnerPepperUnavailableError,
  localOwnerPepperKeyPath,
  provisionLocalOwnerPepperKey,
} = require('../dist/pepper-custody');
const { destroyLocalOwnerPepperKey } = require(
  '../dist/pepper-custody/destructive',
);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-pepper-gc-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('destroys one exact key durably and replays the same absence proof', (t) => {
  const keyringDirectory = fixture(t);
  const pepperKeyId = 'owner-key-retired';
  const material = provisionLocalOwnerPepperKey({
    keyringDirectory,
    pepperKeyId,
    randomBytes: () => Buffer.alloc(32, 23),
  });
  const options = {
    keyringDirectory,
    pepperKeyId,
    materialRole: 'runtime',
    expectedMaterialDigest: material.digest,
    prepareMutationId: '00000000-0000-4000-8000-000000000501',
  };
  const destroyed = destroyLocalOwnerPepperKey(options);
  assert.equal(destroyed.status, 'destroyed');
  assert.equal(
    fs.existsSync(localOwnerPepperKeyPath(keyringDirectory, pepperKeyId)),
    false,
  );
  const replay = destroyLocalOwnerPepperKey(options);
  assert.equal(replay.status, 'absent');
  assert.equal(replay.destructionProofDigest, destroyed.destructionProofDigest);
});

test('refuses digest drift without deleting the material', (t) => {
  const keyringDirectory = fixture(t);
  const pepperKeyId = 'owner-key-retired';
  provisionLocalOwnerPepperKey({
    keyringDirectory,
    pepperKeyId,
    randomBytes: () => Buffer.alloc(32, 29),
  });
  assert.throws(
    () =>
      destroyLocalOwnerPepperKey({
        keyringDirectory,
        pepperKeyId,
        materialRole: 'runtime',
        expectedMaterialDigest: '0'.repeat(64),
        prepareMutationId: '00000000-0000-4000-8000-000000000502',
      }),
    LocalOwnerPepperUnavailableError,
  );
  assert.equal(
    fs.existsSync(localOwnerPepperKeyPath(keyringDirectory, pepperKeyId)),
    true,
  );
});
