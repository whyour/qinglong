const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const {
  PluginPackagePromptOutputFileKeyring,
  provisionPluginPackagePromptOutputFileKeyring,
  rotatePluginPackagePromptOutputFileKeyring,
} = require('../../ql3-ai/dist/prompt-output/key-management/pluginPackagePromptOutputFileKeyring.js');
const {
  setupScenario,
} = require('../../ql3-ai/test/fixtures/pluginPackagePromptCrashFixture.cjs');
const {
  openLocalOwnerPromptOutputKeyRetirement,
} = require('../dist/prompt-output-maintenance/promptOutputKeyRetirement.js');

test('Local Owner retires one inactive Prompt output key and exactly replays', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-owner-output-key-retirement-'),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'runtime.sqlite');
  const keyringPath = path.join(directory, 'prompt-output-keyring.json');
  await setupScenario({
    databasePath,
    statePath: path.join(directory, 'fixture-state.json'),
    profile: 'edge',
    operation: 'admission',
  });
  const provisioned =
    await provisionPluginPackagePromptOutputFileKeyring(keyringPath);
  await rotatePluginPackagePromptOutputFileKeyring({
    filePath: keyringPath,
    expectedActiveKeyId: provisioned.activeKeyId,
    expectedCatalogDigest: provisioned.catalogDigest,
  });

  const authority = await openLocalOwnerPromptOutputKeyRetirement({
    databasePath,
    profile: 'edge',
    keyringPath,
  });
  t.after(() => authority.close());
  const request = {
    keyId: provisioned.activeKeyId,
    retirementId: 'owner-retirement-a',
    requestId: 'owner-retirement-request-a',
    mutationId: 'owner-retirement-mutation-a',
  };
  const retired = await authority.retire(request);
  assert.equal(retired.status, 'completed');
  assert.equal((await authority.retire(request)).status, 'existing');
  assert.equal(retired.keyId, provisioned.activeKeyId);
  assert.equal(
    (await new PluginPackagePromptOutputFileKeyring(keyringPath).inspect(
      provisioned.activeKeyId,
    )).state,
    'absent',
  );

  await authority.close();
  const client = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      client
        .prepare(
          `SELECT count(*) AS count
             FROM "ModelInvocationPromptOutputKeyRetirementPreparations"`,
        )
        .get().count,
      1,
    );
    assert.equal(
      client
        .prepare(
          `SELECT count(*) AS count
             FROM "ModelInvocationPromptOutputKeyRetirementCompletions"`,
        )
        .get().count,
      1,
    );
  } finally {
    client.close();
  }
});
