const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  pluginPackageContentTreeDigest,
} = require('@qinglong/runtime-core/plugin-package-bundle');
const {
  createPluginPackageResourceGenerationFromReferences,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  InvalidLocalPluginPackageResourceSourceError,
  LocalPluginPackageResourceByteSource,
} = require('../dist/plugin-package/pluginPackageResourceMaterialization');

const LOCK_DIGEST = 'a'.repeat(64);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function blobName(index, entryPath) {
  return `${String(index).padStart(4, '0')}-${digest(entryPath)}.blob`;
}

async function stageFixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-resource-source-')),
  );
  await fs.chmod(root, 0o700);
  const stage = path.join(root, LOCK_DIGEST);
  const blobs = path.join(stage, 'blobs');
  await fs.mkdir(stage, { mode: 0o700 });
  await fs.mkdir(blobs, { mode: 0o700 });

  const materials = new Map([
    ['package.json', Buffer.from('{"apiVersion":"qinglong.io/v1alpha1"}')],
    [
      'tasks/collect.json',
      Buffer.from(
        JSON.stringify({
          schema: 'qinglong/plugin-package-task-resource@v1',
          id: 'collect',
        }),
      ),
    ],
  ]);
  const entries = [...materials.entries()].map(
    ([entryPath, material], index) => ({
      path: entryPath,
      bytes: material.byteLength,
      digest: digest(material),
      blob: blobName(index, entryPath),
    }),
  );
  const contentDigest = pluginPackageContentTreeDigest(
    entries.slice(1).map(({ path: entryPath, bytes, digest }) => ({
      path: entryPath,
      bytes,
      digest,
    })),
  );
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-001',
    projectId: 'project-001',
    packageName: 'example-monitor',
    lockDigest: LOCK_DIGEST,
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest,
    resources: [{ kind: 'task', path: 'tasks/collect.json' }],
  });
  const inspectionEntries = entries.map(
    ({ path: entryPath, bytes, digest }) => ({
      path: entryPath,
      bytes,
      digest,
    }),
  );
  const receipt = {
    schema: 'qinglong/plugin-package-stage-receipt@v1',
    lockDigest: LOCK_DIGEST,
    inspection: {
      mediaType: 'application/vnd.qinglong.package.v1+tar',
      lockDigest: LOCK_DIGEST,
      packageName: generation.packageName,
      packageVersion: '1.0.0',
      artifactBytes: 4096,
      artifactDigest: 'b'.repeat(64),
      manifestDigest: entries[0].digest,
      contentBytes: entries[1].bytes,
      contentDigest,
      entries: inspectionEntries,
      signature: {
        publisher: 'example.test',
        keyId: 'key-001',
        signatureDigest: 'c'.repeat(64),
        keyNotBeforeMs: 0,
        keyNotAfterMs: 10_000,
        verifiedAtMs: 100,
      },
    },
    entries,
  };
  for (const [index, entry] of entries.entries()) {
    const file = path.join(blobs, entry.blob);
    await fs.writeFile(file, materials.get(entry.path), { mode: 0o600 });
    await fs.chmod(file, 0o600);
    assert.equal(index < 10_000, true);
  }
  const receiptPath = path.join(stage, 'receipt.json');
  await fs.writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  await fs.chmod(receiptPath, 0o600);
  return { root, stage, blobs, materials, entries, generation };
}

async function cleanup(root) {
  await fs.rm(root, { recursive: true, force: true });
}

test('opens one private stage session and verifies each exact blob on demand', async () => {
  const fixture = await stageFixture();
  try {
    const source = new LocalPluginPackageResourceByteSource({
      stagingRoot: fixture.root,
    });
    const reader = await source.open(fixture.generation);
    assert.deepEqual(
      await reader.read('package.json', 64 * 1024),
      fixture.materials.get('package.json'),
    );
    assert.deepEqual(
      await reader.read('tasks/collect.json', 1024 * 1024),
      fixture.materials.get('tasks/collect.json'),
    );
    await assert.rejects(
      reader.read('tasks/collect.json', 1024 * 1024),
      /duplicated/,
    );
    await reader.close();
    await assert.rejects(reader.read('package.json', 64 * 1024), /closed/);
  } finally {
    await cleanup(fixture.root);
  }
});

test('fails closed on blob tampering, extras and an over-tight caller bound', async () => {
  const tampered = await stageFixture();
  try {
    const source = new LocalPluginPackageResourceByteSource({
      stagingRoot: tampered.root,
    });
    const reader = await source.open(tampered.generation);
    await fs.writeFile(
      path.join(tampered.blobs, tampered.entries[1].blob),
      Buffer.alloc(tampered.entries[1].bytes, 0x78),
    );
    await assert.rejects(
      reader.read('tasks/collect.json', 1024 * 1024),
      InvalidLocalPluginPackageResourceSourceError,
    );
  } finally {
    await cleanup(tampered.root);
  }

  const extra = await stageFixture();
  try {
    await fs.writeFile(path.join(extra.blobs, 'extra'), 'x', { mode: 0o600 });
    const source = new LocalPluginPackageResourceByteSource({
      stagingRoot: extra.root,
    });
    await assert.rejects(
      source.open(extra.generation),
      /incomplete or contains extras/,
    );
  } finally {
    await cleanup(extra.root);
  }

  const bounded = await stageFixture();
  try {
    const source = new LocalPluginPackageResourceByteSource({
      stagingRoot: bounded.root,
    });
    const reader = await source.open(bounded.generation);
    await assert.rejects(
      reader.read('tasks/collect.json', 1),
      /exceeds its requested bound/,
    );
  } finally {
    await cleanup(bounded.root);
  }
});

test('publishes the local adapter only through its explicit subpath', () => {
  assert.equal(require('..').LocalPluginPackageResourceByteSource, undefined);
  assert.equal(
    require('@qinglong/local-admin/package-resource-materialization')
      .LocalPluginPackageResourceByteSource,
    LocalPluginPackageResourceByteSource,
  );
});
