const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PluginPackagePromptOutputKeyRetirementConflictError,
} = require('../dist/prompt-output/key-management/pluginPackagePromptOutputKeyRetirement.js');
const {
  pluginPackagePromptOutputKeyringCatalogDigest,
  rotatePluginPackagePromptOutputKeyringManifest,
} = require('../dist/prompt-output/key-management/pluginPackagePromptOutputKeyringManifest.js');

function initial() {
  return Object.freeze({
    schema: 'qinglong/plugin-package-prompt-output-file-keyring@v1',
    generation: 1,
    activeKeyId: 'prompt-key-one',
    keys: Object.freeze({
      'prompt-key-one': Buffer.alloc(32, 0x11).toString('base64url'),
    }),
    retirements: Object.freeze({}),
  });
}

function request(manifest, material = Buffer.alloc(32, 0x22)) {
  return {
    expectedActiveKeyId: 'prompt-key-one',
    expectedCatalogDigest:
      pluginPackagePromptOutputKeyringCatalogDigest(manifest),
    newKeyId: 'prompt-key-two',
    material,
  };
}

test('rotates staged material while retaining history and exactly replays', () => {
  const before = initial();
  const staged = Buffer.alloc(32, 0x22);
  const rotated = rotatePluginPackagePromptOutputKeyringManifest(
    before,
    request(before, staged),
  );
  assert.equal(rotated.changed, true);
  assert.equal(rotated.state.generation, 2);
  assert.equal(rotated.state.previousActiveKeyId, 'prompt-key-one');
  assert.equal(rotated.state.activeKeyId, 'prompt-key-two');
  assert.deepEqual(Object.keys(rotated.manifest.keys).sort(), [
    'prompt-key-one',
    'prompt-key-two',
  ]);
  assert.equal(
    rotated.manifest.keys['prompt-key-one'],
    before.keys['prompt-key-one'],
  );
  assert.deepEqual(staged, Buffer.alloc(32, 0x22));

  const replay = rotatePluginPackagePromptOutputKeyringManifest(
    rotated.manifest,
    request(before, staged),
  );
  assert.equal(replay.changed, false);
  assert.deepEqual(replay.state, rotated.state);
  assert.equal(replay.manifest, rotated.manifest);
});

test('rejects stale winners, changed material and key identity reuse', () => {
  const before = initial();
  const operation = request(before);
  const rotated = rotatePluginPackagePromptOutputKeyringManifest(
    before,
    operation,
  );
  for (const [manifest, candidate] of [
    [rotated.manifest, { ...operation, material: Buffer.alloc(32, 0x33) }],
    [before, { ...operation, expectedCatalogDigest: '0'.repeat(64) }],
    [before, { ...operation, newKeyId: 'prompt-key-one' }],
  ]) {
    assert.throws(
      () => rotatePluginPackagePromptOutputKeyringManifest(manifest, candidate),
      (error) =>
        error instanceof PluginPackagePromptOutputKeyRetirementConflictError ||
        error.code === 'PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_INVALID',
    );
  }
});
