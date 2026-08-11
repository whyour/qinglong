const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  InvalidPluginPackageBundleError,
  InvalidPluginPackagePublisherTrustError,
  PLUGIN_PACKAGE_BUNDLE_MEDIA_TYPE,
  PLUGIN_PACKAGE_SIGNATURE_SCHEMA,
  PluginPackageBundleUnavailableError,
  PluginPackagePublisherTrustRegistry,
  UntrustedPluginPackagePublisherError,
  inspectPluginPackageBundle,
  pluginPackageContentTreeDigest,
  pluginPackagePublisherSignaturePayload,
} = require('../dist/plugin-package/pluginPackageBundle');
const {
  createPluginPackageLock,
  pluginPackageInstallActionDigest,
  pluginPackageInstallPlanDigest,
  pluginPackageManifestDigest,
  serializePluginPackageManifest,
} = require('../dist/plugin-package/installation/pluginPackageInstall');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('../dist/plugin-package/pluginPackage');

const PUBLISHER = 'packages.example.com';
const KEY_ID = 'release-2026';
const OBSERVED_AT_MS = 500;

function manifest() {
  return {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.2.0',
      description: 'Collects one bounded report',
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
        network: { allowedHosts: ['api.example.com'] },
        secrets: [{ name: 'EXAMPLE_TOKEN', required: true }],
        tools: ['notification.send'],
      },
      contents: {
        tasks: ['tasks/collect.yaml'],
        workflows: ['workflows/daily.yaml'],
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

function octal(value, bytes) {
  return Buffer.from(
    `${value.toString(8).padStart(bytes - 1, '0')}\0`,
    'ascii',
  );
}

function tarHeader(path, bytes) {
  const header = Buffer.alloc(512);
  const pathBytes = Buffer.from(path);
  if (pathBytes.byteLength > 100) throw new Error('test path is too long');
  pathBytes.copy(header, 0);
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture() {
  const packageManifest = manifest();
  const canonicalManifest = Buffer.from(
    serializePluginPackageManifest(packageManifest),
  );
  const contents = [
    {
      path: 'tasks/collect.yaml',
      body: Buffer.from('apiVersion: qinglong.io/v1\\nkind: Task\\n'),
    },
    {
      path: 'workflows/daily.yaml',
      body: Buffer.from('apiVersion: qinglong.io/v1\\nkind: Workflow\\n'),
    },
  ];
  const artifact = tar([
    { path: 'package.json', body: canonicalManifest },
    ...contents,
  ]);
  const contentDescriptors = contents.map(({ path, body }) => ({
    path,
    bytes: body.byteLength,
    digest: sha256(body),
  }));
  const installEnvironment = environment();
  const plan = planPluginPackageInstall(packageManifest, installEnvironment);
  const source = {
    kind: 'offline',
    locator: `offline:sha256:${sha256(artifact)}`,
    artifactDigest: sha256(artifact),
    artifactBytes: artifact.byteLength,
    contentDigest: pluginPackageContentTreeDigest(contentDescriptors),
  };
  const actionInput = {
    lockId: 'lock-bundle-001',
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
  return {
    artifact,
    canonicalManifest,
    contentDescriptors,
    lock,
    packageManifest,
    privateKey,
    signature,
    trust,
  };
}

async function* chunks(value, widths = [1, 17, 509, 3, 1024]) {
  let offset = 0;
  let index = 0;
  while (offset < value.byteLength) {
    const end = Math.min(
      value.byteLength,
      offset + widths[index % widths.length],
    );
    yield value.subarray(offset, end);
    offset = end;
    index += 1;
  }
}

function inspect(value, overrides = {}) {
  return inspectPluginPackageBundle({
    lock: value.lock,
    manifest: value.packageManifest,
    signature: value.signature,
    trust: value.trust,
    observedAtMs: OBSERVED_AT_MS,
    chunks: chunks(value.artifact),
    ...overrides,
  });
}

test('inspects one canonical streaming USTAR bundle and publisher signature', async () => {
  const value = fixture();
  const inspection = await inspect(value);
  assert.equal(inspection.mediaType, PLUGIN_PACKAGE_BUNDLE_MEDIA_TYPE);
  assert.equal(inspection.lockDigest, value.lock.lockDigest);
  assert.equal(inspection.artifactDigest, value.lock.source.artifactDigest);
  assert.equal(
    inspection.manifestDigest,
    pluginPackageManifestDigest(manifest()),
  );
  assert.equal(inspection.contentDigest, value.lock.source.contentDigest);
  assert.deepEqual(
    inspection.entries.map(({ path }) => path),
    ['package.json', 'tasks/collect.yaml', 'workflows/daily.yaml'],
  );
  assert.equal(inspection.signature.publisher, PUBLISHER);
  assert.equal(Object.isFrozen(inspection), true);
});

test('streams exact entry bytes through a transactional sink', async () => {
  const value = fixture();
  const events = [];
  const bodies = [];
  let current = [];
  await inspect(value, {
    chunks: chunks(value.artifact, [7]),
    sink: {
      begin(entry) {
        events.push(`begin:${entry.path}`);
        current = [];
      },
      write(chunk) {
        current.push(Buffer.from(chunk));
      },
      end(entry) {
        events.push(`end:${entry.path}`);
        bodies.push(Buffer.concat(current));
      },
      commit(inspection) {
        events.push(`commit:${inspection.lockDigest}`);
      },
      abort() {
        events.push('abort');
      },
    },
  });
  assert.deepEqual(bodies[0], value.canonicalManifest);
  assert.equal(
    bodies[1].toString(),
    'apiVersion: qinglong.io/v1\\nkind: Task\\n',
  );
  assert.equal(events.at(-1), `commit:${value.lock.lockDigest}`);
  assert.equal(events.includes('abort'), false);
});

test('rejects missing, extra, reordered and non-canonical archive entries', async () => {
  const value = fixture();
  const taskBody = Buffer.from('apiVersion: qinglong.io/v1\\nkind: Task\\n');
  const workflowBody = Buffer.from(
    'apiVersion: qinglong.io/v1\\nkind: Workflow\\n',
  );
  const variants = [
    tar([
      { path: 'package.json', body: value.canonicalManifest },
      { path: 'workflows/daily.yaml', body: workflowBody },
      { path: 'tasks/collect.yaml', body: taskBody },
    ]),
    tar([
      { path: 'package.json', body: value.canonicalManifest },
      { path: 'tasks/collect.yaml', body: taskBody },
    ]),
  ];
  for (const artifact of variants) {
    await assert.rejects(
      inspect(value, { chunks: chunks(artifact) }),
      InvalidPluginPackageBundleError,
    );
  }
  const invalidMode = Buffer.from(value.artifact);
  Buffer.from('0000755\0').copy(invalidMode, 100);
  await assert.rejects(
    inspect(value, { chunks: chunks(invalidMode) }),
    InvalidPluginPackageBundleError,
  );
  const splitPath = Buffer.from(value.artifact);
  const splitHeaderOffset =
    512 + Math.ceil(value.canonicalManifest.byteLength / 512) * 512;
  assert.equal(
    splitPath
      .subarray(splitHeaderOffset, splitHeaderOffset + 100)
      .toString('utf8')
      .replace(/\0+$/, ''),
    'tasks/collect.yaml',
  );
  splitPath.fill(0, splitHeaderOffset, splitHeaderOffset + 100);
  Buffer.from('collect.yaml').copy(splitPath, splitHeaderOffset);
  Buffer.from('tasks').copy(splitPath, splitHeaderOffset + 345);
  splitPath.fill(0x20, splitHeaderOffset + 148, splitHeaderOffset + 156);
  const splitChecksum = splitPath
    .subarray(splitHeaderOffset, splitHeaderOffset + 512)
    .reduce((total, byte) => total + byte, 0);
  Buffer.from(`${splitChecksum.toString(8).padStart(6, '0')}\0 `).copy(
    splitPath,
    splitHeaderOffset + 148,
  );
  await assert.rejects(
    inspect(value, { chunks: chunks(splitPath) }),
    InvalidPluginPackageBundleError,
  );
  await assert.rejects(
    inspect(value, {
      chunks: chunks(Buffer.concat([value.artifact, Buffer.alloc(512)])),
    }),
    InvalidPluginPackageBundleError,
  );
});

test('binds artifact, manifest and content digests to the immutable PackageLock', async () => {
  const value = fixture();
  const tampered = Buffer.from(value.artifact);
  tampered[512] ^= 1;
  await assert.rejects(
    inspect(value, { chunks: chunks(tampered) }),
    InvalidPluginPackageBundleError,
  );
  await assert.rejects(
    inspect(value, {
      manifest: {
        ...value.packageManifest,
        metadata: {
          ...value.packageManifest.metadata,
          description: 'changed after approval',
        },
      },
    }),
    InvalidPluginPackageBundleError,
  );
});

test('rejects unknown, expired and invalid Ed25519 publisher signatures', async () => {
  const value = fixture();
  const invalidSignature = Buffer.from(
    value.signature.signature,
    'base64url',
  );
  invalidSignature[0] ^= 1;
  await assert.rejects(
    inspect(value, { observedAtMs: 1_000 }),
    UntrustedPluginPackagePublisherError,
  );
  await assert.rejects(
    inspect(value, {
      signature: {
        ...value.signature,
        signature: invalidSignature.toString('base64url'),
      },
    }),
    UntrustedPluginPackagePublisherError,
  );
  assert.throws(
    () =>
      new PluginPackagePublisherTrustRegistry([
        {
          publisher: PUBLISHER,
          keyId: KEY_ID,
          publicKeyPem: 'not a public key',
          notBeforeMs: 0,
          notAfterMs: 1,
        },
      ]),
    InvalidPluginPackagePublisherTrustError,
  );
});

test('aborts a sink exactly once and hides infrastructure failure details', async () => {
  const value = fixture();
  let aborts = 0;
  await assert.rejects(
    inspect(value, {
      sink: {
        begin() {},
        write() {
          throw new Error('private filesystem detail');
        },
        end() {},
        commit() {},
        abort() {
          aborts += 1;
        },
      },
    }),
    PluginPackageBundleUnavailableError,
  );
  assert.equal(aborts, 1);
});

test('rejects unsafe public content descriptors and oversized chunks', async () => {
  assert.throws(
    () =>
      pluginPackageContentTreeDigest([
        { path: '../escape', bytes: 1, digest: 'a'.repeat(64) },
      ]),
    InvalidPluginPackageBundleError,
  );
  const value = fixture();
  async function* oversized() {
    yield Buffer.alloc(1024 * 1024 + 1);
  }
  await assert.rejects(
    inspect(value, { chunks: oversized() }),
    InvalidPluginPackageBundleError,
  );
});

test('publishes bundle authority only through its explicit subpath', () => {
  const root = require('../dist');
  const subpath = require('@qinglong/runtime-core/plugin-package-bundle');
  assert.equal(root.inspectPluginPackageBundle, undefined);
  assert.equal(subpath.inspectPluginPackageBundle, inspectPluginPackageBundle);
  const source = readFileSync(
    join(__dirname, '..', 'src', 'plugin-package', 'pluginPackageBundle.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /node:(?:fs|net|http|https|tls|dgram)/);
  assert.doesNotMatch(source, /\b(?:setTimeout|setInterval|process)\b/);
});
