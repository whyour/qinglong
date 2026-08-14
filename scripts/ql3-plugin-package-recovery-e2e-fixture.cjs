#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');

const FIXTURE_SCHEMA = 'qinglong/plugin-package-recovery-e2e-fixture@v1';
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
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);
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

function pluginManifest(architecture, version, invalidUpgrade = false) {
  const { PLUGIN_PACKAGE_API_VERSION, PLUGIN_PACKAGE_KIND } = ql3Require(
    '@qinglong/runtime-core/plugin-package',
  );
  return {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'e2e-monitor',
      displayName: 'E2E Monitor',
      version,
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
        tools: invalidUpgrade ? ['system.command'] : [],
      },
      contents: invalidUpgrade
        ? {
            tasks: ['tasks/noop.json'],
            workflows: ['workflows/cycle.json'],
            prompts: [],
            tools: [],
          }
        : { tasks: [], workflows: [], prompts: [], tools: [] },
    },
  };
}

function invalidUpgradeResources() {
  return Object.freeze({
    'tasks/noop.json': Object.freeze({
      schema: 'qinglong/plugin-package-task-resource@v1',
      id: 'noop',
      name: 'No-op',
      labels: Object.freeze({}),
      enabled: true,
      kind: 'command',
      spec: Object.freeze({
        schema: 'qinglong/command@v1',
        config: Object.freeze({
          command: Object.freeze({
            kind: 'argv',
            file: '/usr/bin/printf',
            args: Object.freeze(['ok']),
          }),
          environment: Object.freeze([]),
          timeoutMs: 30_000,
        }),
      }),
    }),
    'workflows/cycle.json': Object.freeze({
      schema: 'qinglong/plugin-package-workflow-resource@v1',
      id: 'cycle',
      name: 'Rejected cyclic workflow',
      enabled: true,
      steps: Object.freeze([
        Object.freeze({ id: 'first', task: 'noop', needs: ['second'] }),
        Object.freeze({ id: 'second', task: 'noop', needs: ['first'] }),
      ]),
    }),
  });
}

function route(path, mediaType, body) {
  return Object.freeze({
    path,
    mediaType,
    digest: sha256(body),
    body: body.toString('base64'),
  });
}

function packageMaterial(registry, manifest, resourceValues) {
  const { pluginPackageContentTreeDigest } = ql3Require(
    '@qinglong/runtime-core/plugin-package-bundle',
  );
  const { serializePluginPackageManifest } = ql3Require(
    '@qinglong/runtime-core/plugin-package-install',
  );
  const {
    PLUGIN_PACKAGE_OCI_ARTIFACT_TYPE,
    PLUGIN_PACKAGE_OCI_CONFIG_MEDIA_TYPE,
    PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE,
    PLUGIN_PACKAGE_OCI_SIGNATURE_CONFIG_MEDIA_TYPE,
  } = ql3Require('@qinglong/cluster-admin/plugin-package-oci-stage');
  const resourceEntries = Object.entries(resourceValues)
    .map(([entryPath, value]) => ({
      path: entryPath,
      body: jsonBytes(value),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const contentDigest = pluginPackageContentTreeDigest(
    resourceEntries.map((entry) => ({
      path: entry.path,
      bytes: entry.body.byteLength,
      digest: sha256(entry.body),
    })),
  );
  const artifact = canonicalTar([
    {
      path: 'package.json',
      body: Buffer.from(serializePluginPackageManifest(manifest), 'utf8'),
    },
    ...resourceEntries,
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
  return Object.freeze({
    manifest,
    source: Object.freeze({
      kind: 'oci',
      locator: `oci://${registry}/${REPOSITORY}@sha256:${packageManifestDigest}`,
      artifactDigest,
      artifactBytes: artifact.byteLength,
      contentDigest,
    }),
    packageConfig,
    packageConfigDigest,
    packageManifestBytes,
    packageManifestDigest,
    artifact,
    artifactDigest,
    mediaTypes: Object.freeze({
      packageConfig: PLUGIN_PACKAGE_OCI_CONFIG_MEDIA_TYPE,
      signatureArtifact: PLUGIN_PACKAGE_OCI_SIGNATURE_ARTIFACT_TYPE,
      signatureConfig: PLUGIN_PACKAGE_OCI_SIGNATURE_CONFIG_MEDIA_TYPE,
    }),
  });
}

function signedPackageRoutes(material, lock, privateKey) {
  const {
    PLUGIN_PACKAGE_SIGNATURE_SCHEMA,
    pluginPackagePublisherSignaturePayload,
  } = ql3Require('@qinglong/runtime-core/plugin-package-bundle');
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
    artifactType: material.mediaTypes.signatureArtifact,
    config: {
      mediaType: material.mediaTypes.signatureConfig,
      digest: `sha256:${signatureConfigDigest}`,
      size: signatureConfig.byteLength,
    },
    layers: [],
    subject: {
      mediaType: OCI_MANIFEST,
      digest: `sha256:${material.packageManifestDigest}`,
      size: material.packageManifestBytes.byteLength,
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
        artifactType: material.mediaTypes.signatureArtifact,
        annotations: {
          'qinglong.io/plugin-package-lock-digest': lock.lockDigest,
        },
      },
    ],
  });
  const prefix = `/v2/${REPOSITORY}`;
  return Object.freeze([
    route(
      `${prefix}/manifests/sha256:${material.packageManifestDigest}`,
      OCI_MANIFEST,
      material.packageManifestBytes,
    ),
    route(
      `${prefix}/blobs/sha256:${material.packageConfigDigest}`,
      material.mediaTypes.packageConfig,
      material.packageConfig,
    ),
    route(
      `${prefix}/referrers/sha256:${
        material.packageManifestDigest
      }?artifactType=${encodeURIComponent(
        material.mediaTypes.signatureArtifact,
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
      material.mediaTypes.signatureConfig,
      signatureConfig,
    ),
    route(
      `${prefix}/blobs/sha256:${material.artifactDigest}`,
      BUNDLE,
      material.artifact,
    ),
  ]);
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
  const { PluginPackagePublisherTrustRegistry } = ql3Require(
    '@qinglong/runtime-core/plugin-package-bundle',
  );
  const { planPluginPackageInstall } = ql3Require(
    '@qinglong/runtime-core/plugin-package',
  );
  const {
    createPluginPackageLock,
    pluginPackageInstallActionDigest,
    pluginPackageInstallPlanDigest,
  } = ql3Require('@qinglong/runtime-core/plugin-package-install');
  const { createPluginPackageResourceGenerationFromReferences } = ql3Require(
    '@qinglong/runtime-core/plugin-package-resource-generation',
  );
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture,
    deploymentProfile: 'cluster-control',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
  const initialManifest = pluginManifest(architecture, '1.0.0');
  const initialMaterial = packageMaterial(registry, initialManifest, {});
  const initialPlan = planPluginPackageInstall(initialManifest, environment);
  const initialAction = {
    lockId: 'lock-plugin-recovery-e2e-initial',
    projectId: 'default',
    manifest: initialManifest,
    plan: initialPlan,
    environment,
    source: initialMaterial.source,
    architecture,
    deploymentProfile: 'cluster-control',
    targetGeneration: 1,
  };
  const initialLock = createPluginPackageLock({
    ...initialAction,
    approval: {
      requestId: 'approval-plugin-recovery-e2e-initial',
      requestVersion: 1,
      dispatchId: 'dispatch-plugin-recovery-e2e-initial',
      actionDigest: pluginPackageInstallActionDigest(initialAction),
      previewDigest: pluginPackageInstallPlanDigest(initialPlan),
      approvedBy: { type: 'user', id: 'e2e-owner' },
      approvedAtMs: createdAtMs - 1,
      expiresAtMs: createdAtMs + 60 * 60 * 1000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs,
  });
  const upgradeCreatedAtMs = createdAtMs + 10;
  const upgradeManifest = pluginManifest(architecture, '2.0.0', true);
  const upgradeMaterial = packageMaterial(
    registry,
    upgradeManifest,
    invalidUpgradeResources(),
  );
  const upgradePlan = planPluginPackageInstall(
    upgradeManifest,
    environment,
    initialManifest,
  );
  const upgradeAction = {
    lockId: 'lock-plugin-recovery-e2e-upgrade',
    projectId: 'default',
    manifest: upgradeManifest,
    plan: upgradePlan,
    environment,
    previousManifest: initialManifest,
    source: upgradeMaterial.source,
    architecture,
    deploymentProfile: 'cluster-control',
    targetGeneration: 2,
    previousLockDigest: initialLock.lockDigest,
  };
  const upgradeLock = createPluginPackageLock({
    ...upgradeAction,
    approval: {
      requestId: 'approval-plugin-recovery-e2e-upgrade',
      requestVersion: 1,
      dispatchId: 'dispatch-plugin-recovery-e2e-upgrade',
      actionDigest: pluginPackageInstallActionDigest(upgradeAction),
      previewDigest: pluginPackageInstallPlanDigest(upgradePlan),
      approvedBy: { type: 'user', id: 'e2e-owner' },
      approvedAtMs: upgradeCreatedAtMs - 1,
      expiresAtMs: upgradeCreatedAtMs + 60 * 60 * 1000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: upgradeCreatedAtMs,
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
  const initialRoutes = signedPackageRoutes(
    initialMaterial,
    initialLock,
    privateKey,
  );
  const upgradeRoutes = signedPackageRoutes(
    upgradeMaterial,
    upgradeLock,
    privateKey,
  );
  const initial = Object.freeze({
    installationId: 'install-plugin-recovery-e2e-initial',
    manifest: initialManifest,
    lock: initialLock,
    generation: createPluginPackageResourceGenerationFromReferences({
      installationId: 'install-plugin-recovery-e2e-initial',
      projectId: initialLock.projectId,
      packageName: initialLock.packageName,
      lockDigest: initialLock.lockDigest,
      generation: initialLock.targetGeneration,
      previousActiveLockDigest: null,
      contentDigest: initialLock.source.contentDigest,
      resources: initialLock.resources,
    }),
    routes: initialRoutes,
  });
  const upgrade = Object.freeze({
    installationId: 'install-plugin-recovery-e2e-upgrade',
    manifest: upgradeManifest,
    lock: upgradeLock,
    generation: createPluginPackageResourceGenerationFromReferences({
      installationId: 'install-plugin-recovery-e2e-upgrade',
      projectId: upgradeLock.projectId,
      packageName: upgradeLock.packageName,
      lockDigest: upgradeLock.lockDigest,
      generation: upgradeLock.targetGeneration,
      previousActiveLockDigest: initialLock.lockDigest,
      contentDigest: upgradeLock.source.contentDigest,
      resources: upgradeLock.resources,
    }),
    routes: upgradeRoutes,
  });
  return Object.freeze({
    schema: FIXTURE_SCHEMA,
    registry,
    repository: REPOSITORY,
    architecture,
    lock: initialLock,
    initial,
    upgrade,
    trust,
    routes: Object.freeze([...initialRoutes, ...upgradeRoutes]),
  });
}

function readFixture(filePath) {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (
    !value ||
    value.schema !== FIXTURE_SCHEMA ||
    !Array.isArray(value.routes) ||
    !value.initial?.lock ||
    !value.initial?.generation ||
    !value.upgrade?.lock ||
    !value.upgrade?.generation ||
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
    PostgresPluginPackageSecretBindingTransitionRepository,
  } = ql3Require('@qinglong/cluster-postgres/package-executor');
  const { PostgresPluginPackageInstallRepository } = ql3Require(
    '@qinglong/cluster-postgres/plugin-package-install',
  );
  const {
    createPluginPackageInstall,
    normalizePluginPackageLock,
    pluginPackageInstallCreate,
  } = ql3Require('@qinglong/runtime-core/plugin-package-install');
  const { createPluginPackageSecretBindingTarget } = ql3Require(
    '@qinglong/runtime-core/plugin-package-secret-binding',
  );
  const { createPluginPackageSecretBindingTransitionPlan } = ql3Require(
    '@qinglong/runtime-core/plugin-package-secret-binding-transition-plan',
  );
  const fixture = readFixture(process.env.QL3_E2E_FIXTURE_FILE);
  const mode = process.env.QL3_E2E_MODE;
  if (!['seed-initial', 'seed-upgrade', 'commit-transition'].includes(mode)) {
    throw new Error('Plugin Package E2E seed mode is invalid');
  }
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
    if (mode === 'commit-transition') {
      const plannedAtMs = Date.now();
      const transitionPlan = createPluginPackageSecretBindingTransitionPlan({
        previousTarget: createPluginPackageSecretBindingTarget(
          fixture.initial.generation,
          fixture.initial.manifest,
        ),
        previousBinding: null,
        previousAttemptGeneration: 1,
        nextGeneration: fixture.upgrade.generation,
        nextManifest: fixture.upgrade.manifest,
        assignments: [],
        plannedAtMs,
      });
      const result =
        await new PostgresPluginPackageSecretBindingTransitionRepository(
          database.pool,
        ).apply({
          transitionPlan,
          evidenceDigest: transitionPlan.transitionDigest,
          committedAtMs: plannedAtMs + 1,
        });
      process.stdout.write(
        `${JSON.stringify({
          schema: 'qinglong/plugin-package-recovery-e2e-transition-result@v1',
          event: 'transition_completed',
          status: result.status,
          generationDigest: transitionPlan.nextTarget.generationDigest,
          transitionDigest: transitionPlan.transitionDigest,
          bindingDigest: result.receipt.bindingDigest,
          receiptDigest: result.receipt.receiptDigest,
        })}\n`,
      );
      return;
    }
    const selected =
      mode === 'seed-initial' ? fixture.initial : fixture.upgrade;
    const lock = normalizePluginPackageLock(selected.lock);
    const repository = new PostgresPluginPackageInstallRepository(
      database.pool,
    );
    const previous = await repository.find(lock.projectId, lock.packageName);
    if (
      (mode === 'seed-initial' && previous !== null) ||
      (mode === 'seed-upgrade' &&
        (previous?.state !== 'active' ||
          previous.installationId !== fixture.initial.installationId ||
          previous.lockDigest !== fixture.initial.lock.lockDigest))
    ) {
      throw new Error('Plugin Package E2E previous install head is invalid');
    }
    const record = createPluginPackageInstall(lock, {
      installationId: selected.installationId,
      mutationId: `mutation-plugin-recovery-e2e-${
        mode === 'seed-initial' ? 'initial' : 'upgrade'
      }-create`,
      occurredAtMs: lock.createdAtMs + 1,
    });
    const result = await repository.create(
      pluginPackageInstallCreate(lock, record, previous),
    );
    process.stdout.write(
      `${JSON.stringify({
        schema: 'qinglong/plugin-package-recovery-e2e-seed-result@v1',
        event: 'seed_completed',
        phase: mode === 'seed-initial' ? 'initial' : 'upgrade',
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
  if (
    ['seed-initial', 'seed-upgrade', 'commit-transition'].includes(
      process.env.QL3_E2E_MODE,
    )
  ) {
    await runSeed();
    return;
  }
  throw new Error(
    'QL3_E2E_MODE must be registry, seed-initial, seed-upgrade or commit-transition',
  );
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
