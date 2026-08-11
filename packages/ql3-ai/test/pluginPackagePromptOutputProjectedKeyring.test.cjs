const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  PluginPackagePromptOutputProjectedKeyring,
  PluginPackagePromptOutputProjectedKeyringUnavailableError,
  createPluginPackagePromptOutputProjectedKeyring,
} = require('../dist/prompt-output/key-management/pluginPackagePromptOutputProjectedKeyring.js');
const {
  PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_MANIFEST_SCHEMA,
  canonicalPluginPackagePromptOutputKeyringManifest,
} = require('../dist/prompt-output/key-management/pluginPackagePromptOutputKeyringManifest.js');

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function manifest(generation, activeKeyId, keys) {
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_OUTPUT_KEYRING_MANIFEST_SCHEMA,
    generation,
    activeKeyId,
    keys: Object.freeze(keys),
    retirements: Object.freeze({}),
  });
}

async function tempRoot() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql3-projected-keyring-'),
  );
  roots.push(root);
  return root;
}

async function publish(root, generationName, bytes, mode = 0o440) {
  const generation = path.join(root, generationName);
  await fs.mkdir(generation, { mode: 0o750 });
  const target = path.join(generation, 'keyring.json');
  await fs.writeFile(target, bytes, { mode });
  await fs.chmod(target, mode);
  const next = path.join(root, '..data-next');
  await fs.symlink(generationName, next);
  await fs.rename(next, path.join(root, '..data'));
  try {
    await fs.symlink('..data/keyring.json', path.join(root, 'keyring.json'));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

test('projected keyring follows bounded Kubernetes atomic rotation without caching', async () => {
  const root = await tempRoot();
  const keyOne = Buffer.alloc(32, 0x11).toString('base64url');
  const keyTwo = Buffer.alloc(32, 0x22).toString('base64url');
  await publish(
    root,
    '..2026_08_02_01',
    canonicalPluginPackagePromptOutputKeyringManifest(
      manifest(1, 'prompt-key-one', { 'prompt-key-one': keyOne }),
    ),
  );

  const provider = await createPluginPackagePromptOutputProjectedKeyring({
    rootDirectory: root,
  });
  const first = await provider.active();
  assert.equal(first.keyId, 'prompt-key-one');
  assert.deepEqual(Buffer.from(first.key), Buffer.alloc(32, 0x11));
  first.key.fill(0);

  await publish(
    root,
    '..2026_08_02_02',
    canonicalPluginPackagePromptOutputKeyringManifest(
      manifest(2, 'prompt-key-two', {
        'prompt-key-one': keyOne,
        'prompt-key-two': keyTwo,
      }),
    ),
  );
  const second = await provider.active();
  assert.equal(second.keyId, 'prompt-key-two');
  assert.deepEqual(Buffer.from(second.key), Buffer.alloc(32, 0x22));
  const historical = await provider.resolve('prompt-key-one');
  assert.ok(historical);
  assert.deepEqual(Buffer.from(historical.key), Buffer.alloc(32, 0x11));
  second.key.fill(0);
  historical.key.fill(0);
});

test('projected keyring rejects noncanonical, writable and escaped material', async () => {
  const key = Buffer.alloc(32, 0x33).toString('base64url');
  const value = manifest(1, 'prompt-key-one', { 'prompt-key-one': key });

  const noncanonicalRoot = await tempRoot();
  await publish(
    noncanonicalRoot,
    '..2026_08_02_01',
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
  );
  await assert.rejects(
    () =>
      createPluginPackagePromptOutputProjectedKeyring({
        rootDirectory: noncanonicalRoot,
      }),
    PluginPackagePromptOutputProjectedKeyringUnavailableError,
  );

  const writableRoot = await tempRoot();
  await publish(
    writableRoot,
    '..2026_08_02_01',
    canonicalPluginPackagePromptOutputKeyringManifest(value),
    0o640,
  );
  await assert.rejects(
    () =>
      new PluginPackagePromptOutputProjectedKeyring({
        rootDirectory: writableRoot,
      }).active(),
    PluginPackagePromptOutputProjectedKeyringUnavailableError,
  );

  const escapedRoot = await tempRoot();
  const externalRoot = await tempRoot();
  const external = path.join(externalRoot, 'keyring.json');
  await fs.writeFile(
    external,
    canonicalPluginPackagePromptOutputKeyringManifest(value),
    { mode: 0o440 },
  );
  await fs.symlink(external, path.join(escapedRoot, 'keyring.json'));
  await assert.rejects(
    () =>
      new PluginPackagePromptOutputProjectedKeyring({
        rootDirectory: escapedRoot,
      }).verify(),
    PluginPackagePromptOutputProjectedKeyringUnavailableError,
  );
});

test('projected keyring rejects ambiguous roots and file names', async () => {
  const root = await tempRoot();
  const rootLink = `${root}-link`;
  roots.push(rootLink);
  await fs.symlink(root, rootLink);
  await assert.rejects(
    () =>
      new PluginPackagePromptOutputProjectedKeyring({
        rootDirectory: rootLink,
      }).verify(),
    PluginPackagePromptOutputProjectedKeyringUnavailableError,
  );
  assert.throws(
    () =>
      new PluginPackagePromptOutputProjectedKeyring({
        rootDirectory: root,
        dataFileName: '../keyring.json',
      }),
    PluginPackagePromptOutputProjectedKeyringUnavailableError,
  );
});
