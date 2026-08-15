const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  CLUSTER_TOOL_INVOCATION_KEYRING_MANIFEST_SCHEMA,
  ClusterToolInvocationProjectedKeyring,
  ClusterToolInvocationProjectedKeyringUnavailableError,
  canonicalClusterToolInvocationKeyringManifest,
  createClusterToolInvocationProjectedKeyring,
} = require('@qinglong/cluster-control/trusted-tool-invocation-keyring');

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql3-tool-invocation-keyring-'),
  );
  roots.push(root);
  return root;
}

async function publish(root, generationName, manifest, mode = 0o440) {
  const generation = path.join(root, generationName);
  await fs.mkdir(generation, { mode: 0o750 });
  const target = path.join(generation, 'keyring.json');
  await fs.writeFile(
    target,
    canonicalClusterToolInvocationKeyringManifest(manifest),
    { mode },
  );
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

function manifest(activeKeyId, keys) {
  return Object.freeze({
    schema: CLUSTER_TOOL_INVOCATION_KEYRING_MANIFEST_SCHEMA,
    activeKeyId,
    keys: Object.freeze(keys),
  });
}

test('projected Tool invocation keyring rotates active material without caching', async () => {
  const root = await tempRoot();
  const keyOne = Buffer.alloc(32, 0x41);
  const keyTwo = Buffer.alloc(32, 0x42);
  await publish(
    root,
    '..2026_08_15_01',
    manifest('invocation-key-one', {
      'invocation-key-one': keyOne.toString('base64url'),
    }),
  );
  const provider = await createClusterToolInvocationProjectedKeyring({
    rootDirectory: root,
  });
  const first = await provider.active();
  assert.equal(first.keyId, 'invocation-key-one');
  assert.deepEqual(Buffer.from(first.key), keyOne);
  first.key.fill(0);

  await publish(
    root,
    '..2026_08_15_02',
    manifest('invocation-key-two', {
      'invocation-key-one': keyOne.toString('base64url'),
      'invocation-key-two': keyTwo.toString('base64url'),
    }),
  );
  const second = await provider.active();
  assert.equal(second.keyId, 'invocation-key-two');
  assert.deepEqual(Buffer.from(second.key), keyTwo);
  second.key.fill(0);
  const historical = await provider.resolve('invocation-key-one');
  assert.ok(historical);
  assert.deepEqual(Buffer.from(historical.key), keyOne);
  historical.key.fill(0);
  assert.equal(await provider.resolve('missing-key'), null);
});

test('projected Tool invocation keyring rejects missing active and writable material', async () => {
  const root = await tempRoot();
  const key = Buffer.alloc(32, 0x51).toString('base64url');
  assert.throws(
    () =>
      canonicalClusterToolInvocationKeyringManifest(
        manifest('missing-key', { 'invocation-key-one': key }),
      ),
    TypeError,
  );

  await publish(
    root,
    '..2026_08_15_01',
    manifest('invocation-key-one', { 'invocation-key-one': key }),
    0o640,
  );
  await assert.rejects(
    () =>
      new ClusterToolInvocationProjectedKeyring({
        rootDirectory: root,
      }).verify(),
    ClusterToolInvocationProjectedKeyringUnavailableError,
  );
});
