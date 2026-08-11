const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  LocalPluginPackagePromptOutputKeyRetirementRepository,
  assertLocalPluginPackagePromptOutputKeyNotRetiring,
} = require('../dist/prompt-output/storage/localPluginPackagePromptOutputKeyRetirementRepository.js');
const {
  PluginPackagePromptOutputKeyRetirementConflictError,
  PluginPackagePromptOutputKeyRetirementUnavailableError,
  createPluginPackagePromptOutputKeyRetirementPreparation,
  pluginPackagePromptOutputKeyRetirementAbsenceProof,
} = require('../dist/prompt-output/key-management/pluginPackagePromptOutputKeyRetirement.js');
const {
  setupScenario,
} = require('./fixtures/pluginPackagePromptCrashFixture.cjs');

const digest = (value) => createHash('sha256').update(value).digest('hex');

async function harness(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-prompt-output-key-retirement-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'runtime.sqlite');
  await setupScenario({
    databasePath,
    statePath: path.join(directory, 'state.json'),
    profile: 'edge',
    operation: 'admission',
  });
  const client = new DatabaseSync(databasePath);
  client.exec('PRAGMA foreign_keys = ON');
  t.after(() => client.close());
  const authority = {
    client,
    async enqueue(work) {
      return work();
    },
  };
  let nowMs = 100;
  return {
    client,
    repository: new LocalPluginPackagePromptOutputKeyRetirementRepository({
      authority,
      now: () => nowMs,
    }),
    setNow(value) {
      nowMs = value;
    },
  };
}

function command() {
  return {
    keyId: 'prompt-output-key-old',
    retirementId: 'retire-prompt-output-key-old',
    requestId: 'request-retire-prompt-output-key-old',
    mutationId: 'mutation-retire-prompt-output-key-old',
    catalogDigest: digest('catalog-before'),
    materialProof: digest('material-old'),
  };
}

test('SQLite appends one retirement preparation and completion with exact replay', async (t) => {
  const value = await harness(t);
  const prepared = await value.repository.prepare(command());
  assert.equal(prepared.status, 'created');
  assert.equal(prepared.preparation.preparedAtMs, 100);
  assert.throws(
    () =>
      assertLocalPluginPackagePromptOutputKeyNotRetiring(
        value.client,
        command().keyId,
      ),
    PluginPackagePromptOutputKeyRetirementConflictError,
  );
  const retiredCatalogDigest = digest('catalog-after');
  const absenceProof = pluginPackagePromptOutputKeyRetirementAbsenceProof(
    prepared.preparation,
    retiredCatalogDigest,
  );
  value.setNow(200);
  const completed = await value.repository.complete({
    preparation: prepared.preparation,
    retiredCatalogDigest,
    absenceProof,
  });
  assert.equal(completed.status, 'created');
  assert.equal(completed.completion.completedAtMs, 200);
  value.setNow(999);
  assert.equal((await value.repository.prepare(command())).status, 'existing');
  assert.equal(
    (
      await value.repository.complete({
        preparation: prepared.preparation,
        retiredCatalogDigest,
        absenceProof,
      })
    ).status,
    'existing',
  );
  assert.deepEqual(await value.repository.find(command().keyId), {
    preparation: prepared.preparation,
    completion: completed.completion,
  });
});

test('SQLite rejects detached completion, command drift and corrupt durable JSON', async (t) => {
  const value = await harness(t);
  const detached = createPluginPackagePromptOutputKeyRetirementPreparation({
    ...command(),
    preparedAtMs: 100,
  });
  await assert.rejects(
    value.repository.complete({
      preparation: detached,
      retiredCatalogDigest: digest('catalog-after'),
      absenceProof: digest('absence'),
    }),
    PluginPackagePromptOutputKeyRetirementConflictError,
  );
  const prepared = await value.repository.prepare(command());
  await assert.rejects(
    value.repository.prepare({ ...command(), requestId: 'drifted-request' }),
    PluginPackagePromptOutputKeyRetirementConflictError,
  );
  value.client.exec('PRAGMA ignore_check_constraints = ON');
  value.client
    .prepare(
      `UPDATE "ModelInvocationPromptOutputKeyRetirementPreparations"
          SET preparation_json = '{"corrupt":true}'
        WHERE key_id = ?`,
    )
    .run(prepared.preparation.keyId);
  value.client.exec('PRAGMA ignore_check_constraints = OFF');
  await assert.rejects(
    value.repository.find(prepared.preparation.keyId),
    PluginPackagePromptOutputKeyRetirementUnavailableError,
  );
});
