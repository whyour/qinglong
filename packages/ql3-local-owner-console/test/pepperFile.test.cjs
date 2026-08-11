const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  LocalOwnerPepperConfigurationError,
  LocalOwnerPepperConflictError,
  LocalOwnerPepperUnavailableError,
  backupLocalOwnerPepper,
  inspectLocalOwnerPepper,
  provisionLocalOwnerPepper,
  restoreLocalOwnerPepper,
} = require('../dist/pepper-custody');

function fixture(t) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-owner-pepper-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  const backupRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-owner-pepper-backup-'),
  );
  fs.chmodSync(backupRoot, 0o700);
  t.after(() => {
    fs.rmSync(deploymentRoot, { recursive: true, force: true });
    fs.rmSync(backupRoot, { recursive: true, force: true });
  });
  return {
    deploymentRoot,
    backupRoot,
    pepperPath: path.join(deploymentRoot, 'owner.pepper'),
    backupPath: path.join(backupRoot, 'owner.pepper.backup'),
  };
}

test('provisions one canonical private pepper without replacement', (t) => {
  const value = fixture(t);
  const entropy = Buffer.alloc(32, 41);
  const result = provisionLocalOwnerPepper({
    deploymentRoot: value.deploymentRoot,
    pepperPath: value.pepperPath,
    randomBytes() {
      return entropy;
    },
  });
  assert.equal(result.version, 1);
  assert.equal(result.byteLength, 43);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(value.pepperPath).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(value.pepperPath, 'utf8'),
    Buffer.alloc(32, 41).toString('base64url'),
  );
  assert.equal(entropy.equals(Buffer.alloc(32)), true);
  assert.deepEqual(
    inspectLocalOwnerPepper({
      deploymentRoot: value.deploymentRoot,
      pepperPath: value.pepperPath,
    }),
    result,
  );

  const before = fs.readFileSync(value.pepperPath);
  assert.throws(
    () =>
      provisionLocalOwnerPepper({
        deploymentRoot: value.deploymentRoot,
        pepperPath: value.pepperPath,
      }),
    LocalOwnerPepperConflictError,
  );
  assert.deepEqual(fs.readFileSync(value.pepperPath), before);
});

test('creates an independent no-replace backup and restores only to absence', (t) => {
  const value = fixture(t);
  const provisioned = provisionLocalOwnerPepper({
    deploymentRoot: value.deploymentRoot,
    pepperPath: value.pepperPath,
    randomBytes: () => Buffer.alloc(32, 42),
  });
  const backedUp = backupLocalOwnerPepper(value);
  assert.deepEqual(backedUp, provisioned);
  const pepperStat = fs.statSync(value.pepperPath, { bigint: true });
  const backupStat = fs.statSync(value.backupPath, { bigint: true });
  assert.equal(backupStat.mode & 0o777n, 0o600n);
  assert.notEqual(backupStat.ino, pepperStat.ino);
  assert.deepEqual(
    fs.readFileSync(value.backupPath),
    fs.readFileSync(value.pepperPath),
  );

  fs.unlinkSync(value.pepperPath);
  const restored = restoreLocalOwnerPepper(value);
  assert.deepEqual(restored, provisioned);
  assert.deepEqual(
    fs.readFileSync(value.pepperPath),
    fs.readFileSync(value.backupPath),
  );
  assert.throws(
    () => restoreLocalOwnerPepper(value),
    LocalOwnerPepperConflictError,
  );
});

test('never overwrites a pre-existing backup', (t) => {
  const value = fixture(t);
  provisionLocalOwnerPepper({
    deploymentRoot: value.deploymentRoot,
    pepperPath: value.pepperPath,
    randomBytes: () => Buffer.alloc(32, 43),
  });
  fs.writeFileSync(value.backupPath, 'reserved', { mode: 0o600 });
  assert.throws(
    () => backupLocalOwnerPepper(value),
    LocalOwnerPepperConflictError,
  );
  assert.equal(fs.readFileSync(value.backupPath, 'utf8'), 'reserved');
});

test('fails closed for broad roots, symlink parents and tampered pepper files', (t) => {
  const broad = fixture(t);
  fs.chmodSync(broad.deploymentRoot, 0o755);
  assert.throws(
    () =>
      provisionLocalOwnerPepper({
        deploymentRoot: broad.deploymentRoot,
        pepperPath: broad.pepperPath,
      }),
    LocalOwnerPepperUnavailableError,
  );

  const linked = fixture(t);
  const actual = path.join(linked.deploymentRoot, 'actual');
  fs.mkdirSync(actual, { mode: 0o700 });
  const alias = path.join(linked.deploymentRoot, 'alias');
  fs.symlinkSync(actual, alias);
  assert.throws(
    () =>
      provisionLocalOwnerPepper({
        deploymentRoot: linked.deploymentRoot,
        pepperPath: path.join(alias, 'owner.pepper'),
      }),
    LocalOwnerPepperUnavailableError,
  );

  const tampered = fixture(t);
  provisionLocalOwnerPepper({
    deploymentRoot: tampered.deploymentRoot,
    pepperPath: tampered.pepperPath,
  });
  fs.chmodSync(tampered.pepperPath, 0o644);
  assert.throws(
    () =>
      inspectLocalOwnerPepper({
        deploymentRoot: tampered.deploymentRoot,
        pepperPath: tampered.pepperPath,
      }),
    LocalOwnerPepperUnavailableError,
  );
});

test('rejects invalid entropy and widened options before publishing', (t) => {
  const value = fixture(t);
  assert.throws(
    () =>
      provisionLocalOwnerPepper({
        deploymentRoot: value.deploymentRoot,
        pepperPath: value.pepperPath,
        randomBytes: () => Buffer.alloc(31),
      }),
    LocalOwnerPepperConfigurationError,
  );
  assert.equal(fs.existsSync(value.pepperPath), false);
  assert.throws(
    () =>
      provisionLocalOwnerPepper({
        deploymentRoot: value.deploymentRoot,
        pepperPath: value.pepperPath,
        extra: true,
      }),
    LocalOwnerPepperConfigurationError,
  );
  assert.throws(
    () =>
      provisionLocalOwnerPepper({
        deploymentRoot: value.deploymentRoot,
        pepperPath: value.pepperPath,
        randomBytes() {
          throw new Error('sensitive entropy provider detail');
        },
      }),
    (error) =>
      error instanceof LocalOwnerPepperUnavailableError &&
      error.message === 'Local Owner pepper operation is unavailable',
  );
  assert.equal(fs.existsSync(value.pepperPath), false);
});
