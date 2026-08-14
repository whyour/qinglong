const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  CLUSTER_TOOL_RESULT_KEYRING_MANIFEST_SCHEMA,
  ClusterToolResultProjectedKeyring,
  ClusterToolResultProjectedKeyringUnavailableError,
  canonicalClusterToolResultKeyringManifest,
  createClusterToolResultProjectedKeyring,
} = require('../dist/trusted-tool/key-management/toolResultProjectedKeyring.js');
const {
  toolResultKeyMaterialProof,
} = require('@qinglong/runtime-core/tool-result-key-catalog');

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function manifest(keys) {
  return Object.freeze({
    schema: CLUSTER_TOOL_RESULT_KEYRING_MANIFEST_SCHEMA,
    keys: Object.freeze(keys),
  });
}

async function tempRoot() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql3-tool-result-keyring-'),
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

test('projected Tool result keyring follows atomic rotation without choosing the active catalog key', async () => {
  const root = await tempRoot();
  const keyOneBytes = Buffer.alloc(32, 0x11);
  const keyTwoBytes = Buffer.alloc(32, 0x22);
  const keyOne = keyOneBytes.toString('base64url');
  const keyTwo = keyTwoBytes.toString('base64url');
  await publish(
    root,
    '..2026_08_14_01',
    canonicalClusterToolResultKeyringManifest(
      manifest({ 'result-key-one': keyOne }),
    ),
  );

  const provider = await createClusterToolResultProjectedKeyring({
    rootDirectory: root,
  });
  assert.equal('active' in provider, false);
  const firstSummary = await provider.verify();
  assert.deepEqual(firstSummary.keyIds, ['result-key-one']);
  assert.equal(
    firstSummary.materialProofs['result-key-one'],
    toolResultKeyMaterialProof('result-key-one', keyOneBytes),
  );
  const first = await provider.resolve('result-key-one');
  assert.ok(first);
  assert.deepEqual(Buffer.from(first.key), keyOneBytes);
  first.key.fill(0);

  await publish(
    root,
    '..2026_08_14_02',
    canonicalClusterToolResultKeyringManifest(
      manifest({
        'result-key-two': keyTwo,
        'result-key-one': keyOne,
      }),
    ),
  );
  const second = await provider.resolve('result-key-two');
  assert.ok(second);
  assert.deepEqual(Buffer.from(second.key), keyTwoBytes);
  second.key.fill(0);
  assert.equal(await provider.resolve('result-key-missing'), null);
});

test('projected Tool result keyring rejects noncanonical, writable and escaped material', async () => {
  const encoded = Buffer.alloc(32, 0x33).toString('base64url');
  const value = manifest({ 'result-key-one': encoded });

  const noncanonicalRoot = await tempRoot();
  await publish(
    noncanonicalRoot,
    '..2026_08_14_01',
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
  );
  await assert.rejects(
    () =>
      createClusterToolResultProjectedKeyring({
        rootDirectory: noncanonicalRoot,
      }),
    ClusterToolResultProjectedKeyringUnavailableError,
  );

  const writableRoot = await tempRoot();
  await publish(
    writableRoot,
    '..2026_08_14_01',
    canonicalClusterToolResultKeyringManifest(value),
    0o640,
  );
  await assert.rejects(
    () =>
      new ClusterToolResultProjectedKeyring({
        rootDirectory: writableRoot,
      }).verify(),
    ClusterToolResultProjectedKeyringUnavailableError,
  );

  const escapedRoot = await tempRoot();
  const externalRoot = await tempRoot();
  const external = path.join(externalRoot, 'keyring.json');
  await fs.writeFile(
    external,
    canonicalClusterToolResultKeyringManifest(value),
    { mode: 0o440 },
  );
  await fs.symlink(external, path.join(escapedRoot, 'keyring.json'));
  await assert.rejects(
    () =>
      new ClusterToolResultProjectedKeyring({
        rootDirectory: escapedRoot,
      }).verify(),
    ClusterToolResultProjectedKeyringUnavailableError,
  );
});

test('projected Tool result keyring rejects invalid material and ambiguous paths', async () => {
  const invalidRoot = await tempRoot();
  await publish(
    invalidRoot,
    '..2026_08_14_01',
    Buffer.from(
      `${JSON.stringify(
        manifest({ 'result-key-one': Buffer.alloc(31).toString('base64url') }),
      )}\n`,
      'utf8',
    ),
  );
  await assert.rejects(
    () =>
      createClusterToolResultProjectedKeyring({ rootDirectory: invalidRoot }),
    ClusterToolResultProjectedKeyringUnavailableError,
  );

  const root = await tempRoot();
  const rootLink = `${root}-link`;
  roots.push(rootLink);
  await fs.symlink(root, rootLink);
  await assert.rejects(
    () =>
      new ClusterToolResultProjectedKeyring({
        rootDirectory: rootLink,
      }).verify(),
    ClusterToolResultProjectedKeyringUnavailableError,
  );
  assert.throws(
    () =>
      new ClusterToolResultProjectedKeyring({
        rootDirectory: root,
        dataFileName: '../keyring.json',
      }),
    ClusterToolResultProjectedKeyringUnavailableError,
  );
});
