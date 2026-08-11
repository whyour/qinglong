const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  LocalPluginPackageActivationPublisher,
} = require('@qinglong/local-admin/package-activation');
const {
  analyzeLocalPluginPackageRecoveryCatalogPublisherKey,
  collectLocalPluginPackageRecoveryCatalog,
  createLocalPluginPackagePublisherTrustRegistry,
  inspectLocalPluginPackageRecoveryCatalog,
  publishLocalPluginPackageRecoveryCatalogEntry,
} = require('@qinglong/local-admin/package-recovery-catalog');
const {
  localPluginPackagePublisherKeyRevocationImpactDigest,
  publishLocalPluginPackagePublisherTrust,
  proposeLocalPluginPackagePublisherKeyRevocation,
} = require('@qinglong/local-admin/package-publisher-trust');
const {
  migrateLocalSqliteDatabase,
} = require('@qinglong/local-sqlite/migration');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('@qinglong/local-sqlite/plugin-package-install');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  PLUGIN_PACKAGE_SIGNATURE_SCHEMA,
  pluginPackageContentTreeDigest,
  pluginPackagePublisherSignaturePayload,
} = require('@qinglong/runtime-core/plugin-package-bundle');
const {
  createPluginPackageInstall,
  createPluginPackageLock,
  pluginPackageInstallActionDigest,
  pluginPackageInstallCreate,
  pluginPackageInstallPlanDigest,
  serializePluginPackageManifest,
} = require('@qinglong/runtime-core/plugin-package-install');
const {
  PluginPackageRecoveryCoordinator,
} = require('@qinglong/runtime-core/plugin-package-recovery');
const {
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
  LOCAL_PLUGIN_PACKAGE_RECOVERY_SOURCE_SCHEMA,
  MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_ENTRIES,
  LocalPluginPackageRecoveryCatalogError,
  createLocalPluginPackageRecoveryCatalogStageProvider,
} = require('../dist/production-process/pluginPackageRecoveryCatalog.js');

const PUBLISHER = 'packages.example.com';
const KEY_ID = 'release-2026';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function octal(value, bytes) {
  return Buffer.from(`${value.toString(8).padStart(bytes - 1, '0')}\0`);
}

function tarHeader(entryPath, bytes) {
  const header = Buffer.alloc(512);
  Buffer.from(entryPath).copy(header, 0);
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

function manifest() {
  return {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.2.0',
      description: 'One bounded package',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['edge'],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '16Mi' },
        disk: { install: '4Mi', working: '16Mi' },
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

function packageFixture(kind) {
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
  const artifactDigest = digest(artifact);
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'edge',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
  const plan = planPluginPackageInstall(packageManifest, environment);
  const source = {
    kind,
    locator:
      kind === 'offline'
        ? `offline:sha256:${artifactDigest}`
        : `oci://registry.example.com/qinglong/example-monitor@sha256:${'f'.repeat(
            64,
          )}`,
    artifactDigest,
    artifactBytes: artifact.byteLength,
    contentDigest: pluginPackageContentTreeDigest([
      {
        path: 'tasks/collect.yaml',
        bytes: taskBody.byteLength,
        digest: digest(taskBody),
      },
    ]),
  };
  const action = {
    lockId: `lock-${kind}-001`,
    projectId: 'default',
    manifest: packageManifest,
    plan,
    environment,
    source,
    architecture: 'arm64',
    deploymentProfile: 'edge',
    targetGeneration: 1,
  };
  const lock = createPluginPackageLock({
    ...action,
    approval: {
      requestId: `approval-${kind}-001`,
      requestVersion: 1,
      dispatchId: `dispatch-${kind}-001`,
      actionDigest: pluginPackageInstallActionDigest(action),
      previewDigest: pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 10_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200,
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = {
    publisher: PUBLISHER,
    keyId: KEY_ID,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
    notBeforeMs: 100,
    notAfterMs: 10_000,
  };
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
  return { artifact, key, lock, packageManifest, signature };
}

function directories(t) {
  const unresolved = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-package-catalog-'),
  );
  const root = fs.realpathSync(unresolved);
  const catalogRoot = path.join(root, 'catalog');
  const bundleRoot = path.join(root, 'bundles');
  const stagingRoot = path.join(root, 'staging');
  const trustRoot = path.join(root, 'publisher-trust');
  const publisherTrustFilePath = path.join(trustRoot, 'current.json');
  fs.mkdirSync(catalogRoot, { mode: 0o700 });
  fs.mkdirSync(bundleRoot, { mode: 0o700 });
  fs.mkdirSync(stagingRoot, { mode: 0o700 });
  fs.mkdirSync(trustRoot, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    catalogRoot,
    bundleRoot,
    stagingRoot,
    trustRoot,
    publisherTrustFilePath,
  };
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

async function ensureTrust(filesystem, value) {
  if (fs.existsSync(filesystem.publisherTrustFilePath)) return;
  await publishLocalPluginPackagePublisherTrust({
    trustRoot: filesystem.trustRoot,
    mode: 'provision',
    expectedGeneration: 0,
    mutationId: 'application-test-trust-v1',
    occurredAtMs: value.lock.createdAtMs,
    trust: {
      schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
      keys: [value.key],
    },
  });
}

async function publish(filesystem, value) {
  const bundlePath = path.join(
    filesystem.bundleRoot,
    `${value.lock.source.artifactDigest}.bundle`,
  );
  fs.writeFileSync(bundlePath, value.artifact, { mode: 0o600 });
  fs.chmodSync(bundlePath, 0o600);
  await ensureTrust(filesystem, value);
  const sourcePath = path.join(
    filesystem.catalogRoot,
    `${value.lock.lockDigest}.json`,
  );
  writePrivateJson(sourcePath, {
    schema: LOCAL_PLUGIN_PACKAGE_RECOVERY_SOURCE_SCHEMA,
    lockDigest: value.lock.lockDigest,
    source: value.lock.source,
    bundlePath,
    manifest: value.packageManifest,
    signature: value.signature,
  });
  return { bundlePath, sourcePath };
}

function provider(filesystem) {
  return createLocalPluginPackageRecoveryCatalogStageProvider({
    catalogRoot: filesystem.catalogRoot,
    bundleRoot: filesystem.bundleRoot,
    publisherTrustFilePath: filesystem.publisherTrustFilePath,
    stagingRoot: filesystem.stagingRoot,
  });
}

test('consumes an entry published by the authenticated catalog boundary', async (t) => {
  const filesystem = directories(t);
  const value = packageFixture('offline');
  const sourceBundlePath = path.join(filesystem.root, 'incoming.bundle');
  fs.writeFileSync(sourceBundlePath, value.artifact, { mode: 0o600 });
  fs.chmodSync(sourceBundlePath, 0o600);
  await ensureTrust(filesystem, value);

  let publicationGuards = 0;
  const published = await publishLocalPluginPackageRecoveryCatalogEntry({
    catalogRoot: filesystem.catalogRoot,
    bundleRoot: filesystem.bundleRoot,
    sourceBundlePath,
    lock: value.lock,
    manifest: value.packageManifest,
    signature: value.signature,
    trust: createLocalPluginPackagePublisherTrustRegistry({
      schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
      keys: [value.key],
    }),
    confirmPublicationAllowed() {
      publicationGuards += 1;
      assert.equal(
        fs
          .readdirSync(filesystem.catalogRoot)
          .filter((entry) => /^\.qlpkg-catalog-[0-9a-f]{32}\.tmp$/.test(entry))
          .length,
        1,
      );
    },
  });

  assert.equal(published.status, 'published');
  assert.equal(publicationGuards, 2);
  assert.equal(published.lockDigest, value.lock.lockDigest);
  assert.equal(
    fs.statSync(
      path.join(
        filesystem.bundleRoot,
        `${value.lock.source.artifactDigest}.bundle`,
      ),
    ).mode & 0o777,
    0o600,
  );
  const staged = await provider(filesystem).stage(value.lock);
  assert.equal(staged.artifactDigest, value.lock.source.artifactDigest);
  assert.equal(staged.manifestDigest, value.lock.manifestDigest);

  assert.equal(
    (
      await publishLocalPluginPackageRecoveryCatalogEntry({
        catalogRoot: filesystem.catalogRoot,
        bundleRoot: filesystem.bundleRoot,
        sourceBundlePath,
        lock: value.lock,
        manifest: value.packageManifest,
        signature: value.signature,
        trust: createLocalPluginPackagePublisherTrustRegistry({
          schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
          keys: [value.key],
        }),
      })
    ).status,
    'existing',
  );
  assert.deepEqual(
    inspectLocalPluginPackageRecoveryCatalog({
      catalogRoot: filesystem.catalogRoot,
      bundleRoot: filesystem.bundleRoot,
    }),
    {
      lockDigests: [value.lock.lockDigest],
      entryCount: 1,
      bundleCount: 1,
      unresolvedTransactions: 0,
    },
  );
  assert.deepEqual(
    analyzeLocalPluginPackageRecoveryCatalogPublisherKey({
      catalogRoot: filesystem.catalogRoot,
      bundleRoot: filesystem.bundleRoot,
      publisher: PUBLISHER,
      keyId: KEY_ID,
    }),
    {
      catalogEntryCount: 1,
      bundleCount: 1,
      matchingEntryCount: 1,
      unresolvedTransactions: 0,
    },
  );
  await assert.rejects(
    publishLocalPluginPackageRecoveryCatalogEntry({
      catalogRoot: filesystem.catalogRoot,
      bundleRoot: filesystem.bundleRoot,
      sourceBundlePath,
      lock: value.lock,
      manifest: value.packageManifest,
      signature: value.signature,
      trust: createLocalPluginPackagePublisherTrustRegistry({
        schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
        keys: [value.key],
      }),
      confirmPublicationAllowed() {
        throw new Error('retirement intent won');
      },
    }),
    /catalog publication is unavailable/,
  );
  assert.equal(
    fs
      .readdirSync(filesystem.catalogRoot)
      .some((entry) => entry.endsWith('.tmp')),
    false,
  );

  const catalogTransaction = path.join(
    filesystem.catalogRoot,
    `.qlpkg-catalog-${'a'.repeat(32)}.tmp`,
  );
  const bundleTransaction = path.join(
    filesystem.bundleRoot,
    `.qlpkg-bundle-${'b'.repeat(32)}.tmp`,
  );
  fs.writeFileSync(catalogTransaction, '', { mode: 0o600 });
  fs.writeFileSync(bundleTransaction, '', { mode: 0o600 });
  let deleteFences = 0;
  const collected = await collectLocalPluginPackageRecoveryCatalog({
    catalogRoot: filesystem.catalogRoot,
    bundleRoot: filesystem.bundleRoot,
    candidateLockDigests: [value.lock.lockDigest],
    maxDeletes: 4,
    beforeDelete() {
      deleteFences += 1;
    },
  });
  assert.deepEqual(collected, {
    removedEntries: 1,
    removedBundles: 1,
    removedTransactions: 2,
    remaining: false,
  });
  assert.equal(deleteFences, 1);
});

test('verifies a historical lock at its immutable creation time', async (t) => {
  const filesystem = directories(t);
  const value = packageFixture('offline');
  await publish(filesystem, {
    ...value,
    key: {
      ...value.key,
      notAfterMs: value.lock.createdAtMs + 1,
    },
  });

  const staged = await provider(filesystem).stage(value.lock);
  assert.equal(staged.artifactDigest, value.lock.source.artifactDigest);
  assert.equal(staged.manifestDigest, value.lock.manifestDigest);
});

test('blocks queued staging as soon as a compromise proposal is durable', async (t) => {
  const filesystem = directories(t);
  const value = packageFixture('offline');
  await publish(filesystem, value);
  const impactedLockDigests = [value.lock.lockDigest];
  const impact = {
    catalogEntryCount: 1,
    bundleCount: 1,
    matchingEntryCount: 1,
    unresolvedTransactions: 0,
    impactedLockDigests,
    impactDigest: localPluginPackagePublisherKeyRevocationImpactDigest({
      publisher: PUBLISHER,
      keyId: KEY_ID,
      catalogEntryCount: 1,
      bundleCount: 1,
      matchingEntryCount: 1,
      unresolvedTransactions: 0,
      impactedLockDigests,
    }),
  };
  await proposeLocalPluginPackagePublisherKeyRevocation({
    trustRoot: filesystem.trustRoot,
    expectedGeneration: 1,
    mutationId: 'application-test-revoke-v2',
    occurredAtMs: 300,
    publisher: PUBLISHER,
    keyId: KEY_ID,
    proposerSubjectId: 'owner-a',
    impact,
  });
  await assert.rejects(
    provider(filesystem).stage(value.lock),
    /blocked by a durable lifecycle mutation/,
  );
  assert.deepEqual(fs.readdirSync(filesystem.stagingRoot), []);
});

for (const kind of ['offline', 'oci']) {
  test(`stages one exact ${kind} lock from the materialized catalog`, async (t) => {
    const filesystem = directories(t);
    const value = packageFixture(kind);
    const files = await publish(filesystem, value);
    const stageProvider = provider(filesystem);
    const staged = await stageProvider.stage(value.lock);
    assert.equal(staged.stageRef, `local-stage:${value.lock.lockDigest}`);
    assert.equal(staged.artifactDigest, value.lock.source.artifactDigest);
    assert.equal(staged.manifestDigest, value.lock.manifestDigest);
    assert.equal(staged.contentDigest, value.lock.source.contentDigest);

    fs.unlinkSync(files.bundlePath);
    assert.deepEqual(await stageProvider.stage(value.lock), staged);
  });
}

test('recovers one durable queued install to active through the catalog', async (t) => {
  const filesystem = directories(t);
  const activationRoot = path.join(filesystem.root, 'activation');
  fs.mkdirSync(activationRoot, { mode: 0o700 });
  const value = packageFixture('offline');
  await publish(filesystem, value);
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(database);
  t.after(() => database.close());
  const repository = new LocalSqlitePluginPackageInstallRepository(database);
  const queued = createPluginPackageInstall(value.lock, {
    installationId: 'catalog-recovery-install-001',
    mutationId: 'catalog-recovery-create-001',
    occurredAtMs: 300,
  });
  await repository.create(pluginPackageInstallCreate(value.lock, queued, null));
  const recovery = new PluginPackageRecoveryCoordinator({
    repository,
    stageProvider: provider(filesystem),
    publisher: new LocalPluginPackageActivationPublisher({
      stagingRoot: filesystem.stagingRoot,
      activationRoot,
      now: () => 700,
    }),
    now: () => 600,
  });

  const result = await recovery.recover({ pageSize: 1, maxPages: 2 });

  assert.equal(result.safeToAdmit, true);
  assert.equal(result.settled, 1);
  const active = await repository.find(
    value.lock.projectId,
    value.lock.packageName,
  );
  assert.equal(active.state, 'active');
  assert.equal(active.activeLockDigest, value.lock.lockDigest);
});

test('construction is lazy and a missing locked entry fails closed', async (t) => {
  const root = path.join(directoryName(t), 'not-created');
  const stageProvider = createLocalPluginPackageRecoveryCatalogStageProvider({
    catalogRoot: root,
    bundleRoot: path.join(root, 'bundles'),
    publisherTrustFilePath: path.join(root, 'trust', 'current.json'),
    stagingRoot: path.join(root, 'staging'),
  });
  await assert.rejects(
    stageProvider.stage(packageFixture('offline').lock),
    LocalPluginPackageRecoveryCatalogError,
  );
});

function directoryName(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-catalog-lazy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}

test('rejects source drift, widened trust and unknown catalog entries', async (t) => {
  const filesystem = directories(t);
  const value = packageFixture('offline');
  const files = await publish(filesystem, value);
  const entry = JSON.parse(fs.readFileSync(files.sourcePath, 'utf8'));
  entry.source.artifactDigest = 'f'.repeat(64);
  writePrivateJson(files.sourcePath, entry);
  await assert.rejects(
    provider(filesystem).stage(value.lock),
    /does not match its durable PackageLock/,
  );

  await publish(filesystem, value);
  fs.chmodSync(filesystem.publisherTrustFilePath, 0o644);
  await assert.rejects(
    provider(filesystem).stage(value.lock),
    /trust file must be a bounded owner-only regular file/,
  );

  fs.chmodSync(filesystem.publisherTrustFilePath, 0o600);
  fs.writeFileSync(path.join(filesystem.catalogRoot, 'unexpected'), '', {
    mode: 0o600,
  });
  await assert.rejects(
    provider(filesystem).stage(value.lock),
    /unbounded or unknown entries/,
  );
});

test('hard-caps catalog cardinality before reading a source', async (t) => {
  const filesystem = directories(t);
  const value = packageFixture('offline');
  await publish(filesystem, value);
  for (
    let index = 0;
    index < MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_ENTRIES;
    index += 1
  ) {
    const name = index.toString(16).padStart(64, '0');
    if (name === value.lock.lockDigest) continue;
    writePrivateJson(path.join(filesystem.catalogRoot, `${name}.json`), {});
  }
  const existing = fs.readdirSync(filesystem.catalogRoot).length;
  if (existing <= MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_ENTRIES) {
    writePrivateJson(
      path.join(filesystem.catalogRoot, `${'e'.repeat(64)}.json`),
      {},
    );
  }
  assert.equal(
    fs.readdirSync(filesystem.catalogRoot).length >
      MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_ENTRIES,
    true,
  );
  await assert.rejects(
    provider(filesystem).stage(value.lock),
    /unbounded or unknown entries/,
  );
});

test('publishes catalog authority only through its explicit subpath', () => {
  const root = require('../dist');
  const subpath = require('@qinglong/local-application/plugin-package-recovery-catalog');
  assert.equal(
    root.createLocalPluginPackageRecoveryCatalogStageProvider,
    undefined,
  );
  assert.equal(
    subpath.createLocalPluginPackageRecoveryCatalogStageProvider,
    createLocalPluginPackageRecoveryCatalogStageProvider,
  );
});
