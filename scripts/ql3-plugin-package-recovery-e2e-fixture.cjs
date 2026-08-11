#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { createRequire } = require('node:module');
const {
  createHash,
  generateKeyPairSync,
  sign,
} = require('node:crypto');

const FIXTURE_SCHEMA =
  'qinglong/plugin-package-recovery-e2e-fixture@v1';
const REGISTRY_EVENT_SCHEMA =
  'qinglong/plugin-package-recovery-e2e-registry-event@v1';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const BUNDLE = 'application/vnd.qinglong.package.v1+tar';
const PUBLISHER = 'plugin-e2e.qinglong.test';
const KEY_ID = 'e2e-release-1';
const REPOSITORY = 'qinglong/e2e-monitor';
const TRUST_SCHEMA = 'qinglong/plugin-package-publisher-trust@v1';

function ql3Require(specifier) {
  try {
    return require(specifier);
  } catch (error) {
    const workspaceManifest = path.resolve(
      __dirname,
      '..',
      'packages',
      'ql3-cluster-admin',
      'package.json',
    );
    if (
      error?.code !== 'MODULE_NOT_FOUND' ||
      !error.message.includes(specifier) ||
      !fs.existsSync(workspaceManifest)
    ) {
      throw error;
    }
    return createRequire(workspaceManifest)(specifier);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function octal(value, width) {
  return Buffer.from(
    `${value.toString(8).padStart(width - 1, '0')}\0`,
    'ascii',
  );
}

function tarHeader(entryPath, size) {
  const header = Buffer.alloc(512);
  Buffer.from(entryPath, 'utf8').copy(header, 0);
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
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `).copy(
    header,
    148,
  );
  return header;
}

function canonicalTar(entries) {
  const parts = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry.path, entry.body.byteLength), entry.body);
    const padding = (512 - (entry.body.byteLength % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function pluginManifest(architecture) {
  const {
    PLUGIN_PACKAGE_API_VERSION,
    PLUGIN_PACKAGE_KIND,
  } = ql3Require('@qinglong/runtime-core/plugin-package');
  return {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'e2e-monitor',
      displayName: 'E2E Monitor',
      version: '1.0.0',
      description: 'One bounded end-to-end recovery package',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: [architecture],
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
      contents: { tasks: [], workflows: [], prompts: [], tools: [] },
    },
  };
}

function route(path, mediaType, body) {
  return Object.freeze({
    path,
    mediaType,
    digest: sha256(body),
    body: body.toString('base64'),
  });
}

function createFixture({ registry, architecture, createdAtMs = Date.now() }) {
  if (
    typeof registry !== 'string' ||
    !/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(registry) ||
    !['amd64', 'arm64'].includes(architecture) ||
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 1
  ) {
    throw new TypeError('Plugin Package E2E fixture options are invalid');
  }
  const {
    PluginPackagePublisherTrustRegistry,
    PLUGIN_PACKAGE_SIGNATURE_SCHEMA,
    pluginPackageContentTreeDigest,
    pluginPackagePublisherSignaturePayload,
  } = ql3Require('@qinglong/runtime-core/plugin-package-bundle');
  const {
    planPluginPackageInstall,
  } = ql3Require('@qinglong/runtime-core/plugin-package');
  const {
    createPluginPackageLock,
    pluginPackageInstallActionDigest,
    pluginPackageInstallPlanDigest,
    serializePluginPackageManifest,
  } = ql3Require('@qinglong/runtime-core/plugin-package-install');
  const {
    PLUGIN_PACKAGE_OCI_ARTIFACT_TYPE,
    PLUGIN_PACKAGE_OCI_CONFIG_MEDIA_TYPE,
    PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE,
    PLUGIN_PACKAGE_OCI_SIGNATURE_CONFIG_MEDIA_TYPE,
  } = ql3Require('@qinglong/cluster-admin/plugin-package-oci-stage');

  const manifest = pluginManifest(architecture);
  const artifact = canonicalTar([
    {
      path: 'package.json',
      body: Buffer.from(serializePluginPackageManifest(manifest), 'utf8'),
    },
  ]);
  const packageConfig = jsonBytes({
    schema: 'qinglong/plugin-package-oci-config@v1',
    manifest,
  });
  const packageConfigDigest = sha256(packageConfig);
  const artifactDigest = sha256(artifact);
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
        digest: `sha256:${artifactDigest}`,
        size: artifact.byteLength,
      },
    ],
  };
  const packageManifestBytes = jsonBytes(packageManifestValue);
  const packageManifestDigest = sha256(packageManifestBytes);
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture,
    deploymentProfile: 'cluster-control',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
  const plan = planPluginPackageInstall(manifest, environment);
  const source = {
    kind: 'oci',
    locator: `oci://${registry}/${REPOSITORY}@sha256:${packageManifestDigest}`,
    artifactDigest,
    artifactBytes: artifact.byteLength,
    contentDigest: pluginPackageContentTreeDigest([]),
  };
  const action = {
    lockId: 'lock-plugin-recovery-e2e',
    projectId: 'default',
    manifest,
    plan,
    environment,
    source,
    architecture,
    deploymentProfile: 'cluster-control',
    targetGeneration: 1,
  };
  const lock = createPluginPackageLock({
    ...action,
    approval: {
      requestId: 'approval-plugin-recovery-e2e',
      requestVersion: 1,
      dispatchId: 'dispatch-plugin-recovery-e2e',
      actionDigest: pluginPackageInstallActionDigest(action),
      previewDigest: pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'e2e-owner' },
      approvedAtMs: createdAtMs - 1,
      expiresAtMs: createdAtMs + 60 * 60 * 1000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs,
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' });
  const trust = {
    schema: TRUST_SCHEMA,
    keys: [
      {
        publisher: PUBLISHER,
        keyId: KEY_ID,
        publicKeyPem,
        notBeforeMs: createdAtMs - 1,
        notAfterMs: createdAtMs + 60 * 60 * 1000,
      },
    ],
  };
  new PluginPackagePublisherTrustRegistry(trust.keys);
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
  const signatureConfig = jsonBytes(signature);
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
  const signatureManifestBytes = jsonBytes(signatureManifestValue);
  const signatureManifestDigest = sha256(signatureManifestBytes);
  const referrers = jsonBytes({
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
  const prefix = `/v2/${REPOSITORY}`;
  const routes = [
    route(
      `${prefix}/manifests/sha256:${packageManifestDigest}`,
      OCI_MANIFEST,
      packageManifestBytes,
    ),
    route(
      `${prefix}/blobs/sha256:${packageConfigDigest}`,
      PLUGIN_PACKAGE_OCI_CONFIG_MEDIA_TYPE,
      packageConfig,
    ),
    route(
      `${prefix}/referrers/sha256:${packageManifestDigest}?artifactType=${encodeURIComponent(
        PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE,
      )}`,
      OCI_INDEX,
      referrers,
    ),
    route(
      `${prefix}/manifests/sha256:${signatureManifestDigest}`,
      OCI_MANIFEST,
      signatureManifestBytes,
    ),
    route(
      `${prefix}/blobs/sha256:${signatureConfigDigest}`,
      PLUGIN_PACKAGE_OCI_SIGNATURE_CONFIG_MEDIA_TYPE,
      signatureConfig,
    ),
    route(
      `${prefix}/blobs/sha256:${artifactDigest}`,
      BUNDLE,
      artifact,
    ),
  ];
  return Object.freeze({
    schema: FIXTURE_SCHEMA,
    registry,
    repository: REPOSITORY,
    architecture,
    lock,
    trust,
    routes,
  });
}

function readFixture(filePath) {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (
    !value ||
    value.schema !== FIXTURE_SCHEMA ||
    !Array.isArray(value.routes) ||
    !value.lock ||
    !value.trust
  ) {
    throw new Error('Plugin Package E2E fixture is invalid');
  }
  return value;
}

function registryEvent(path, status, digest, authenticated = false) {
  process.stdout.write(
    `${JSON.stringify({
      schema: REGISTRY_EVENT_SCHEMA,
      method: 'GET',
      path,
      status,
      authenticated,
      ...(digest ? { digest } : {}),
    })}\n`,
  );
}

async function runRegistry() {
  const fixture = readFixture(process.env.QL3_E2E_FIXTURE_FILE);
  const routes = new Map(fixture.routes.map((value) => [value.path, value]));
  const port = Number(process.env.QL3_E2E_REGISTRY_PORT ?? '8443');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Plugin Package E2E registry port is invalid');
  }
  const authorization = process.env.QL3_E2E_REGISTRY_AUTHORIZATION;
  if (
    typeof authorization !== 'string' ||
    authorization.length < 8 ||
    authorization.length > 16 * 1024 ||
    !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(authorization)
  ) {
    throw new Error('Plugin Package E2E registry authorization is invalid');
  }
  const server = https.createServer(
    {
      cert: fs.readFileSync(process.env.QL3_E2E_REGISTRY_CERT_FILE),
      key: fs.readFileSync(process.env.QL3_E2E_REGISTRY_KEY_FILE),
    },
    (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        registryEvent(request.url, 405);
        return;
      }
      if (request.headers.authorization !== authorization) {
        response.writeHead(401, {
          'content-length': '0',
          'www-authenticate': 'Basic realm="ql3-plugin-package-e2e"',
        });
        response.end();
        registryEvent(request.url, 401);
        return;
      }
      if (request.url === '/v2/' || request.url === '/v2') {
        const body = Buffer.from('{}\n', 'utf8');
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(body.byteLength),
          'docker-distribution-api-version': 'registry/2.0',
        });
        response.end(body);
        registryEvent(request.url, 200, undefined, true);
        return;
      }
      const routeValue = routes.get(request.url);
      if (!routeValue) {
        response.writeHead(404, { 'content-length': '0' });
        response.end();
        registryEvent(request.url, 404, undefined, true);
        return;
      }
      const body = Buffer.from(routeValue.body, 'base64');
      response.writeHead(200, {
        'content-type': routeValue.mediaType,
        'content-length': String(body.byteLength),
        'docker-content-digest': `sha256:${routeValue.digest}`,
        'docker-distribution-api-version': 'registry/2.0',
      });
      response.end(body);
      registryEvent(request.url, 200, routeValue.digest, true);
    },
  );
  server.on('clientError', (error, socket) => {
    socket.destroy(error);
  });
  const close = () => server.close();
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
}

async function runSeed() {
  const {
    assertPostgresPackageExecutorSchemaReady,
    createPostgresDatabaseOpener,
    loadPostgresConnectionEnvironment,
  } = ql3Require('@qinglong/cluster-postgres/package-executor');
  const {
    PostgresPluginPackageInstallRepository,
  } = ql3Require('@qinglong/cluster-postgres/plugin-package-install');
  const {
    createPluginPackageInstall,
    normalizePluginPackageLock,
    pluginPackageInstallCreate,
  } = ql3Require('@qinglong/runtime-core/plugin-package-install');
  const fixture = readFixture(process.env.QL3_E2E_FIXTURE_FILE);
  const lock = normalizePluginPackageLock(fixture.lock);
  const connection = loadPostgresConnectionEnvironment(process.env, {
    host: 'QL3_E2E_POSTGRES_HOST',
    port: 'QL3_E2E_POSTGRES_PORT',
    database: 'QL3_E2E_POSTGRES_DATABASE',
    user: 'QL3_E2E_POSTGRES_PACKAGE_EXECUTOR_USER',
    password: 'QL3_E2E_POSTGRES_PACKAGE_EXECUTOR_PASSWORD',
  });
  const database = await createPostgresDatabaseOpener({
    role: 'package-executor',
    connection: { ...connection, tls: { mode: 'disable' } },
    pool: {
      applicationName: 'qinglong3-plugin-package-e2e-seed',
      maxConnections: 1,
      connectionTimeoutMs: 15_000,
    },
    onPoolError() {},
  })();
  try {
    await assertPostgresPackageExecutorSchemaReady(database.pool);
    const repository = new PostgresPluginPackageInstallRepository(
      database.pool,
    );
    const record = createPluginPackageInstall(lock, {
      installationId: 'install-plugin-recovery-e2e',
      mutationId: 'mutation-plugin-recovery-e2e-create',
      occurredAtMs: lock.createdAtMs + 1,
    });
    const result = await repository.create(
      pluginPackageInstallCreate(lock, record, null),
    );
    process.stdout.write(
      `${JSON.stringify({
        schema: 'qinglong/plugin-package-recovery-e2e-seed-result@v1',
        event: 'seed_completed',
        status: result.status,
        state: result.record.state,
        installationId: result.record.installationId,
        lockDigest: result.record.lockDigest,
        recordDigest: result.record.recordDigest,
      })}\n`,
    );
  } finally {
    await database.close();
  }
}

async function main() {
  if (process.env.QL3_E2E_MODE === 'registry') {
    await runRegistry();
    return;
  }
  if (process.env.QL3_E2E_MODE === 'seed') {
    await runSeed();
    return;
  }
  throw new Error('QL3_E2E_MODE must be registry or seed');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        schema: 'qinglong/plugin-package-recovery-e2e-failure@v1',
        name: error?.name ?? 'Error',
        message: error?.message ?? 'unknown failure',
      })}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  FIXTURE_SCHEMA,
  REGISTRY_EVENT_SCHEMA,
  createFixture,
};
