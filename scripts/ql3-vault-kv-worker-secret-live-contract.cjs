#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const https = require('node:https');
const { isIP } = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  createSecretRef,
} = require('../packages/ql3-runtime-core/dist/secret/secretReference.js');
const {
  secretProjectionFileName,
} = require('../packages/ql3-runtime-core/dist/secret/secretProjection.js');
const {
  ClusterVaultKvSecretProviderError,
  createClusterVaultKvSecretProvider,
} = require('../packages/ql3-cluster-control/dist/remote-execution/vaultKvSecretProvider.js');

const IMAGE =
  'docker.io/hashicorp/vault@sha256:4e33b126a59c0c333b76fb4e894722462659a6bec7c48c9ee8cea56fccfd2569';
const FIXTURE = 'qinglong/vault-kv-worker-secret-direct-custody-live@v1';
const MAX_RESPONSE_BYTES = 256 * 1024;
const VAULT_TIMEOUT_MS = 10_000;
const POLICY = 'ql3-worker-secret-read';
const MOUNT = 'worker-secrets';
const PREFIX = 'values/production';

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`Docker command failed: ${args[0] ?? 'unknown'}`);
  }
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function privateFile(directory, name, value, mode = 0o440) {
  const target = path.join(directory, name);
  writeFileSync(target, value, { mode: 0o600, flag: 'wx' });
  chmodSync(target, mode);
  return target;
}

function openssl(args) {
  const result = spawnSync('openssl', args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('OpenSSL command failed');
}

function generateTlsAuthority(directory) {
  const tlsDirectory = path.join(directory, 'tls');
  mkdirSync(tlsDirectory, { mode: 0o700 });
  const caKeyFile = path.join(tlsDirectory, 'ca-key.pem');
  const caFile = path.join(tlsDirectory, 'ca.pem');
  const serverKeyFile = path.join(tlsDirectory, 'server-key.pem');
  const serverRequestFile = path.join(tlsDirectory, 'server.csr');
  const serverCertificateFile = path.join(tlsDirectory, 'server.pem');
  const untrustedCaKeyFile = path.join(tlsDirectory, 'untrusted-ca-key.pem');
  const untrustedCaFile = path.join(tlsDirectory, 'untrusted-ca.pem');
  const extensionsFile = privateFile(
    tlsDirectory,
    'server-extensions.cnf',
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '',
    ].join('\n'),
    0o400,
  );
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=QingLong 3 Vault KV Live Root',
    '-addext',
    'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout',
    caKeyFile,
    '-out',
    caFile,
  ]);
  openssl([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-subj',
    '/CN=127.0.0.1',
    '-keyout',
    serverKeyFile,
    '-out',
    serverRequestFile,
  ]);
  openssl([
    'x509',
    '-req',
    '-sha256',
    '-days',
    '2',
    '-in',
    serverRequestFile,
    '-CA',
    caFile,
    '-CAkey',
    caKeyFile,
    '-CAcreateserial',
    '-extfile',
    extensionsFile,
    '-out',
    serverCertificateFile,
  ]);
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=QingLong 3 Untrusted Vault KV Root',
    '-addext',
    'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout',
    untrustedCaKeyFile,
    '-out',
    untrustedCaFile,
  ]);
  chmodSync(caKeyFile, 0o400);
  chmodSync(caFile, 0o440);
  chmodSync(serverKeyFile, 0o400);
  chmodSync(serverRequestFile, 0o400);
  chmodSync(serverCertificateFile, 0o440);
  chmodSync(untrustedCaKeyFile, 0o400);
  chmodSync(untrustedCaFile, 0o440);
  return Object.freeze({
    tlsDirectory,
    caFile,
    serverCertificateFile,
    serverKeyFile,
    untrustedCaFile,
  });
}

function vaultJson(endpoint, ca, token, method, requestPath, body) {
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const target = new URL(requestPath, endpoint);
  return new Promise((resolve, reject) => {
    const request = https.request(
      target,
      {
        method,
        ca,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        ...(isIP(target.hostname) === 0 ? { servername: target.hostname } : {}),
        headers: {
          accept: 'application/json',
          ...(bytes === null
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(bytes.byteLength),
              }),
          ...(token === null ? {} : { 'x-vault-token': token }),
        },
      },
      (response) => {
        const tlsProtocol = response.socket.getProtocol();
        const peerAuthorized = response.socket.authorized;
        const chunks = [];
        let length = 0;
        response.on('data', (chunk) => {
          length += chunk.byteLength;
          if (length > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('Vault response exceeded live limit'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once('error', reject);
        response.on('end', () => {
          const responseBytes = Buffer.concat(chunks);
          chunks.forEach((chunk) => chunk.fill(0));
          try {
            resolve({
              statusCode: response.statusCode,
              value: responseBytes.byteLength
                ? JSON.parse(responseBytes.toString('utf8'))
                : null,
              tlsProtocol,
              peerAuthorized,
            });
          } catch (cause) {
            reject(cause);
          } finally {
            responseBytes.fill(0);
          }
        });
      },
    );
    request.setTimeout(VAULT_TIMEOUT_MS, () =>
      request.destroy(new Error('Vault live request timed out')),
    );
    request.once('error', reject);
    request.once('close', () => bytes?.fill(0));
    request.end(bytes ?? undefined);
  });
}

async function waitForVault(endpoint, ca, expected) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const health = await vaultJson(
        endpoint,
        ca,
        null,
        'GET',
        '/v1/sys/health',
      );
      if (
        health.statusCode === expected.statusCode &&
        health.value?.initialized === expected.initialized &&
        health.value?.sealed === expected.sealed
      ) {
        assert.equal(health.tlsProtocol, 'TLSv1.3');
        assert.equal(health.peerAuthorized, true);
        return health;
      }
    } catch (cause) {
      lastError = cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  const detail =
    lastError instanceof Error
      ? `${
          typeof lastError.code === 'string' ? lastError.code : lastError.name
        }:${lastError.message}`
      : 'no-health-response';
  throw new Error(
    `Vault server did not reach the expected state (${detail.slice(0, 256)})`,
    { cause: lastError },
  );
}

function startVaultContainer(container, publish, directory, tls) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 100;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    container,
    '--publish',
    publish,
    '--user',
    `${uid}:${gid}`,
    '--cap-drop',
    'ALL',
    '--cap-add',
    'IPC_LOCK',
    '--security-opt',
    'no-new-privileges:true',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '--volume',
    `${path.join(directory, 'vault-server.hcl')}:/vault/config/server.hcl:ro`,
    '--volume',
    `${tls.tlsDirectory}:/vault/tls:ro`,
    '--volume',
    `${path.join(directory, 'vault-data')}:/vault/file:rw`,
    '--entrypoint',
    '/bin/vault',
    IMAGE,
    'server',
    '-config=/vault/config/server.hcl',
  ]);
  return docker(['inspect', container, '--format', '{{.Id}}']).stdout;
}

async function unsealVault(endpoint, ca, unsealKeys) {
  let result;
  for (const key of unsealKeys.slice(0, 2)) {
    result = await vaultJson(endpoint, ca, null, 'POST', '/v1/sys/unseal', {
      key: key.toString('base64'),
    });
    assert.equal(result.statusCode, 200);
  }
  assert.equal(result.value?.sealed, false);
  assert.equal(result.value?.t, 2);
  assert.equal(result.value?.n, 3);
}

function authority(secretRefs, environmentBundleRefs = []) {
  return {
    workerId: 'worker-vault-live',
    workerSessionId: '018f0000-0000-7000-8000-000000000001',
    workerGeneration: 1,
    runId: 'run-vault-live',
    attemptId: 'attempt-vault-live',
    projectId: 'project-vault-live',
    taskId: 'task-vault-live',
    taskRevision: 'revision-vault-live',
    executionDigest: 'a'.repeat(64),
    offerId: 'offer-vault-live',
    leaseGeneration: 1,
    leaseVersion: 1,
    secretRefs,
    environmentBundleRefs,
  };
}

function kvEnvelope(secretRef, value) {
  return {
    schemaVersion: 1,
    secretRefDigest: secretProjectionFileName(secretRef),
    encoding: 'base64',
    value: Buffer.from(value).toString('base64'),
  };
}

async function putSecret(endpoint, ca, rootToken, secretRef, value) {
  const digest = secretProjectionFileName(secretRef);
  const response = await vaultJson(
    endpoint,
    ca,
    rootToken,
    'POST',
    `/v1/${MOUNT}/data/${PREFIX}/${digest}`,
    { data: kvEnvelope(secretRef, value) },
  );
  assert.equal(response.statusCode, 200);
  assert.equal(Number.isSafeInteger(response.value?.data?.version), true);
  return response.value.data.version;
}

async function createLeastPrivilegeToken(endpoint, ca, rootToken) {
  const response = await vaultJson(
    endpoint,
    ca,
    rootToken,
    'POST',
    '/v1/auth/token/create-orphan',
    {
      policies: [POLICY],
      no_default_policy: true,
      renewable: false,
      ttl: '10m',
      display_name: 'ql3-worker-secret-live',
    },
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.value?.auth?.policies?.length, 1);
  assert.equal(response.value.auth.policies[0], POLICY);
  assert.equal(response.value.auth.orphan, true);
  assert.equal(response.value.auth.renewable, false);
  assert.equal(response.value.auth.lease_duration, 600);
  assert.equal(typeof response.value.auth.client_token, 'string');
  assert.equal(typeof response.value.auth.accessor, 'string');
  return {
    token: response.value.auth.client_token,
    accessor: response.value.auth.accessor,
  };
}

async function main() {
  if (process.env.QL3_RUN_VAULT_KV_WORKER_SECRET_LIVE !== 'true') {
    throw new Error('QL3_RUN_VAULT_KV_WORKER_SECRET_LIVE=true is required');
  }
  docker(['version', '--format', '{{.Server.Version}}']);
  docker(['image', 'inspect', IMAGE]);

  const suffix = `${process.pid}-${randomBytes(3).toString('hex')}`;
  const container = `ql3-vault-kv-worker-${suffix}`;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ql3-vault-kv-live-'));
  chmodSync(directory, 0o700);
  const unsealKeys = [];
  let ca;
  let rootToken;
  let firstToken;
  let secondToken;
  let started = false;
  try {
    const tls = generateTlsAuthority(directory);
    ca = readFileSync(tls.caFile);
    const untrustedCa = readFileSync(tls.untrustedCaFile);
    mkdirSync(path.join(directory, 'vault-data'), { mode: 0o700 });
    privateFile(
      directory,
      'vault-server.hcl',
      [
        'ui = false',
        'disable_mlock = false',
        'api_addr = "https://127.0.0.1:8200"',
        'cluster_addr = "https://127.0.0.1:8201"',
        'storage "file" {',
        '  path = "/vault/file"',
        '}',
        'listener "tcp" {',
        '  address = "0.0.0.0:8200"',
        '  cluster_address = "0.0.0.0:8201"',
        '  tls_cert_file = "/vault/tls/server.pem"',
        '  tls_key_file = "/vault/tls/server-key.pem"',
        '  tls_min_version = "tls13"',
        '  tls_max_version = "tls13"',
        '}',
        '',
      ].join('\n'),
    );
    const firstContainerId = startVaultContainer(
      container,
      '127.0.0.1::8200',
      directory,
      tls,
    );
    started = true;
    const portOutput = docker(['port', container, '8200/tcp']).stdout;
    const portMatch = /^127\.0\.0\.1:([1-9][0-9]*)$/.exec(portOutput);
    assert.ok(portMatch, 'Vault host port must be loopback-only');
    const hostPort = Number(portMatch[1]);
    const endpoint = `https://127.0.0.1:${hostPort}`;
    const uninitialized = await waitForVault(endpoint, ca, {
      statusCode: 501,
      initialized: false,
      sealed: true,
    });
    const initialization = await vaultJson(
      endpoint,
      ca,
      null,
      'POST',
      '/v1/sys/init',
      { secret_shares: 3, secret_threshold: 2 },
    );
    assert.equal(initialization.statusCode, 200);
    for (const encoded of initialization.value.keys_base64) {
      const key = Buffer.from(encoded, 'base64');
      assert.equal(key.toString('base64'), encoded);
      unsealKeys.push(key);
    }
    rootToken = initialization.value.root_token;
    initialization.value.keys = [];
    initialization.value.keys_base64 = [];
    initialization.value.root_token = '';
    await unsealVault(endpoint, ca, unsealKeys);
    const initialHealth = await waitForVault(endpoint, ca, {
      statusCode: 200,
      initialized: true,
      sealed: false,
    });

    const mount = await vaultJson(
      endpoint,
      ca,
      rootToken,
      'POST',
      `/v1/sys/mounts/${MOUNT}`,
      { type: 'kv', options: { version: '2' } },
    );
    assert.equal(mount.statusCode, 204);
    const policy = await vaultJson(
      endpoint,
      ca,
      rootToken,
      'PUT',
      `/v1/sys/policies/acl/${POLICY}`,
      {
        policy: [
          `path "${MOUNT}/data/${PREFIX}/*" { capabilities = ["read"] }`,
          'path "auth/token/lookup-self" { capabilities = ["read"] }',
        ].join('\n'),
      },
    );
    assert.equal(policy.statusCode, 204);

    const secretRef = createSecretRef({
      projectId: 'project-vault-live',
      name: 'legacy-token',
      version: 2,
    });
    const secondSecretRef = createSecretRef({
      projectId: 'project-vault-live',
      name: 'legacy-certificate',
      version: 1,
    });
    const bundleRef = createSecretRef({
      projectId: 'project-vault-live',
      name: 'legacy-environment-bundle',
      version: 3,
    });
    const missingRef = createSecretRef({
      projectId: 'project-vault-live',
      name: 'not-provisioned',
    });
    const firstValue = `vault-private-generation-one-${suffix}`;
    const secondValue = `vault-private-generation-two-${suffix}`;
    const certificateValue = `vault-private-certificate-${suffix}`;
    const bundleValue = JSON.stringify({
      schema: 'qinglong/environment-bundle@v1',
      entries: [{ name: 'LEGACY_ENV', value: `bundle-private-${suffix}` }],
    });
    const firstVersion = await putSecret(
      endpoint,
      ca,
      rootToken,
      secretRef,
      firstValue,
    );
    await putSecret(endpoint, ca, rootToken, secondSecretRef, certificateValue);
    await putSecret(endpoint, ca, rootToken, bundleRef, bundleValue);
    firstToken = await createLeastPrivilegeToken(endpoint, ca, rootToken);
    const tokenFile = privateFile(
      directory,
      'worker-token',
      `${firstToken.token}\n`,
      0o440,
    );
    const options = {
      endpoint,
      caFile: tls.caFile,
      tokenFile,
      kvMount: MOUNT,
      pathPrefix: PREFIX,
      expectedPolicy: POLICY,
      maximumTokenTtlSeconds: 900,
      requestTimeoutMs: 5000,
      maximumConcurrency: 2,
    };
    const initialLookup = await vaultJson(
      endpoint,
      ca,
      firstToken.token,
      'GET',
      '/v1/auth/token/lookup-self',
    );
    assert.equal(initialLookup.statusCode, 200);
    assert.deepEqual(initialLookup.value?.data?.policies, [POLICY]);
    assert.equal(initialLookup.value?.data?.orphan, true);
    assert.equal(initialLookup.value?.data?.renewable, false);
    assert.equal(initialLookup.value?.data?.type, 'service');
    assert.equal(
      Number.isSafeInteger(initialLookup.value?.data?.ttl) &&
        initialLookup.value.data.ttl > 0 &&
        initialLookup.value.data.ttl <= 900,
      true,
    );
    const provider = await createClusterVaultKvSecretProvider(options);
    const first = await provider.resolve(
      authority([secretRef, secondSecretRef], [bundleRef]),
    );
    assert.deepEqual(first.values, [
      { secretRef, value: firstValue },
      { secretRef: secondSecretRef, value: certificateValue },
    ]);
    assert.deepEqual(first.environmentBundles, [
      { secretRef: bundleRef, value: bundleValue },
    ]);
    await first.dispose();

    const rotatedVersion = await putSecret(
      endpoint,
      ca,
      rootToken,
      secretRef,
      secondValue,
    );
    assert.equal(rotatedVersion, firstVersion + 1);
    const rotated = await provider.resolve(authority([secretRef]));
    assert.deepEqual(rotated.values, [{ secretRef, value: secondValue }]);
    await rotated.dispose();

    await assert.rejects(
      provider.resolve(authority([missingRef])),
      (error) =>
        error instanceof ClusterVaultKvSecretProviderError &&
        error.reason === 'material_unavailable',
    );
    const untrustedProvider = createClusterVaultKvSecretProvider({
      ...options,
      caFile: tls.untrustedCaFile,
    });
    await assert.rejects(untrustedProvider, ClusterVaultKvSecretProviderError);

    secondToken = await createLeastPrivilegeToken(endpoint, ca, rootToken);
    const tokenReplacement = privateFile(
      directory,
      'worker-token.next',
      `${secondToken.token}\n`,
      0o440,
    );
    renameSync(tokenReplacement, tokenFile);
    const revoke = await vaultJson(
      endpoint,
      ca,
      rootToken,
      'POST',
      '/v1/auth/token/revoke-accessor',
      { accessor: firstToken.accessor },
    );
    assert.equal(revoke.statusCode, 204);
    const afterTokenRotation = await provider.resolve(authority([secretRef]));
    assert.equal(afterTokenRotation.values[0].value, secondValue);
    await afterTokenRotation.dispose();

    const seal = await vaultJson(
      endpoint,
      ca,
      rootToken,
      'PUT',
      '/v1/sys/seal',
    );
    assert.equal(seal.statusCode, 204);
    await waitForVault(endpoint, ca, {
      statusCode: 503,
      initialized: true,
      sealed: true,
    });
    await assert.rejects(
      provider.resolve(authority([secretRef])),
      ClusterVaultKvSecretProviderError,
    );
    await unsealVault(endpoint, ca, unsealKeys);
    const postUnseal = await provider.resolve(authority([secretRef]));
    assert.equal(postUnseal.values[0].value, secondValue);
    await postUnseal.dispose();

    docker(['rm', '--force', container]);
    started = false;
    const secondContainerId = startVaultContainer(
      container,
      `127.0.0.1:${hostPort}:8200`,
      directory,
      tls,
    );
    started = true;
    assert.notEqual(secondContainerId, firstContainerId);
    const sealedAfterReplacement = await waitForVault(endpoint, ca, {
      statusCode: 503,
      initialized: true,
      sealed: true,
    });
    await unsealVault(endpoint, ca, unsealKeys);
    const postReplacementHealth = await waitForVault(endpoint, ca, {
      statusCode: 200,
      initialized: true,
      sealed: false,
    });
    const postReplacement = await provider.resolve(authority([secretRef]));
    assert.equal(postReplacement.values[0].value, secondValue);
    await postReplacement.dispose();

    const imageId = docker([
      'image',
      'inspect',
      IMAGE,
      '--format',
      '{{.Id}}',
    ]).stdout;
    const architecture = docker([
      'image',
      'inspect',
      IMAGE,
      '--format',
      '{{.Architecture}}',
    ]).stdout;
    const report = {
      schemaVersion: 1,
      fixture: FIXTURE,
      platform: {
        architecture,
        vaultImage: IMAGE,
        vaultImageId: imageId,
        vaultVersion: postReplacementHealth.value.version,
        transport: 'TLSv1.3 with an explicit private CA',
        storage: 'persistent file barrier fixture',
      },
      custody: {
        provider: 'vault-kv-v2',
        kvVersion: 2,
        policyCount: 1,
        maximumTokenTtlSeconds: 900,
        tokenLeaseSeconds: 600,
        secretCount: 2,
        environmentBundleCount: 1,
        observedVersions: [firstVersion, rotatedVersion],
        containerReplacements: 1,
      },
      gates: {
        digestPinnedVaultImage: true,
        nativeVaultArchitecture: ['amd64', 'arm64'].includes(architecture),
        tls13WithExplicitPrivateCa:
          uninitialized.tlsProtocol === 'TLSv1.3' &&
          initialHealth.tlsProtocol === 'TLSv1.3' &&
          postReplacementHealth.tlsProtocol === 'TLSv1.3',
        untrustedCaRejected: true,
        initializedWithThreeOfTwoSealAuthority: true,
        kvV2ExternalCustody: true,
        oneExactReadOnlyPolicy: true,
        shortLivedOrphanNonRenewableToken: true,
        tokenRevalidatedPerResolution: true,
        digestDerivedPathsOnly: true,
        normalSecretBoundPreserved: true,
        opaqueEnvironmentBundleBoundPreserved: true,
        valueRotationObservedWithoutControlRestart: true,
        tokenRotationObservedWithoutControlRestart: true,
        revokedTokenRemoved: true,
        missingMaterialFailsClosed: true,
        sealedVaultFailsClosed: true,
        thresholdUnsealRestoresResolution: true,
        persistentValuesSurviveContainerReplacement:
          sealedAfterReplacement.value.sealed === true,
        reportIsContentFree: true,
        passed: true,
      },
      limitations: [
        'single-host file storage is not Vault integrated-storage HA or an HSM seal quorum',
        'the short-lived private CA and service tokens are live fixture authorities rather than enterprise PKI or workload identity',
        'the live gate proves direct external custody resolution and rotation, not fixed physical Edge storage behavior',
      ],
    };
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      rootToken,
      firstToken.token,
      secondToken.token,
      firstValue,
      secondValue,
      certificateValue,
      bundleValue,
      directory,
      endpoint,
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    const outputPath = process.env.QL3_VAULT_KV_WORKER_SECRET_REPORT;
    if (outputPath !== undefined) {
      if (!path.isAbsolute(outputPath))
        throw new Error('report path is invalid');
      writeFileSync(outputPath, `${serialized}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    untrustedCa.fill(0);
  } finally {
    ca?.fill(0);
    unsealKeys.forEach((key) => key.fill(0));
    rootToken = undefined;
    firstToken = undefined;
    secondToken = undefined;
    if (started) docker(['rm', '--force', container], { allowFailure: true });
    rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `ql3 Vault KV Worker Secret live contract failed: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = { FIXTURE, IMAGE };
