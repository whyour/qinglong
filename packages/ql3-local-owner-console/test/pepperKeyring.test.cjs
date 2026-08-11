const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  LocalOwnerPepperKeyringFileProvider,
  LocalOwnerPepperUnavailableError,
  backupLocalOwnerPepperKey,
  localOwnerPepperKeyPath,
  provisionLocalOwnerPepperKey,
  restoreLocalOwnerPepperKey,
} = require('../dist/pepper-custody');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-owner-keyring-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('loads one exact key without exposing an active filesystem pointer', (t) => {
  const keyringDirectory = fixture(t);
  const summaries = ['owner-key-2', 'owner-key-1'].map((pepperKeyId, index) =>
    provisionLocalOwnerPepperKey({
      keyringDirectory,
      pepperKeyId,
      randomBytes: () => Buffer.alloc(32, index + 1),
    }),
  );
  const provider = new LocalOwnerPepperKeyringFileProvider(keyringDirectory);
  assert.deepEqual(provider.inspect(), {
    version: 1,
    keyIds: ['owner-key-1', 'owner-key-2'],
  });
  assert.equal(provider.resolve('missing-key'), null);
  assert.deepEqual(provider.resolve('owner-key-1').summary, summaries[1]);
  assert.equal(
    path.basename(localOwnerPepperKeyPath(keyringDirectory, 'owner-key-1')),
    `${Buffer.from('owner-key-1').toString('base64url')}.pepper`,
  );
});

test('backs up and restores one exact key without replacement or inode reuse', (t) => {
  const keyringDirectory = fixture(t);
  const backupDirectory = fixture(t);
  const pepperKeyId = 'owner-key-recovery';
  const provisioned = provisionLocalOwnerPepperKey({
    keyringDirectory,
    pepperKeyId,
    randomBytes: () => Buffer.alloc(32, 31),
  });
  assert.deepEqual(
    backupLocalOwnerPepperKey({
      keyringDirectory,
      backupDirectory,
      pepperKeyId,
    }),
    provisioned,
  );
  const sourcePath = localOwnerPepperKeyPath(keyringDirectory, pepperKeyId);
  const backupPath = localOwnerPepperKeyPath(backupDirectory, pepperKeyId);
  assert.notEqual(
    fs.statSync(sourcePath, { bigint: true }).ino,
    fs.statSync(backupPath, { bigint: true }).ino,
  );
  fs.unlinkSync(sourcePath);
  assert.deepEqual(
    restoreLocalOwnerPepperKey({
      keyringDirectory,
      backupDirectory,
      pepperKeyId,
    }),
    provisioned,
  );
  assert.deepEqual(
    new LocalOwnerPepperKeyringFileProvider(keyringDirectory).resolve(
      pepperKeyId,
    ).summary,
    provisioned,
  );
});

test('hard-caps the directory and rejects symlinks or unknown entries', (t) => {
  const keyringDirectory = fixture(t);
  for (let index = 1; index <= 8; index += 1) {
    provisionLocalOwnerPepperKey({
      keyringDirectory,
      pepperKeyId: `owner-key-${index}`,
      randomBytes: () => Buffer.alloc(32, index),
    });
  }
  assert.throws(
    () =>
      provisionLocalOwnerPepperKey({
        keyringDirectory,
        pepperKeyId: 'owner-key-9',
      }),
    LocalOwnerPepperUnavailableError,
  );

  const unsafe = fixture(t);
  fs.symlinkSync(
    localOwnerPepperKeyPath(keyringDirectory, 'owner-key-1'),
    localOwnerPepperKeyPath(unsafe, 'owner-key-1'),
  );
  assert.throws(
    () => new LocalOwnerPepperKeyringFileProvider(unsafe),
    LocalOwnerPepperUnavailableError,
  );
  fs.unlinkSync(localOwnerPepperKeyPath(unsafe, 'owner-key-1'));
  fs.writeFileSync(path.join(unsafe, 'active'), 'owner-key-1', { mode: 0o600 });
  assert.throws(
    () => new LocalOwnerPepperKeyringFileProvider(unsafe),
    LocalOwnerPepperUnavailableError,
  );
});
