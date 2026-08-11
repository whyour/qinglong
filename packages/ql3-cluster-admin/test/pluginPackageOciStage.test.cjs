const assert = require('node:assert/strict');
const {
  createHash,
  generateKeyPairSync,
  sign,
} = require('node:crypto');
const { test } = require('node:test');

const {
  PluginPackagePublisherTrustRegistry,
  PLUGIN_PACKAGE_SIGNATURE_SCHEMA,
  pluginPackageContentTreeDigest,
  pluginPackagePublisherSignaturePayload,
} = require('@qinglong/runtime-core/plugin-package-bundle');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  InvalidPluginPackageInstallError,
  PluginPackageInstallUnavailableError,
  createPluginPackageLock,
  pluginPackageInstallActionDigest,
  pluginPackageInstallPlanDigest,
  serializePluginPackageManifest,
} = require('@qinglong/runtime-core/plugin-package-install');
const {
  createPluginPackageResourceGenerationFromReferences,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  ClusterPluginPackageOciResourceByteSource,
  ClusterPluginPackageOciStageAuthority,
  PLUGIN_PACKAGE_OCI_ARTIFACT_TYPE,
  PLUGIN_PACKAGE_OCI_CONFIG_MEDIA_TYPE,
  PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE,
  PLUGIN_PACKAGE_OCI_SIGNATURE_CONFIG_MEDIA_TYPE,
} = require('@qinglong/cluster-admin/plugin-package-oci-stage');

const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const BUNDLE = 'application/vnd.qinglong.package.v1+tar';
const REGISTRY = 'registry.example.com';
const REPOSITORY = 'qinglong/example-monitor';
const PUBLISHER = 'packages.example.com';
const KEY_ID = 'release-2026';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function bytes(value) {
  return Buffer.from(JSON.stringify(value));
}

function octal(value, width) {
  return Buffer.from(
    `${value.toString(8).padStart(width - 1, '0')}\0`,
    'ascii',
  );
}

function tarHeader(path, size) {
  const header = Buffer.alloc(512);
  Buffer.from(path).copy(header, 0);
  Buffer.from('0000644\0').copy(header, 100);
  Buffer.from('0000000\0').copy(header, 108);
  Buffer.from('0000000\0').copy(header, 116);
  octal(size, 12).copy(header, 124);
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
      description: 'One cluster package',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['cluster-control'],
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
        tasks: ['tasks/collect.json'],
        workflows: [],
        prompts: [],
        tools: [],
      },
    },
  };
}

function fixture() {
  const packageManifest = manifest();
  const resourceMaterial = Buffer.from(
    JSON.stringify({
      schema: 'qinglong/plugin-package-task-resource@v1',
      id: 'collect',
    }),
  );
  const artifact = tar([
    {
      path: 'package.json',
      body: Buffer.from(serializePluginPackageManifest(packageManifest)),
    },
    {
      path: 'tasks/collect.json',
      body: resourceMaterial,
    },
  ]);
  const packageConfig = bytes({
    schema: 'qinglong/plugin-package-oci-config@v1',
    manifest: packageManifest,
  });
  const packageConfigDigest = sha256(packageConfig);
  const packageManifestValue = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    artifactType: PLUGIN_PACKAGE_OCI_ARTIFACT_TYPE,
    config: {
      mediaType: PLUGIN_PACKAGE_OCI_CONFIG_MEDIA_TYPE,
      digest: `sha256:${packageConfigDigest}`,
      size: packageConfig.byteLength,
    },
    layers: [
      {
        mediaType: BUNDLE,
        digest: `sha256:${sha256(artifact)}`,
        size: artifact.byteLength,
      },
    ],
  };
  const packageManifestBytes = bytes(packageManifestValue);
  const packageManifestDigest = sha256(packageManifestBytes);
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'cluster-control',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
  const plan = planPluginPackageInstall(packageManifest, environment);
  const source = {
    kind: 'oci',
    locator: `oci://${REGISTRY}/${REPOSITORY}@sha256:${packageManifestDigest}`,
    artifactDigest: sha256(artifact),
    artifactBytes: artifact.byteLength,
    contentDigest: pluginPackageContentTreeDigest([
      {
        path: 'tasks/collect.json',
        bytes: resourceMaterial.byteLength,
        digest: sha256(resourceMaterial),
      },
    ]),
  };
  const action = {
    lockId: 'lock-cluster-oci',
    projectId: 'default',
    manifest: packageManifest,
    plan,
    environment,
    source,
    architecture: 'arm64',
    deploymentProfile: 'cluster-control',
    targetGeneration: 1,
  };
  const lock = createPluginPackageLock({
    ...action,
    approval: {
      requestId: 'approval-cluster-oci',
      requestVersion: 1,
      dispatchId: 'dispatch-cluster-oci',
      actionDigest: pluginPackageInstallActionDigest(action),
      previewDigest: pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 10_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200,
  });
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-cluster-oci',
    projectId: lock.projectId,
    packageName: lock.packageName,
    lockDigest: lock.lockDigest,
    generation: lock.targetGeneration,
    previousActiveLockDigest: null,
    contentDigest: lock.source.contentDigest,
    resources: lock.resources,
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trust = new PluginPackagePublisherTrustRegistry([
    {
      publisher: PUBLISHER,
      keyId: KEY_ID,
      publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
      notBeforeMs: 100,
      notAfterMs: 10_000,
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
  const signatureConfig = bytes(signature);
  const signatureConfigDigest = sha256(signatureConfig);
  const signatureManifestValue = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    artifactType: PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE,
    config: {
      mediaType: PLUGIN_PACKAGE_OCI_SIGNATURE_CONFIG_MEDIA_TYPE,
      digest: `sha256:${signatureConfigDigest}`,
      size: signatureConfig.byteLength,
    },
    layers: [],
    subject: {
      mediaType: OCI_MANIFEST,
      digest: `sha256:${packageManifestDigest}`,
      size: packageManifestBytes.byteLength,
    },
  };
  const signatureManifestBytes = bytes(signatureManifestValue);
  const signatureManifestDigest = sha256(signatureManifestBytes);
  const referrers = bytes({
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [
      {
        mediaType: OCI_MANIFEST,
        digest: `sha256:${signatureManifestDigest}`,
        size: signatureManifestBytes.byteLength,
        artifactType: PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE,
        annotations: {
          'qinglong.io/plugin-package-lock-digest': lock.lockDigest,
        },
      },
    ],
  });
  const prefix = `https://${REGISTRY}/v2/${REPOSITORY}`;
  const routes = new Map([
    [
      `${prefix}/manifests/sha256:${packageManifestDigest}`,
      packageManifestBytes,
    ],
    [`${prefix}/blobs/sha256:${packageConfigDigest}`, packageConfig],
    [
      `${prefix}/referrers/sha256:${packageManifestDigest}?artifactType=${encodeURIComponent(
        PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE,
      )}`,
      referrers,
    ],
    [
      `${prefix}/manifests/sha256:${signatureManifestDigest}`,
      signatureManifestBytes,
    ],
    [`${prefix}/blobs/sha256:${signatureConfigDigest}`, signatureConfig],
    [`${prefix}/blobs/sha256:${sha256(artifact)}`, artifact],
  ]);
  let calls = 0;
  const fetch = async (url, init) => {
    calls += 1;
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.signal.aborted, false);
    const body = routes.get(url);
    if (!body) return { status: 404, headers: { get: () => null }, body: null };
    return {
      status: 200,
      headers: {
        get(name) {
          return name.toLowerCase() === 'content-length'
            ? String(body.byteLength)
            : null;
        },
      },
      body: (async function* () {
        for (let offset = 0; offset < body.byteLength; offset += 37) {
          yield body.subarray(offset, Math.min(offset + 37, body.byteLength));
        }
      })(),
    };
  };
  return {
    artifact,
    fetch,
    generation,
    lock,
    packageManifest,
    resourceMaterial,
    routes,
    trust,
    calls: () => calls,
  };
}

test('streams one allowlisted OCI artifact and reuses bounded evidence for activation', async () => {
  const value = fixture();
  const authority = new ClusterPluginPackageOciStageAuthority({
    allowedRegistries: [REGISTRY],
    trust: value.trust,
    fetch: value.fetch,
    requestTimeoutMs: 1_000,
  });
  const stage = await authority.stage(value.lock);
  assert.equal(stage.stageRef, `cluster-oci:${value.lock.lockDigest}`);
  assert.equal(stage.artifactDigest, value.lock.source.artifactDigest);
  assert.equal(stage.manifestDigest, value.lock.manifestDigest);
  assert.equal(stage.contentDigest, value.lock.source.contentDigest);
  assert.match(stage.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(value.calls(), 6);

  await authority.verify(value.lock, {
    ...stage,
    stagedAtMs: 201,
    receiptDigest: 'f'.repeat(64),
  });
  assert.equal(value.calls(), 6);
});

test('re-resolves durable stage evidence after a process restart', async () => {
  const value = fixture();
  const first = new ClusterPluginPackageOciStageAuthority({
    allowedRegistries: [REGISTRY],
    trust: value.trust,
    fetch: value.fetch,
  });
  const stage = await first.stage(value.lock);
  const restarted = new ClusterPluginPackageOciStageAuthority({
    allowedRegistries: [REGISTRY],
    trust: value.trust,
    fetch: value.fetch,
  });
  await restarted.verify(value.lock, {
    ...stage,
    stagedAtMs: 201,
    receiptDigest: 'f'.repeat(64),
  });
  assert.equal(value.calls(), 12);
});

test('captures one bounded verified OCI layer as a caller-owned resource session', async () => {
  const value = fixture();
  const authority = new ClusterPluginPackageOciStageAuthority({
    allowedRegistries: [REGISTRY],
    trust: value.trust,
    fetch: value.fetch,
  });
  const source = new ClusterPluginPackageOciResourceByteSource({
    authority,
    lockSource: {
      async findLock(lockDigest) {
        assert.equal(lockDigest, value.lock.lockDigest);
        return value.lock;
      },
    },
  });
  const reader = await source.open(value.generation);
  assert.deepEqual(
    await reader.read('package.json', 64 * 1024),
    Buffer.from(serializePluginPackageManifest(value.packageManifest)),
  );
  assert.deepEqual(
    await reader.read('tasks/collect.json', 1024 * 1024),
    value.resourceMaterial,
  );
  await assert.rejects(
    reader.read('tasks/collect.json', 1024 * 1024),
    /unknown or exceeds/,
  );
  await reader.close();
  assert.equal(value.calls(), 6);
});

test('fails before network access for a non-allowlisted registry', async () => {
  const value = fixture();
  const authority = new ClusterPluginPackageOciStageAuthority({
    allowedRegistries: ['other.example.com'],
    trust: value.trust,
    fetch: value.fetch,
  });
  await assert.rejects(
    authority.stage(value.lock),
    /registry is not explicitly allowed/,
  );
  assert.equal(value.calls(), 0);
});

test('rejects content that no longer matches the immutable OCI manifest digest', async () => {
  const value = fixture();
  const packageUrl = `https://${REGISTRY}/v2/${REPOSITORY}/manifests/sha256:${
    value.lock.source.locator.split('@sha256:')[1]
  }`;
  value.routes.set(packageUrl, Buffer.from('{}'));
  const authority = new ClusterPluginPackageOciStageAuthority({
    allowedRegistries: [REGISTRY],
    trust: value.trust,
    fetch: value.fetch,
  });
  await assert.rejects(
    authority.stage(value.lock),
    InvalidPluginPackageInstallError,
  );
});

test('injects one exact-registry credential without changing redirect policy', async () => {
  const value = fixture();
  const registries = [];
  const authority = new ClusterPluginPackageOciStageAuthority({
    allowedRegistries: [REGISTRY],
    trust: value.trust,
    credentialProvider: {
      authorizationFor(registry) {
        registries.push(registry);
        return 'Bearer exact-registry-token';
      },
    },
    fetch(url, init) {
      assert.equal(init.headers.authorization, 'Bearer exact-registry-token');
      assert.equal(init.redirect, 'error');
      return value.fetch(url, init);
    },
  });
  await authority.stage(value.lock);
  assert.deepEqual(registries, Array(6).fill(REGISTRY));
  assert.equal(value.calls(), 6);
});

test('never queries credentials before the source registry passes its allowlist', async () => {
  const value = fixture();
  let credentialCalls = 0;
  const authority = new ClusterPluginPackageOciStageAuthority({
    allowedRegistries: ['other.example.com'],
    trust: value.trust,
    credentialProvider: {
      authorizationFor() {
        credentialCalls += 1;
        return 'Bearer must-not-be-used';
      },
    },
    fetch: value.fetch,
  });
  await assert.rejects(
    authority.stage(value.lock),
    InvalidPluginPackageInstallError,
  );
  assert.equal(credentialCalls, 0);
  assert.equal(value.calls(), 0);
});

test('maps malformed credential-provider output to unavailable before fetch', async () => {
  const value = fixture();
  const authority = new ClusterPluginPackageOciStageAuthority({
    allowedRegistries: [REGISTRY],
    trust: value.trust,
    credentialProvider: {
      authorizationFor() {
        return 'Bearer secret\r\nx-overreach: true';
      },
    },
    fetch: value.fetch,
  });
  await assert.rejects(
    authority.stage(value.lock),
    PluginPackageInstallUnavailableError,
  );
  assert.equal(value.calls(), 0);
});
