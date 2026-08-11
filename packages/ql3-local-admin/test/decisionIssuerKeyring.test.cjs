const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  LegacyCrontabDecisionIssuerKeyringConflictError,
  LegacyCrontabDecisionIssuerKeyringFileProvider,
  LegacyCrontabDecisionIssuerKeyringUnavailableError,
  MAX_LEGACY_CRONTAB_DECISION_ISSUER_KEYS,
  provisionLegacyCrontabDecisionIssuerKeyring,
  rotateLegacyCrontabDecisionIssuerKeyring,
} = require('../dist/legacy-adoption/legacyCrontabDecisionIssuerKeyring');

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-adoption-issuer-keyring-'),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, filePath: path.join(root, 'issuer.keyring') };
}

test('provisions one private dedicated key and rotates with exact replay fences', async (t) => {
  const { filePath } = fixture(t);
  const initial = await provisionLegacyCrontabDecisionIssuerKeyring(filePath);
  assert.equal(initial.schemaVersion, 1);
  assert.equal(
    initial.kind,
    'qinglong3-legacy-crontab-decision-issuer-keyring-summary',
  );
  assert.equal(initial.keyCount, 1);
  assert.match(initial.activeKeyId, /^qladk-/);
  assert.match(initial.keyringDigest, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  const provider = new LegacyCrontabDecisionIssuerKeyringFileProvider(filePath);
  const active = await provider.active();
  assert.equal(active.keyId, initial.activeKeyId);
  assert.equal(active.key.byteLength, 32);

  const rotated = await rotateLegacyCrontabDecisionIssuerKeyring({
    filePath,
    expectedActiveKeyId: initial.activeKeyId,
    expectedKeyringDigest: initial.keyringDigest,
  });
  assert.equal(rotated.keyCount, 2);
  assert.notEqual(rotated.activeKeyId, initial.activeKeyId);
  assert.notEqual(rotated.keyringDigest, initial.keyringDigest);
  assert.equal((await provider.active()).keyId, rotated.activeKeyId);
  assert.equal(
    (await provider.resolve(initial.activeKeyId)).keyId,
    active.keyId,
  );

  await assert.rejects(
    rotateLegacyCrontabDecisionIssuerKeyring({
      filePath,
      expectedActiveKeyId: initial.activeKeyId,
      expectedKeyringDigest: initial.keyringDigest,
    }),
    LegacyCrontabDecisionIssuerKeyringConflictError,
  );
});

test('never replaces an existing keyring and leaves another rotation lock intact', async (t) => {
  const { filePath } = fixture(t);
  const initial = await provisionLegacyCrontabDecisionIssuerKeyring(filePath);
  const before = fs.readFileSync(filePath);
  await assert.rejects(
    provisionLegacyCrontabDecisionIssuerKeyring(filePath),
    LegacyCrontabDecisionIssuerKeyringConflictError,
  );
  assert.deepEqual(fs.readFileSync(filePath), before);

  const lockPath = `${filePath}.lock`;
  fs.writeFileSync(lockPath, '', { mode: 0o600, flag: 'wx' });
  await assert.rejects(
    rotateLegacyCrontabDecisionIssuerKeyring({
      filePath,
      expectedActiveKeyId: initial.activeKeyId,
      expectedKeyringDigest: initial.keyringDigest,
    }),
    LegacyCrontabDecisionIssuerKeyringUnavailableError,
  );
  assert.equal(fs.existsSync(lockPath), true);
});

test('fails closed for broad files, tampering, symlinks and parent replacement', async (t) => {
  const { root, filePath } = fixture(t);
  await provisionLegacyCrontabDecisionIssuerKeyring(filePath);
  const provider = new LegacyCrontabDecisionIssuerKeyringFileProvider(filePath);

  fs.chmodSync(filePath, 0o644);
  await assert.rejects(
    provider.active(),
    LegacyCrontabDecisionIssuerKeyringUnavailableError,
  );
  fs.chmodSync(filePath, 0o600);

  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  manifest.keys[manifest.activeKeyId] = 'not-canonical-key-material';
  fs.writeFileSync(filePath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await assert.rejects(
    provider.active(),
    LegacyCrontabDecisionIssuerKeyringUnavailableError,
  );

  const other = path.join(root, 'other.keyring');
  await provisionLegacyCrontabDecisionIssuerKeyring(other);
  const link = path.join(root, 'link.keyring');
  fs.symlinkSync(other, link);
  await assert.rejects(
    new LegacyCrontabDecisionIssuerKeyringFileProvider(link).active(),
    LegacyCrontabDecisionIssuerKeyringUnavailableError,
  );

  const moved = `${root}-moved`;
  fs.renameSync(root, moved);
  fs.mkdirSync(root, { mode: 0o700 });
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  await assert.rejects(
    provider.active(),
    LegacyCrontabDecisionIssuerKeyringUnavailableError,
  );
});

test('retains at most eight verification keys', async (t) => {
  const { filePath } = fixture(t);
  let summary = await provisionLegacyCrontabDecisionIssuerKeyring(filePath);
  while (summary.keyCount < MAX_LEGACY_CRONTAB_DECISION_ISSUER_KEYS) {
    summary = await rotateLegacyCrontabDecisionIssuerKeyring({
      filePath,
      expectedActiveKeyId: summary.activeKeyId,
      expectedKeyringDigest: summary.keyringDigest,
    });
  }
  assert.equal(summary.keyCount, MAX_LEGACY_CRONTAB_DECISION_ISSUER_KEYS);
  await assert.rejects(
    rotateLegacyCrontabDecisionIssuerKeyring({
      filePath,
      expectedActiveKeyId: summary.activeKeyId,
      expectedKeyringDigest: summary.keyringDigest,
    }),
    LegacyCrontabDecisionIssuerKeyringUnavailableError,
  );
});
