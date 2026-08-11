#!/usr/bin/env node

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} = require('node:crypto');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const https = require('node:https');
const { isIP } = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  createPluginPackagePromptOutputArtifact,
} = require('../packages/ql3-ai/dist/prompt-output/pluginPackagePromptOutputArtifact.js');
const {
  createPluginPackagePromptOutputExternalRecoveryAuthorization,
} = require('../packages/ql3-ai/dist/prompt-output/custody/pluginPackagePromptOutputExternalRecoveryAuthorization.js');
const {
  disposeClusterPromptOutputExternalRecoveryInput,
  readClusterPromptOutputExternalRecoveryCommand,
  readClusterPromptOutputExternalRecoveryInput,
} = require('../packages/ql3-cluster-admin/dist/prompt-output/external-recovery/promptOutputExternalRecoveryInput.js');
const {
  runClusterPromptOutputExternalRecoveryVerifier,
} = require('../packages/ql3-cluster-admin/dist/prompt-output/external-recovery/promptOutputExternalRecoveryVerifier.js');
const {
  readCommand,
  run,
} = require('./ql3-vault-transit-prompt-output-custody.cjs');

const IMAGE =
  'docker.io/hashicorp/vault@sha256:4e33b126a59c0c333b76fb4e894722462659a6bec7c48c9ee8cea56fccfd2569';
const VAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

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
  if (result.status !== 0) {
    throw new Error('OpenSSL command failed');
  }
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
    '/CN=QingLong 3 Vault Live Root',
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
    '/CN=QingLong 3 Untrusted Vault Root',
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
            const value = responseBytes.byteLength
              ? JSON.parse(responseBytes.toString('utf8'))
              : null;
            resolve({
              statusCode: response.statusCode,
              value,
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
  return result;
}

function approvalSigner(userId, authenticationId, keys, approvedAtMs) {
  return {
    userId,
    authenticationId,
    authenticatedAtMs: approvedAtMs - 1_000,
    approvedAtMs,
    publicKey: keys.publicKey,
    sign: (message) => sign(null, message, keys.privateKey),
  };
}

async function main() {
  if (process.env.QL3_RUN_VAULT_TRANSIT_LIVE !== 'true') {
    throw new Error('QL3_RUN_VAULT_TRANSIT_LIVE=true is required');
  }
  docker(['version', '--format', '{{.Server.Version}}']);
  docker(['image', 'inspect', IMAGE]);

  const suffix = `${process.pid}-${randomBytes(3).toString('hex')}`;
  const container = `ql3-vault-transit-${suffix}`;
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'ql3-vault-transit-live-'),
  );
  chmodSync(directory, 0o700);
  const material = randomBytes(32);
  const unsealKeys = [];
  let ca;
  let untrustedCa;
  let token;
  const custodyKeys = generateKeyPairSync('ed25519');
  const approverAKeys = generateKeyPairSync('ed25519');
  const approverBKeys = generateKeyPairSync('ed25519');
  const sourceCatalogDigest = createHash('sha256')
    .update('ql3-vault-transit-live-source-catalog')
    .digest('hex');
  let started = false;
  try {
    const tls = generateTlsAuthority(directory);
    ca = readFileSync(tls.caFile);
    untrustedCa = readFileSync(tls.untrustedCaFile);
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
    const uninitializedHealth = await waitForVault(endpoint, ca, {
      statusCode: 501,
      initialized: false,
      sealed: true,
    });
    await assert.rejects(
      () => vaultJson(endpoint, untrustedCa, null, 'GET', '/v1/sys/health'),
      (error) =>
        typeof error?.code === 'string' &&
        /CERT|SELF_SIGNED|VERIFY/.test(error.code),
    );
    const initialization = await vaultJson(
      endpoint,
      ca,
      null,
      'POST',
      '/v1/sys/init',
      { secret_shares: 3, secret_threshold: 2 },
    );
    assert.equal(initialization.statusCode, 200);
    assert.equal(initialization.value?.keys_base64?.length, 3);
    assert.equal(
      new Set(initialization.value.keys_base64).size,
      initialization.value.keys_base64.length,
    );
    for (const encoded of initialization.value.keys_base64) {
      const key = Buffer.from(encoded, 'base64');
      assert.equal(key.toString('base64'), encoded);
      assert.ok(key.byteLength >= 16 && key.byteLength <= 64);
      unsealKeys.push(key);
    }
    assert.equal(
      typeof initialization.value?.root_token === 'string' &&
        initialization.value.root_token.length >= 16,
      true,
    );
    token = initialization.value.root_token;
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
      token,
      'POST',
      '/v1/sys/mounts/prompt-output-transit',
      { type: 'transit' },
    );
    assert.equal(mount.statusCode, 204);
    const key = await vaultJson(
      endpoint,
      ca,
      token,
      'POST',
      '/v1/prompt-output-transit/keys/prompt-output-custody',
      {
        type: 'aes256-gcm96',
        derived: false,
        exportable: false,
        allow_plaintext_backup: false,
      },
    );
    assert.equal(key.statusCode, 200);
    assert.equal(key.value?.data?.name, 'prompt-output-custody');
    assert.equal(key.value?.data?.type, 'aes256-gcm96');
    assert.equal(key.value?.data?.derived, false);
    assert.equal(key.value?.data?.exportable, false);
    assert.equal(key.value?.data?.allow_plaintext_backup, false);
    assert.equal(key.value?.data?.latest_version, 1);

    const tokenFile = privateFile(directory, 'vault-token', `${token}\n`);
    const materialFile = privateFile(directory, 'material.bin', material);
    const custodyPrivateKeyFile = privateFile(
      directory,
      'custody-private.pem',
      custodyKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    );
    const custodyPublicKeyFile = privateFile(
      directory,
      'custody-public.pem',
      custodyKeys.publicKey.export({ format: 'pem', type: 'spki' }),
    );
    const bundleFile = path.join(directory, 'custody-bundle.json');
    const recoveredMaterialFile = path.join(
      directory,
      'recovered-material.bin',
    );
    const vault = {
      transport: 'https',
      endpoint,
      caFile: tls.caFile,
      tokenFile,
      transitMount: 'prompt-output-transit',
      keyName: 'prompt-output-custody',
    };
    const wrapCommandFile = privateFile(
      directory,
      'wrap-command.json',
      JSON.stringify({
        schemaVersion: 1,
        operation: 'external.prompt-output-key.vault-transit.wrap',
        vault,
        materialFile,
        bundleOutputFile: bundleFile,
        custody: {
          custodyId: `vault-live-custody-${suffix}`,
          keyId: `vault-live-key-${suffix}`,
          sourceGeneration: 1,
          sourceCatalogDigest,
          receiptSigningPrivateKeyFile: custodyPrivateKeyFile,
          receiptSigningPublicKeyFile: custodyPublicKeyFile,
        },
      }),
    );
    const unwrapCommandFile = privateFile(
      directory,
      'unwrap-command.json',
      JSON.stringify({
        schemaVersion: 1,
        operation: 'external.prompt-output-key.vault-transit.unwrap',
        vault,
        bundleFile,
        custodyPublicKeyFile,
        recoveredMaterialOutputFile: recoveredMaterialFile,
      }),
    );

    const wrapCommand = readCommand(wrapCommandFile);
    const firstWrap = await run(wrapCommand);
    assert.equal(firstWrap.status, 'completed');
    assert.equal(statSync(bundleFile).mode & 0o777, 0o400);
    const replayWrap = await run(wrapCommand, {
      request: () => {
        throw new Error('Vault must not be called for exact wrap replay');
      },
    });
    assert.equal(replayWrap.status, 'existing');
    assert.equal(replayWrap.bundleDigest, firstWrap.bundleDigest);

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
    const persistedKey = await vaultJson(
      endpoint,
      ca,
      token,
      'GET',
      '/v1/prompt-output-transit/keys/prompt-output-custody',
    );
    assert.equal(persistedKey.statusCode, 200);
    assert.equal(persistedKey.value?.data?.name, 'prompt-output-custody');
    assert.equal(persistedKey.value?.data?.latest_version, 1);
    assert.equal(persistedKey.value?.data?.exportable, false);
    assert.equal(persistedKey.value?.data?.allow_plaintext_backup, false);

    const unwrapCommand = readCommand(unwrapCommandFile);
    const firstUnwrap = await run(unwrapCommand);
    assert.equal(firstUnwrap.status, 'completed');
    assert.equal(statSync(recoveredMaterialFile).mode & 0o777, 0o400);
    assert.deepEqual(readFileSync(recoveredMaterialFile), material);
    const replayUnwrap = await run(unwrapCommand, {
      request: () => {
        throw new Error('Vault must not be called for exact unwrap replay');
      },
    });
    assert.equal(replayUnwrap.status, 'existing');

    const now = Date.now();
    const artifactKey = Buffer.from(material);
    let artifact;
    try {
      artifact = createPluginPackagePromptOutputArtifact(
        {
          projectId: 'project-vault-live-recovery',
          runId: 'run-vault-live-recovery',
          stepRunId: 'step-vault-live-recovery',
          invocationId: 'invocation-vault-live-recovery',
          requestedBy: { type: 'user', id: 'vault-live-requester' },
          result: {
            provider: 'openai-compatible',
            model: 'vault-live-model',
            text: 'private Vault live recovery output',
            finishReason: 'stop',
            usage: {
              inputTokens: 3,
              outputTokens: 4,
              totalTokens: 7,
              costMicros: 8,
            },
          },
          retentionPolicy: {
            revision: 'vault-live-v1',
            retentionMs: 86_400_000,
          },
          keyId: firstWrap.receipt.keyId,
          key: artifactKey,
          sealedAtMs: now - 60_000,
        },
        () => Buffer.alloc(12, 0x27),
      );
    } finally {
      artifactKey.fill(0);
    }
    const authorization =
      createPluginPackagePromptOutputExternalRecoveryAuthorization(
        {
          recoveryId: `vault-live-recovery-${suffix}`,
          requestId: `vault-live-request-${suffix}`,
          custodyId: firstWrap.receipt.custodyId,
          custodyReceiptDigest: firstWrap.receipt.receiptDigest,
          keyId: firstWrap.receipt.keyId,
          artifactId: artifact.artifactId,
          artifactDigest: artifact.artifactDigest,
          policyDigest: createHash('sha256')
            .update('ql3-vault-live-recovery-policy')
            .digest('hex'),
          requestedBy: {
            userId: 'vault-live-requester',
            authenticationId: `vault-live-requester-auth-${suffix}`,
            authenticatedAtMs: now - 4_000,
          },
          requestedAtMs: now - 3_000,
          expiresAtMs: now + 10 * 60_000,
        },
        [
          approvalSigner(
            'vault-live-reviewer-a',
            `vault-live-reviewer-a-auth-${suffix}`,
            approverAKeys,
            now - 2_000,
          ),
          approvalSigner(
            'vault-live-reviewer-b',
            `vault-live-reviewer-b-auth-${suffix}`,
            approverBKeys,
            now - 1_000,
          ),
        ],
      );
    const authorizationFile = privateFile(
      directory,
      'authorization.json',
      JSON.stringify(authorization),
    );
    const durableKeyFactFile = privateFile(
      directory,
      'durable-key-fact.json',
      JSON.stringify({
        keyId: firstWrap.receipt.keyId,
        materialProof: firstWrap.receipt.materialProof,
        catalogDigest: sourceCatalogDigest,
      }),
    );
    const artifactFile = privateFile(
      directory,
      'artifact.json',
      JSON.stringify(artifact),
    );
    const approverAFile = privateFile(
      directory,
      'approver-a-public.pem',
      approverAKeys.publicKey.export({ format: 'pem', type: 'spki' }),
    );
    const approverBFile = privateFile(
      directory,
      'approver-b-public.pem',
      approverBKeys.publicKey.export({ format: 'pem', type: 'spki' }),
    );
    const recoveryCommandFile = privateFile(
      directory,
      'recovery-command.json',
      JSON.stringify({
        schemaVersion: 1,
        operation: 'cluster.prompt-output-key.verify-recovery',
        authorizationFile,
        custodyBundleFile: bundleFile,
        recoveredMaterialFile,
        durableKeyFactFile,
        artifactFile,
        custodyPublicKeyFile,
        approverPublicKeyFiles: [
          { userId: 'vault-live-reviewer-a', filePath: approverAFile },
          { userId: 'vault-live-reviewer-b', filePath: approverBFile },
        ],
      }),
      0o444,
    );
    const recoveryCommand =
      readClusterPromptOutputExternalRecoveryCommand(recoveryCommandFile);
    const recoveryInput =
      readClusterPromptOutputExternalRecoveryInput(recoveryCommand);
    let proof;
    try {
      proof = runClusterPromptOutputExternalRecoveryVerifier(
        recoveryInput,
        now + 3_000,
      );
    } finally {
      disposeClusterPromptOutputExternalRecoveryInput(recoveryInput);
    }

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
      fixture: 'qinglong/vault-transit-prompt-output-custody-live@v1',
      vault: {
        image: IMAGE,
        imageId,
        architecture,
        version: postReplacementHealth.value.version,
        initialized: postReplacementHealth.value.initialized,
        sealed: postReplacementHealth.value.sealed,
        transport: 'TLSv1.3 with an explicit private CA',
        storage: 'persistent file barrier fixture',
        secretShares: 3,
        secretThreshold: 2,
        containerReplacements: 1,
      },
      custody: {
        wrappingProvider: firstWrap.receipt.wrappingProvider,
        custodyId: firstWrap.receipt.custodyId,
        keyId: firstWrap.receipt.keyId,
        receiptDigest: firstWrap.receipt.receiptDigest,
        bundleDigest: firstWrap.bundleDigest,
        wrappedMaterialDigest: firstWrap.receipt.wrappedMaterialDigest,
        wrapStatus: firstWrap.status,
        wrapReplayStatus: replayWrap.status,
        unwrapStatus: firstUnwrap.status,
        unwrapReplayStatus: replayUnwrap.status,
      },
      recovery: {
        authorizationDigest: proof.authorizationDigest,
        proofDigest: proof.proofDigest,
        artifactDigest: proof.artifactDigest,
        contentDigest: proof.contentDigest,
        outputBytes: proof.outputBytes,
      },
      gates: {
        digestPinnedVaultImage: true,
        tls13WithExplicitPrivateCa:
          uninitializedHealth.tlsProtocol === 'TLSv1.3' &&
          initialHealth.tlsProtocol === 'TLSv1.3' &&
          postReplacementHealth.tlsProtocol === 'TLSv1.3',
        untrustedCaRejectedBeforeVaultApi: true,
        initializedWithThreeOfTwoSealAuthority: true,
        sealedAfterContainerReplacement:
          sealedAfterReplacement.value.sealed === true,
        thresholdUnsealAfterReplacement: true,
        persistentBarrierSurvivesContainerReplacement: true,
        transitKeySurvivesContainerReplacement:
          persistedKey.value.data.latest_version === 1,
        realVaultTransitEncryptDecrypt: true,
        immutableAtomicBundle: true,
        exactWrapReplayAvoidsVault: true,
        exactUnwrapReplayAvoidsVault: true,
        recoveredMaterialMatchesOriginal: true,
        twoUserAuthorizationVerified: true,
        officialArtifactOpenVerified: true,
        reportIsContentFree: true,
        passed: true,
      },
      limitations: [
        'single-host file storage is not an HA integrated-storage or HSM seal quorum',
        'the short-lived private CA and root token are local fixture authorities rather than enterprise PKI/identity',
        'durable key fact and Artifact are fixture-generated rather than restored from CNPG backup',
        'dual User identities are local Ed25519 fixtures rather than an external IdP ceremony',
      ],
    };
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      token,
      material.toString('base64'),
      firstWrap.receipt.signature,
      'private Vault live recovery output',
      directory,
      endpoint,
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    ca?.fill(0);
    untrustedCa?.fill(0);
    unsealKeys.forEach((key) => key.fill(0));
    token = undefined;
    material.fill(0);
    if (started) docker(['rm', '--force', container], { allowFailure: true });
    rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `ql3 Vault Transit live contract failed: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = { IMAGE };
