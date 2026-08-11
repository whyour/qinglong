const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PluginPackagePromptOutputFileKeyring,
  provisionPluginPackagePromptOutputFileKeyring,
  rotatePluginPackagePromptOutputFileKeyring,
} = require('../dist/prompt-output/key-management/pluginPackagePromptOutputFileKeyring.js');
const {
  PluginPackagePromptOutputKeyRetirementConflictError,
  PluginPackagePromptOutputKeyRetirementUnavailableError,
  createPluginPackagePromptOutputKeyRetirementPreparation,
} = require('../dist/prompt-output/key-management/pluginPackagePromptOutputKeyRetirement.js');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-output-keys-'));
  fs.chmodSync(directory, 0o700);
  const filePath = path.join(directory, 'prompt-output-keyring.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, filePath };
}

function preparation(material, overrides = {}) {
  return createPluginPackagePromptOutputKeyRetirementPreparation({
    keyId: material.keyId,
    retirementId: 'retirement-a',
    requestId: 'request-a',
    mutationId: 'mutation-a',
    catalogDigest: material.catalogDigest,
    materialProof: material.materialProof,
    preparedAtMs: 10_000,
    ...overrides,
  });
}

test('file keyring rotates then retires one inactive key with exact recovery', async (t) => {
  const { filePath } = fixture(t);
  const initial = await provisionPluginPackagePromptOutputFileKeyring(filePath);
  assert.equal(initial.generation, 1);
  assert.equal(initial.keyIds.length, 1);
  assert.deepEqual(initial.retiredKeyIds, []);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  const keyring = new PluginPackagePromptOutputFileKeyring(filePath);
  const firstMaterial = await keyring.active();
  assert.equal(firstMaterial.keyId, initial.activeKeyId);
  assert.equal(firstMaterial.key.length, 32);
  firstMaterial.key.fill(0);

  const rotated = await rotatePluginPackagePromptOutputFileKeyring({
    filePath,
    expectedActiveKeyId: initial.activeKeyId,
    expectedCatalogDigest: initial.catalogDigest,
  });
  assert.equal(rotated.generation, 2);
  assert.notEqual(rotated.activeKeyId, initial.activeKeyId);
  assert.deepEqual(
    [...rotated.keyIds].sort(),
    [initial.activeKeyId, rotated.activeKeyId].sort(),
  );
  const inactive = await keyring.inspect(initial.activeKeyId);
  assert.equal(inactive.state, 'inactive');
  const prepared = preparation(inactive);
  const retired = await keyring.retire({ preparation: prepared });
  assert.equal(retired.state, 'absent');
  assert.deepEqual(await keyring.inspect(initial.activeKeyId), retired);
  assert.deepEqual(await keyring.retire({ preparation: prepared }), retired);
  assert.equal(await keyring.resolve(initial.activeKeyId), null);
  const final = await keyring.summary();
  assert.equal(final.generation, 3);
  assert.deepEqual(final.keyIds, [rotated.activeKeyId]);
  assert.deepEqual(final.retiredKeyIds, [initial.activeKeyId]);
  const active = await keyring.active();
  assert.equal(active.keyId, rotated.activeKeyId);
  active.key.fill(0);
});

test('file keyring rejects active, stale and corrupt retirement authority', async (t) => {
  const { directory, filePath } = fixture(t);
  const initial = await provisionPluginPackagePromptOutputFileKeyring(filePath);
  const keyring = new PluginPackagePromptOutputFileKeyring(filePath);
  const active = await keyring.inspect(initial.activeKeyId);
  assert.equal(active.state, 'active');
  await assert.rejects(
    keyring.retire({ preparation: preparation(active) }),
    PluginPackagePromptOutputKeyRetirementConflictError,
  );

  const rotated = await rotatePluginPackagePromptOutputFileKeyring({
    filePath,
    expectedActiveKeyId: initial.activeKeyId,
    expectedCatalogDigest: initial.catalogDigest,
  });
  const inactive = await keyring.inspect(initial.activeKeyId);
  await assert.rejects(
    keyring.retire({
      preparation: preparation(inactive, { catalogDigest: 'f'.repeat(64) }),
    }),
    PluginPackagePromptOutputKeyRetirementConflictError,
  );

  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(lockPath, { mode: 0o700 });
  fs.writeFileSync(
    path.join(lockPath, 'owner.json'),
    `${JSON.stringify({ pid: 99_999_999, token: 'dead' })}\n`,
    { mode: 0o600 },
  );
  const retired = await keyring.retire({ preparation: preparation(inactive) });
  assert.equal(retired.state, 'absent');
  assert.equal(fs.existsSync(lockPath), false);

  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  manifest.retirements[initial.activeKeyId].absenceProof = '0'.repeat(64);
  fs.writeFileSync(filePath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await assert.rejects(
    keyring.inspect(initial.activeKeyId),
    PluginPackagePromptOutputKeyRetirementUnavailableError,
  );
  assert.equal(rotated.generation, 2);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
});
