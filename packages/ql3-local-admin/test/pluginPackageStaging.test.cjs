const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  PLUGIN_PACKAGE_SIGNATURE_SCHEMA,
  PluginPackagePublisherTrustRegistry,
  pluginPackageContentTreeDigest,
  pluginPackagePublisherSignaturePayload,
} = require('@qinglong/runtime-core/plugin-package-bundle');
const {
  createPluginPackageLock,
  pluginPackageInstallActionDigest,
  pluginPackageInstallPlanDigest,
  serializePluginPackageManifest,
} = require('@qinglong/runtime-core/plugin-package-install');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  InvalidPluginPackageStagingError,
  PluginPackageStagingUnavailableError,
  stagePluginPackageFromFile,
} = require('../dist/plugin-package/pluginPackageStaging');

const PUBLISHER = 'packages.example.com';
const KEY_ID = 'release-2026';

function manifest() {
  return {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.2.0',
      description: 'Collects one report',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['edge'],
      },
      runtimes: [{ name: 'python', version: '>=3.10.0 <4.0.0' }],
      resources: {
        memory: { recommended: '32Mi' },
        disk: { install: '8Mi', working: '32Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [],
        tools: [],
      },
      contents: {
        tasks: ['tasks/collect.yaml'],
        workflows: [],
        prompts: [],
        tools: [],
      },
    },
  };
}

function environment() {
  return {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'edge',
    runtimes: [{ name: 'python', version: '3.12.4' }],
    availableMemoryBytes: 256 * 1024 * 1024,
    availableDiskBytes: 512 * 1024 * 1024,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function octal(value, bytes) {
  return Buffer.from(`${value.toString(8).padStart(bytes - 1, '0')}\0`);
}

function tarHeader(path, bytes) {
  const header = Buffer.alloc(512);
  Buffer.from(path).copy(header, 0);
  Buffer.from('0000644\0').copy(header, 100);
  Buffer.from('0000000\0').copy(header, 108);
  Buffer.from('0000000\0').copy(header, 116);
  octal(bytes, 12).copy(header, 124);
  Buffer.from('00000000000\0').copy(header, 136);
  header.fill(0x20, 148, 156);
  Buffer.from('0').copy(header, 156);
  Buffer.from('ustar\0').copy(header, 257);
  Buffer.from('00').copy(header, 263);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);
  return header;
}

function tar(entries) {
  const parts = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry.path, entry.body.byteLength), entry.body);
    const padding = (512 - (entry.body.byteLength % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function packageFixture() {
  const packageManifest = manifest();
  const manifestBody = Buffer.from(
    serializePluginPackageManifest(packageManifest),
  );
  const taskBody = Buffer.from(
    'apiVersion: qinglong.io/v1\nkind: Task\nmetadata:\n  name: collect\n',
  );
  const artifact = tar([
    { path: 'package.json', body: manifestBody },
    { path: 'tasks/collect.yaml', body: taskBody },
  ]);
  const installEnvironment = environment();
  const plan = planPluginPackageInstall(packageManifest, installEnvironment);
  const artifactDigest = sha256(artifact);
  const source = {
    kind: 'offline',
    locator: `offline:sha256:${artifactDigest}`,
    artifactDigest,
    artifactBytes: artifact.byteLength,
    contentDigest: pluginPackageContentTreeDigest([
      {
        path: 'tasks/collect.yaml',
        bytes: taskBody.byteLength,
        digest: sha256(taskBody),
      },
    ]),
  };
  const actionInput = {
    lockId: 'lock-stage-001',
    projectId: 'project-001',
    manifest: packageManifest,
    plan,
    environment: installEnvironment,
    source,
    architecture: 'arm64',
    deploymentProfile: 'edge',
    targetGeneration: 1,
  };
  const lock = createPluginPackageLock({
    ...actionInput,
    approval: {
      requestId: 'approval-001',
      requestVersion: 1,
      dispatchId: 'dispatch-001',
      actionDigest: pluginPackageInstallActionDigest(actionInput),
      previewDigest: pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 1_000,
      fence: { projectVersion: 3, bindingVersion: 4 },
    },
    createdAtMs: 200,
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trust = new PluginPackagePublisherTrustRegistry([
    {
      publisher: PUBLISHER,
      keyId: KEY_ID,
      publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
      notBeforeMs: 100,
      notAfterMs: 1_000,
    },
  ]);
  const signature = {
    schema: PLUGIN_PACKAGE_SIGNATURE_SCHEMA,
    publisher: PUBLISHER,
    keyId: KEY_ID,
    signature: sign(
      null,
      pluginPackagePublisherSignaturePayload(lock, PUBLISHER, KEY_ID),
      privateKey,
    ).toString('base64url'),
  };
  return { artifact, lock, packageManifest, signature, trust };
}

async function filesystemFixture(t) {
  const unresolved = await mkdtemp(join(tmpdir(), 'ql3-package-stage-'));
  const base = await realpath(unresolved);
  const stagingRoot = join(base, 'staging');
  const bundlePath = join(base, 'package.qlpkg');
  await mkdir(stagingRoot, { mode: 0o700 });
  await chmod(stagingRoot, 0o700);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, bundlePath, stagingRoot };
}

async function writePrivateBundle(bundlePath, artifact) {
  await writeFile(bundlePath, artifact, { mode: 0o600 });
  await chmod(bundlePath, 0o600);
}

function stageOptions(filesystem, value, overrides = {}) {
  return {
    bundlePath: filesystem.bundlePath,
    stagingRoot: filesystem.stagingRoot,
    lock: value.lock,
    manifest: value.packageManifest,
    signature: value.signature,
    trust: value.trust,
    observedAtMs: 500,
    ...overrides,
  };
}

test('stages a verified bundle as private opaque blobs and one receipt', async (t) => {
  const filesystem = await filesystemFixture(t);
  const value = packageFixture();
  await writePrivateBundle(filesystem.bundlePath, value.artifact);
  const staged = await stagePluginPackageFromFile(
    stageOptions(filesystem, value),
  );

  assert.equal(staged.status, 'staged');
  assert.equal(staged.stageRef, `local-stage:${value.lock.lockDigest}`);
  assert.equal(
    staged.directory,
    join(filesystem.stagingRoot, value.lock.lockDigest),
  );
  assert.match(staged.receiptDigest, /^[0-9a-f]{64}$/);
  assert.equal((await lstat(staged.directory)).mode & 0o777, 0o700);
  const rootEntries = await readdir(staged.directory);
  assert.deepEqual(rootEntries.sort(), ['blobs', 'receipt.json']);
  const blobNames = (await readdir(join(staged.directory, 'blobs'))).sort();
  assert.equal(blobNames.length, 2);
  assert.equal(
    blobNames.every((name) => /^[0-9]{4}-[0-9a-f]{64}\.blob$/.test(name)),
    true,
  );
  assert.equal(rootEntries.includes('tasks'), false);
  assert.equal(
    (await lstat(join(staged.directory, 'receipt.json'))).mode & 0o777,
    0o600,
  );
  for (const blob of blobNames) {
    assert.equal(
      (await lstat(join(staged.directory, 'blobs', blob))).mode & 0o777,
      0o600,
    );
  }
});

test('replays one exact stage without reopening the deleted source bundle', async (t) => {
  const filesystem = await filesystemFixture(t);
  const value = packageFixture();
  await writePrivateBundle(filesystem.bundlePath, value.artifact);
  const first = await stagePluginPackageFromFile(
    stageOptions(filesystem, value),
  );
  await unlink(filesystem.bundlePath);
  const replay = await stagePluginPackageFromFile(
    stageOptions(filesystem, value),
  );
  assert.equal(replay.status, 'existing');
  assert.equal(replay.receiptDigest, first.receiptDigest);
  assert.deepEqual(replay.inspection, first.inspection);
});

test('fails closed when an existing opaque blob or receipt is changed', async (t) => {
  const filesystem = await filesystemFixture(t);
  const value = packageFixture();
  await writePrivateBundle(filesystem.bundlePath, value.artifact);
  const staged = await stagePluginPackageFromFile(
    stageOptions(filesystem, value),
  );
  const blobDirectory = join(staged.directory, 'blobs');
  const [blob] = await readdir(blobDirectory);
  await writeFile(join(blobDirectory, blob), Buffer.from('tampered'));
  await assert.rejects(
    stagePluginPackageFromFile(stageOptions(filesystem, value)),
    InvalidPluginPackageStagingError,
  );
});

test('rejects a canonical-looking receipt detached from the locked artifact', async (t) => {
  const filesystem = await filesystemFixture(t);
  const value = packageFixture();
  await writePrivateBundle(filesystem.bundlePath, value.artifact);
  const staged = await stagePluginPackageFromFile(
    stageOptions(filesystem, value),
  );
  const receiptPath = join(staged.directory, 'receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.inspection.artifactDigest = 'f'.repeat(64);
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await chmod(receiptPath, 0o600);
  await assert.rejects(
    stagePluginPackageFromFile(stageOptions(filesystem, value)),
    InvalidPluginPackageStagingError,
  );
});

test('rejects broad bundle permissions and final-component symbolic links', async (t) => {
  const filesystem = await filesystemFixture(t);
  const value = packageFixture();
  await writePrivateBundle(filesystem.bundlePath, value.artifact);
  await chmod(filesystem.bundlePath, 0o644);
  await assert.rejects(
    stagePluginPackageFromFile(stageOptions(filesystem, value)),
    InvalidPluginPackageStagingError,
  );
  assert.deepEqual(await readdir(filesystem.stagingRoot), []);

  const target = join(filesystem.base, 'target.qlpkg');
  await writePrivateBundle(target, value.artifact);
  await unlink(filesystem.bundlePath);
  await symlink(target, filesystem.bundlePath);
  await assert.rejects(
    stagePluginPackageFromFile(stageOptions(filesystem, value)),
    InvalidPluginPackageStagingError,
  );
  assert.deepEqual(await readdir(filesystem.stagingRoot), []);
});

test('does not create a transaction for an untrusted signature', async (t) => {
  const filesystem = await filesystemFixture(t);
  const value = packageFixture();
  await writePrivateBundle(filesystem.bundlePath, value.artifact);
  await assert.rejects(
    stagePluginPackageFromFile(
      stageOptions(filesystem, value, {
        observedAtMs: 1_000,
      }),
    ),
    /publisher signature is not trusted/,
  );
  assert.deepEqual(await readdir(filesystem.stagingRoot), []);
});

test('removes its bounded temporary transaction after bundle failure', async (t) => {
  const filesystem = await filesystemFixture(t);
  const value = packageFixture();
  const tampered = Buffer.from(value.artifact);
  tampered[512] ^= 1;
  await writePrivateBundle(filesystem.bundlePath, tampered);
  await assert.rejects(
    stagePluginPackageFromFile(stageOptions(filesystem, value)),
    PluginPackageStagingUnavailableError,
  );
  assert.deepEqual(await readdir(filesystem.stagingRoot), []);
});

test('fails closed on stale transactions, unknown root entries and broad roots', async (t) => {
  const filesystem = await filesystemFixture(t);
  const value = packageFixture();
  await writePrivateBundle(filesystem.bundlePath, value.artifact);
  const stale = join(filesystem.stagingRoot, `.qlpkg-${'a'.repeat(32)}`);
  await mkdir(stale, { mode: 0o700 });
  await assert.rejects(
    stagePluginPackageFromFile(stageOptions(filesystem, value)),
    InvalidPluginPackageStagingError,
  );
  await rm(stale, { recursive: true });
  await writeFile(join(filesystem.stagingRoot, 'unknown'), '');
  await assert.rejects(
    stagePluginPackageFromFile(stageOptions(filesystem, value)),
    InvalidPluginPackageStagingError,
  );
  await unlink(join(filesystem.stagingRoot, 'unknown'));
  await chmod(filesystem.stagingRoot, 0o755);
  await assert.rejects(
    stagePluginPackageFromFile(stageOptions(filesystem, value)),
    InvalidPluginPackageStagingError,
  );
});

test('publishes staging authority only through the explicit local-admin subpath', () => {
  const root = require('..');
  const subpath = require('@qinglong/local-admin/package-staging');
  assert.equal(root.stagePluginPackageFromFile, undefined);
  assert.equal(subpath.stagePluginPackageFromFile, stagePluginPackageFromFile);
});
