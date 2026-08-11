#!/usr/bin/env node

'use strict';

const {
  createHash,
  createPrivateKey,
  X509Certificate,
} = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const {
  assertionIdentity,
  validateWorkerCredentialManagementLiveCeremony,
} = require('./ql3-worker-credential-management-live-ceremony.cjs');
const {
  validateWorkerCredentialManagementDurableAuditEvidence,
} = require('./ql3-worker-credential-management-durable-audit-evidence.cjs');
const {
  collectKubernetesSnapshot,
  REVIEWED_AUTHORITY,
} = require('./ql3-worker-credential-management-pki-rotation-evidence.cjs');

const FIXTURE =
  'qinglong/worker-credential-management-ca-rollover-evidence@v1';
const STATE_FIXTURE =
  'qinglong/worker-credential-management-ca-rollover-state@v1';
const CEREMONY_FIXTURE =
  'qinglong/worker-credential-management-live-ceremony@v1';
const DURABLE_FIXTURE =
  'qinglong/worker-credential-management-durable-audit-evidence@v1';
const CA_ANNOTATION =
  'qinglong.io/worker-credential-management-client-ca-sha256';
const CRL_ANNOTATION =
  'qinglong.io/worker-credential-management-client-crl-sha256';
const TYPE = 'ql3-worker-credential-management+jwt';
const PURPOSE = 'worker-credential-management';
const AUDIENCE = 'qinglong3-worker-credential-management';
const NAMESPACE = 'qinglong3-system';
const DEPLOYMENT = 'ql3-worker-credential-management';
const MAX_FILE_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const BANNED_KEYS = new Set([
  'assertion',
  'authorization',
  'bearer',
  'connectionstring',
  'dsn',
  'kubeconfig',
  'password',
  'privatekey',
  'secret',
  'tlskey',
  'token',
]);
const ROOT = path.resolve(__dirname, '..');
const clusterRequire = createRequire(
  path.join(ROOT, 'packages/ql3-cluster-admin/package.json'),
);

class WorkerCredentialManagementCaRolloverEvidenceError extends Error {
  constructor(message) {
    super(`Worker management CA rollover evidence failed: ${message}`);
    this.name = 'WorkerCredentialManagementCaRolloverEvidenceError';
  }
}

function fail(message) {
  throw new WorkerCredentialManagementCaRolloverEvidenceError(message);
}

function exactObject(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    fail(`${label} shape is invalid`);
  }
  return value;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function digest(domain, value) {
  return `sha256:${createHash('sha256')
    .update(domain)
    .update('\0')
    .update(String(value))
    .digest('hex')}`;
}

function rawDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalFile(filePath, label, options = {}) {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    filePath.length > 4096 ||
    CONTROL_PATTERN.test(filePath)
  ) {
    fail(`${label} path is invalid`);
  }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail(`${label} is unavailable`);
  }
  const privateFile = options.private !== false;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > (options.maximum ?? MAX_FILE_BYTES) ||
    fs.realpathSync(filePath) !== filePath ||
    (privateFile && (uid === null || stat.uid !== uid)) ||
    (stat.mode & (privateFile ? 0o077 : 0o022)) !== 0
  ) {
    fail(`${label} must be one canonical bounded file`);
  }
  return filePath;
}

function readBuffer(filePath, label, options = {}) {
  canonicalFile(filePath, label, options);
  const before = fs.lstatSync(filePath);
  let descriptor = -1;
  let bytes;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY |
        (fs.constants.O_CLOEXEC ?? 0) |
        (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== before.uid ||
      opened.mode !== before.mode ||
      opened.size !== before.size
    ) {
      fail(`${label} changed before it was opened`);
    }
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) fail(`${label} could not be read completely`);
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.uid !== opened.uid ||
      after.mode !== opened.mode ||
      after.size !== opened.size
    ) {
      fail(`${label} changed while it was read`);
    }
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof WorkerCredentialManagementCaRolloverEvidenceError) {
      throw error;
    }
    fail(`${label} could not be read safely`);
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function jsonFromBytes(bytes, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(`${label} must contain UTF-8 JSON`);
  }
}

function readJson(filePath, label) {
  const bytes = readBuffer(filePath, label);
  try {
    return Object.freeze({ bytes, value: jsonFromBytes(bytes, label) });
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

function unusedOutput(filePath) {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    fs.existsSync(filePath) ||
    fs.realpathSync(path.dirname(filePath)) !== path.dirname(filePath)
  ) {
    fail('output path must be unused in one canonical directory');
  }
}

function writeNoReplace(filePath, value) {
  unusedOutput(filePath);
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_CLOEXEC ?? 0) |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function externalIssuer(value) {
  if (typeof value !== 'string' || value.length > 512) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.toString() === value &&
    net.isIP(hostname) === 0 &&
    hostname !== 'localhost' &&
    !hostname.endsWith('.localhost') &&
    !hostname.endsWith('.local') &&
    !hostname.endsWith('.test') &&
    !hostname.endsWith('.invalid') &&
    !hostname.endsWith('.example')
  );
}

function isIsoTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function containsSensitiveMaterial(value, key = '') {
  if (BANNED_KEYS.has(key.toLowerCase())) return true;
  if (typeof value === 'string') {
    return (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value) ||
      /postgres(?:ql)?:\/\/[^/\s]+:[^@\s]+@/i.test(value) ||
      /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/.test(
        value,
      )
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveMaterial(entry));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([childKey, child]) =>
      containsSensitiveMaterial(child, childKey),
    );
  }
  return false;
}

function exactPemBlocks(bytes, label, description) {
  let value;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${description} must be strict UTF-8`);
  }
  const pattern = new RegExp(
    `-----BEGIN ${label}-----[\\s\\S]*?-----END ${label}-----`,
    'g',
  );
  const matches = value.match(pattern);
  if (!matches || matches.length < 1 || matches.length > 16) {
    fail(`${description} must contain 1 to 16 PEM blocks`);
  }
  if (value.replace(pattern, '').trim() !== '') {
    fail(`${description} contains unsupported data`);
  }
  return matches.map((match) => Buffer.from(`${match}\n`, 'utf8'));
}

function openssl(args, input, label) {
  const result = spawnSync('openssl', args, {
    input,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' },
  });
  if (result.status !== 0 || result.signal !== null) {
    fail(`${label} is not accepted by OpenSSL`);
  }
  return result.stdout.trim();
}

function defaultInspectAuthoritySubject(bytes) {
  const output = openssl(
    ['x509', '-noout', '-subject', '-nameopt', 'RFC2253'],
    bytes,
    'client certificate authority',
  );
  const subject = /^subject=(.+)$/.exec(output)?.[1];
  if (!subject) fail('client certificate authority subject is invalid');
  return subject;
}

function defaultInspectCrl(bytes) {
  const output = openssl(
    [
      'crl',
      '-noout',
      '-issuer',
      '-nameopt',
      'RFC2253',
      '-fingerprint',
      '-sha256',
      '-lastupdate',
      '-nextupdate',
      '-crlnumber',
    ],
    bytes,
    'client certificate revocation list',
  );
  const lines = output.split('\n');
  const issuer = lines.find((line) => line.startsWith('issuer='))?.slice(7);
  const fingerprint = /^SHA256 Fingerprint=([A-F0-9:]{95})$/i.exec(
    lines.find((line) => line.startsWith('SHA256 Fingerprint=')) ?? '',
  )?.[1];
  const lastUpdate = lines
    .find((line) => line.startsWith('lastUpdate='))
    ?.slice(11);
  const nextUpdate = lines
    .find((line) => line.startsWith('nextUpdate='))
    ?.slice(11);
  const number = /^crlNumber=(?:0x)?([A-F0-9]+)$/i.exec(
    lines.find((line) => line.startsWith('crlNumber=')) ?? '',
  )?.[1];
  const lastUpdateMs = Date.parse(lastUpdate ?? '');
  const nextUpdateMs = Date.parse(nextUpdate ?? '');
  if (
    !issuer ||
    !fingerprint ||
    !number ||
    !Number.isFinite(lastUpdateMs) ||
    !Number.isFinite(nextUpdateMs) ||
    nextUpdateMs <= lastUpdateMs
  ) {
    fail('client certificate revocation list metadata is invalid');
  }
  return Object.freeze({
    issuer,
    sha256: `sha256:${fingerprint.replaceAll(':', '').toLowerCase()}`,
    number: number.toLowerCase().replace(/^0+/, '') || '0',
    lastUpdateMs,
    nextUpdateMs,
  });
}

function inspectAuthorities(bytes, nowMs, inspectAuthoritySubject) {
  const blocks = exactPemBlocks(
    bytes,
    'CERTIFICATE',
    'client certificate authority bundle',
  );
  const fingerprints = new Set();
  const subjects = new Set();
  const authorities = [];
  try {
    for (const block of blocks) {
      let certificate;
      try {
        certificate = new X509Certificate(block);
      } catch {
        fail('client certificate authority is invalid');
      }
      if (
        !certificate.ca ||
        Date.parse(certificate.validFrom) > nowMs ||
        Date.parse(certificate.validTo) <= nowMs
      ) {
        fail('client certificate authority is not active CA material');
      }
      const fingerprintSha256 = `sha256:${certificate.fingerprint256
        .replaceAll(':', '')
        .toLowerCase()}`;
      const subject = inspectAuthoritySubject(block);
      if (
        fingerprints.has(fingerprintSha256) ||
        subjects.has(subject)
      ) {
        fail('client certificate authority bundle contains a duplicate');
      }
      fingerprints.add(fingerprintSha256);
      subjects.add(subject);
      authorities.push(
        Object.freeze({ certificate, fingerprintSha256, subject }),
      );
    }
    return Object.freeze(authorities);
  } finally {
    for (const block of blocks) block.fill(0);
  }
}

function inspectClientConfiguration(
  configFile,
  nowMs,
  inspectAuthoritySubject = defaultInspectAuthoritySubject,
) {
  const document = readJson(configFile, 'management client config');
  try {
    const config = exactObject(
      document.value,
      [
        'schemaVersion',
        'endpoint',
        'servername',
        'caFile',
        'clientCertificateFile',
        'clientPrivateKeyFile',
        'requestTimeoutMs',
      ],
      'management client config',
    );
    if (
      config.schemaVersion !== 1 ||
      typeof config.endpoint !== 'string' ||
      typeof config.servername !== 'string' ||
      typeof config.caFile !== 'string' ||
      typeof config.clientCertificateFile !== 'string' ||
      typeof config.clientPrivateKeyFile !== 'string' ||
      !Number.isSafeInteger(config.requestTimeoutMs)
    ) {
      fail('management client config is invalid');
    }
    let endpoint;
    try {
      endpoint = new URL(config.endpoint);
    } catch {
      fail('management client endpoint is invalid');
    }
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.hostname !== config.servername ||
      endpoint.pathname !== '/api/v3/worker-credentials/management' ||
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      endpoint.search !== '' ||
      endpoint.hash !== '' ||
      net.isIP(endpoint.hostname) !== 0
    ) {
      fail('management client endpoint authority is invalid');
    }
    const serverCa = readBuffer(config.caFile, 'management server CA', {
      private: false,
      maximum: 256 * 1024,
    });
    const certificateBytes = readBuffer(
      config.clientCertificateFile,
      'management client certificate',
      { private: false, maximum: 256 * 1024 },
    );
    const privateKeyBytes = readBuffer(
      config.clientPrivateKeyFile,
      'management client private key',
      { maximum: 256 * 1024 },
    );
    try {
      const serverAuthorities = inspectAuthorities(
        serverCa,
        nowMs,
        inspectAuthoritySubject,
      );
      const certificate = new X509Certificate(certificateBytes);
      const privateKey = createPrivateKey(privateKeyBytes);
      if (
        certificate.ca ||
        !certificate.checkPrivateKey(privateKey) ||
        !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.2') ||
        Date.parse(certificate.validFrom) > nowMs ||
        Date.parse(certificate.validTo) <= nowMs
      ) {
        fail('management client identity is invalid');
      }
      return Object.freeze({
        endpointSha256: digest(
          'qinglong3.worker-management.endpoint.v1',
          endpoint.toString(),
        ),
        servernameSha256: digest(
          'qinglong3.worker-management.servername.v1',
          config.servername,
        ),
        serverTrustBundleSha256: rawDigest(serverCa),
        serverAuthoritySha256: Object.freeze(
          serverAuthorities.map(({ fingerprintSha256 }) => fingerprintSha256),
        ),
        clientCertificateSha256: `sha256:${certificate.fingerprint256
          .replaceAll(':', '')
          .toLowerCase()}`,
        certificate,
      });
    } catch (error) {
      if (error instanceof WorkerCredentialManagementCaRolloverEvidenceError) {
        throw error;
      }
      fail('management client certificate material is invalid');
    } finally {
      serverCa.fill(0);
      certificateBytes.fill(0);
      privateKeyBytes.fill(0);
    }
  } finally {
    document.bytes.fill(0);
  }
}

function inspectTrustBundles(
  caFile,
  crlFile,
  nowMs,
  inspectAuthoritySubject,
  inspectCrl,
) {
  const caBytes = readBuffer(caFile, 'client CA bundle', {
    private: false,
    maximum: 256 * 1024,
  });
  const crlBytes = readBuffer(crlFile, 'client CRL bundle', {
    private: false,
    maximum: 256 * 1024,
  });
  let crlBlocks = [];
  try {
    const authorities = inspectAuthorities(
      caBytes,
      nowMs,
      inspectAuthoritySubject,
    );
    crlBlocks = exactPemBlocks(
      crlBytes,
      'X509 CRL',
      'client certificate revocation list bundle',
    );
    const crls = crlBlocks.map((block) => inspectCrl(block));
    const authoritySubjects = authorities.map(({ subject }) => subject).sort();
    const crlIssuers = crls.map(({ issuer }) => issuer).sort();
    if (
      crls.length !== authorities.length ||
      JSON.stringify(crlIssuers) !== JSON.stringify(authoritySubjects) ||
      new Set(crls.map(({ sha256 }) => sha256)).size !== crls.length ||
      crls.some(
        ({ sha256, number, lastUpdateMs, nextUpdateMs }) =>
          !SHA256_PATTERN.test(sha256) ||
          !/^[a-f0-9]{1,64}$/.test(number) ||
          !Number.isSafeInteger(lastUpdateMs) ||
          !Number.isSafeInteger(nextUpdateMs) ||
          lastUpdateMs > nowMs + 5 * 60_000 ||
          nextUpdateMs <= nowMs ||
          nextUpdateMs <= lastUpdateMs,
      )
    ) {
      fail('CRL issuer coverage is not exact and current');
    }
    return Object.freeze({
      caBundleSha256: rawDigest(caBytes),
      crlBundleSha256: rawDigest(crlBytes),
      authorities,
      caFingerprintSha256: Object.freeze(
        authorities.map(({ fingerprintSha256 }) => fingerprintSha256).sort(),
      ),
      crlIssuerSha256: Object.freeze(
        crls
          .map(({ issuer }) =>
            digest('qinglong3.worker-management.client-ca-subject.v1', issuer),
          )
          .sort(),
      ),
    });
  } finally {
    caBytes.fill(0);
    crlBytes.fill(0);
    for (const block of crlBlocks) block.fill(0);
  }
}

function issuerAuthority(profile, trust) {
  const matches = trust.authorities.filter(
    ({ certificate }) =>
      profile.certificate.checkIssued(certificate) &&
      profile.certificate.verify(certificate.publicKey),
  );
  if (matches.length > 1) fail('client certificate issuer is ambiguous');
  return matches[0]?.fingerprintSha256 ?? null;
}

function sameClientTransport(oldProfile, newProfile) {
  if (
    oldProfile.endpointSha256 !== newProfile.endpointSha256 ||
    oldProfile.servernameSha256 !== newProfile.servernameSha256 ||
    oldProfile.serverTrustBundleSha256 !==
      newProfile.serverTrustBundleSha256 ||
    JSON.stringify(oldProfile.serverAuthoritySha256) !==
      JSON.stringify(newProfile.serverAuthoritySha256) ||
    oldProfile.clientCertificateSha256 ===
      newProfile.clientCertificateSha256
  ) {
    fail('old and new clients must use one server trust and distinct identities');
  }
}

function identityFromFile(filePath, nowMs) {
  const bytes = readBuffer(filePath, 'identity assertion');
  try {
    if (bytes.some((byte) => byte > 0x7f)) {
      fail('identity assertion encoding is invalid');
    }
    return assertionIdentity(bytes.toString('ascii'), nowMs);
  } finally {
    bytes.fill(0);
  }
}

function commandFromFile(filePath, normalize) {
  const document = readJson(filePath, 'management inspect command');
  try {
    const command = normalize(document.value);
    if (command?.operation !== 'worker-credential.inspect') {
      fail('evidence command must be worker-credential.inspect');
    }
    return Object.freeze({
      sha256: digest(
        'qinglong3.worker-management.ca-rollover-command.v1',
        JSON.stringify(command),
      ),
    });
  } finally {
    document.bytes.fill(0);
  }
}

function normalizeKubernetesSnapshot(value, caSha256, crlSha256) {
  if (
    !value ||
    typeof value !== 'object' ||
    !SHA256_PATTERN.test(value.clusterServerSha256) ||
    !SHA256_PATTERN.test(value.collectorSubjectSha256) ||
    !Array.isArray(value.authorization) ||
    value.authorization.length !== REVIEWED_AUTHORITY.length ||
    value.authorization.some(
      (entry, index) =>
        entry?.verb !== REVIEWED_AUTHORITY[index].verb ||
        entry?.resource !== REVIEWED_AUTHORITY[index].resource ||
        entry?.allowed !== REVIEWED_AUTHORITY[index].allowed ||
        entry?.observed !== REVIEWED_AUTHORITY[index].allowed,
    )
  ) {
    fail('Kubernetes evidence collector authority is not exact read-only');
  }
  const deployment = value.deployment;
  const metadata = deployment?.metadata;
  const spec = deployment?.spec;
  const status = deployment?.status;
  if (
    deployment?.apiVersion !== 'apps/v1' ||
    deployment?.kind !== 'Deployment' ||
    metadata?.name !== DEPLOYMENT ||
    metadata?.namespace !== NAMESPACE ||
    typeof metadata.uid !== 'string' ||
    typeof metadata.resourceVersion !== 'string' ||
    !Number.isSafeInteger(metadata.generation) ||
    metadata.generation < 1 ||
    spec?.replicas !== 2 ||
    spec?.strategy?.type !== 'RollingUpdate' ||
    spec?.strategy?.rollingUpdate?.maxUnavailable !== 0 ||
    spec?.template?.metadata?.annotations?.[CA_ANNOTATION] !== caSha256 ||
    spec?.template?.metadata?.annotations?.[CRL_ANNOTATION] !== crlSha256 ||
    status?.observedGeneration !== metadata.generation ||
    status?.replicas !== 2 ||
    status?.updatedReplicas !== 2 ||
    status?.readyReplicas !== 2 ||
    status?.availableReplicas !== 2 ||
    (status?.unavailableReplicas ?? 0) !== 0
  ) {
    fail('Kubernetes Deployment is not one converged CA/CRL-bound rollout');
  }
  if (
    value.pods?.apiVersion !== 'v1' ||
    value.pods?.kind !== 'List' ||
    !Array.isArray(value.pods.items) ||
    value.pods.items.length < 2 ||
    value.pods.items.length > 4
  ) {
    fail('Kubernetes Pod snapshot is invalid');
  }
  const current = value.pods.items.filter(
    (pod) => pod?.metadata?.deletionTimestamp === undefined,
  );
  const ready = (conditions) =>
    Array.isArray(conditions) &&
    conditions.some(
      (condition) =>
        condition?.type === 'Ready' && condition?.status === 'True',
    );
  if (
    current.length !== 2 ||
    current.some(
      (pod) =>
        pod.metadata?.namespace !== NAMESPACE ||
        typeof pod.metadata?.uid !== 'string' ||
        pod.metadata?.labels?.['app.kubernetes.io/name'] !== DEPLOYMENT ||
        pod.metadata?.labels?.['app.kubernetes.io/component'] !==
          'worker-credential-management' ||
        typeof pod.metadata?.labels?.['pod-template-hash'] !== 'string' ||
        pod.spec?.serviceAccountName !== DEPLOYMENT ||
        pod.spec?.automountServiceAccountToken !== false ||
        typeof pod.spec?.nodeName !== 'string' ||
        pod.status?.phase !== 'Running' ||
        !ready(pod.status?.conditions) ||
        !pod.status?.containerStatuses?.some(
          (container) =>
            container.name === 'management' && container.ready === true,
        ),
    ) ||
    new Set(current.map((pod) => pod.spec.nodeName)).size !== 2 ||
    new Set(current.map((pod) => pod.metadata.labels['pod-template-hash']))
      .size !== 1
  ) {
    fail('Kubernetes manager Pods are not two Ready tokenless replicas');
  }
  return Object.freeze({
    clusterServerSha256: value.clusterServerSha256,
    collectorSubjectSha256: value.collectorSubjectSha256,
    deploymentUidSha256: digest(
      'qinglong3.worker-management.deployment-uid.v1',
      metadata.uid,
    ),
    deploymentResourceVersionSha256: digest(
      'qinglong3.worker-management.deployment-resource-version.v1',
      metadata.resourceVersion,
    ),
    deploymentGeneration: metadata.generation,
    caAnnotationSha256: caSha256,
    crlAnnotationSha256: crlSha256,
    podUidSha256: Object.freeze(
      current
        .map((pod) =>
          digest('qinglong3.worker-management.pod-uid.v1', pod.metadata.uid),
        )
        .sort(),
    ),
    podNodeSha256: Object.freeze(
      current
        .map((pod) =>
          digest('qinglong3.worker-management.node.v1', pod.spec.nodeName),
        )
        .sort(),
    ),
    exactReadOnlyCollectorAuthority: true,
  });
}

function expectedAccess(phase) {
  return Object.freeze(
    phase === 'old'
      ? { old: 200, next: 401 }
      : phase === 'overlap'
        ? { old: 200, next: 200 }
        : { old: 401, next: 200 },
  );
}

async function invokeClient(execute, options, configFile, expected) {
  try {
    await execute({
      configFile,
      commandFile: options.commandFile,
      assertionFile: options.assertionFile,
    });
    if (expected !== 200) fail('retired client certificate was accepted');
    return Object.freeze({ statusCode: 200, responseCode: null });
  } catch (error) {
    if (
      expected === 401 &&
      error?.statusCode === 401 &&
      error?.responseCode === 'client_certificate_required'
    ) {
      return Object.freeze({
        statusCode: 401,
        responseCode: 'client_certificate_required',
      });
    }
    if (error instanceof WorkerCredentialManagementCaRolloverEvidenceError) {
      throw error;
    }
    fail('management client observation did not match the required status');
  }
}

function defaultDependencies() {
  const { executeClusterWorkerCredentialManagementClient } = clusterRequire(
    '@qinglong/cluster-admin/worker-credential-management-client',
  );
  const { normalizeClusterWorkerCredentialManagementCommand } = clusterRequire(
    '@qinglong/cluster-admin/worker-credential-management-transport',
  );
  return Object.freeze({
    now: Date.now,
    execute: executeClusterWorkerCredentialManagementClient,
    normalize: normalizeClusterWorkerCredentialManagementCommand,
    inspectClient: inspectClientConfiguration,
    inspectTrust: inspectTrustBundles,
    inspectAuthoritySubject: defaultInspectAuthoritySubject,
    inspectCrl: defaultInspectCrl,
    collectKubernetes: collectKubernetesSnapshot,
  });
}

function reviewedDependencies(overrides = {}) {
  const defaults = overrides.useDefaults === false ? {} : defaultDependencies();
  const dependencies = { ...defaults, ...overrides };
  delete dependencies.useDefaults;
  exactObject(
    dependencies,
    [
      'now',
      'execute',
      'normalize',
      'inspectClient',
      'inspectTrust',
      'inspectAuthoritySubject',
      'inspectCrl',
      'collectKubernetes',
    ],
    'evidence dependencies',
  );
  if (Object.values(dependencies).some((entry) => typeof entry !== 'function')) {
    fail('evidence dependencies are invalid');
  }
  return Object.freeze(dependencies);
}

function validDigestArray(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => SHA256_PATTERN.test(entry)) &&
    new Set(value).size === value.length &&
    JSON.stringify(value) === JSON.stringify([...value].sort())
  );
}

function validDigestSequence(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => SHA256_PATTERN.test(entry)) &&
    new Set(value).size === value.length
  );
}

function validKubernetes(value) {
  return (
    exactKeys(value, [
      'clusterServerSha256',
      'collectorSubjectSha256',
      'deploymentUidSha256',
      'deploymentResourceVersionSha256',
      'deploymentGeneration',
      'caAnnotationSha256',
      'crlAnnotationSha256',
      'podUidSha256',
      'podNodeSha256',
      'exactReadOnlyCollectorAuthority',
    ]) &&
    [
      value.clusterServerSha256,
      value.collectorSubjectSha256,
      value.deploymentUidSha256,
      value.deploymentResourceVersionSha256,
      value.caAnnotationSha256,
      value.crlAnnotationSha256,
    ].every((entry) => SHA256_PATTERN.test(entry)) &&
    Number.isSafeInteger(value.deploymentGeneration) &&
    value.deploymentGeneration >= 1 &&
    validDigestArray(value.podUidSha256, 2) &&
    validDigestArray(value.podNodeSha256, 2) &&
    value.exactReadOnlyCollectorAuthority === true
  );
}

function validateStageState(state) {
  const findings = [];
  const add = (code) => findings.push(Object.freeze({ code }));
  if (
    !exactKeys(state, [
      'schemaVersion',
      'fixture',
      'phase',
      'observedAt',
      'previousStateSha256',
      'identity',
      'transport',
      'trust',
      'kubernetes',
      'access',
      'gates',
    ]) ||
    state?.schemaVersion !== 1 ||
    state?.fixture !== STATE_FIXTURE ||
    !['old', 'overlap'].includes(state?.phase) ||
    !isIsoTime(state?.observedAt) ||
    (state?.phase === 'old'
      ? state?.previousStateSha256 !== null
      : !SHA256_PATTERN.test(state?.previousStateSha256))
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_STATE_SHAPE');
  }
  if (
    !exactKeys(state?.identity, [
      'providerKind',
      'issuer',
      'audience',
      'type',
      'purpose',
      'subjectSha256',
    ]) ||
    state?.identity?.providerKind !== 'external_oidc' ||
    !externalIssuer(state?.identity?.issuer) ||
    state?.identity?.audience !== AUDIENCE ||
    state?.identity?.type !== TYPE ||
    state?.identity?.purpose !== PURPOSE ||
    !SHA256_PATTERN.test(state?.identity?.subjectSha256)
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_STATE_IDENTITY');
  }
  if (
    !exactKeys(state?.transport, [
      'endpointSha256',
      'servernameSha256',
      'serverTrustBundleSha256',
      'serverAuthoritySha256',
      'commandSha256',
      'oldClientCertificateSha256',
      'newClientCertificateSha256',
    ]) ||
    ![
      state?.transport?.endpointSha256,
      state?.transport?.servernameSha256,
      state?.transport?.serverTrustBundleSha256,
      state?.transport?.commandSha256,
      state?.transport?.oldClientCertificateSha256,
      state?.transport?.newClientCertificateSha256,
    ].every((entry) => SHA256_PATTERN.test(entry)) ||
    !Array.isArray(state?.transport?.serverAuthoritySha256) ||
    state.transport.serverAuthoritySha256.length < 1 ||
    state.transport.serverAuthoritySha256.length > 16 ||
    state.transport.serverAuthoritySha256.some(
      (entry) => !SHA256_PATTERN.test(entry),
    ) ||
    state.transport.oldClientCertificateSha256 ===
      state.transport.newClientCertificateSha256
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_STATE_TRANSPORT');
  }
  const expectedAuthorities = state?.phase === 'old' ? 1 : 2;
  if (
    !exactKeys(state?.trust, [
      'caBundleSha256',
      'crlBundleSha256',
      'caFingerprintSha256',
      'crlIssuerSha256',
      'oldIssuerCaSha256',
      'newIssuerCaSha256',
    ]) ||
    !SHA256_PATTERN.test(state?.trust?.caBundleSha256) ||
    !SHA256_PATTERN.test(state?.trust?.crlBundleSha256) ||
    !validDigestArray(
      state?.trust?.caFingerprintSha256,
      expectedAuthorities,
    ) ||
    !validDigestArray(state?.trust?.crlIssuerSha256, expectedAuthorities) ||
    !SHA256_PATTERN.test(state?.trust?.oldIssuerCaSha256) ||
    (state?.phase === 'old'
      ? state?.trust?.newIssuerCaSha256 !== null
      : !SHA256_PATTERN.test(state?.trust?.newIssuerCaSha256)) ||
    !state?.trust?.caFingerprintSha256.includes(
      state?.trust?.oldIssuerCaSha256,
    ) ||
    (state?.phase === 'overlap' &&
      (!state.trust.caFingerprintSha256.includes(
        state.trust.newIssuerCaSha256,
      ) ||
        state.trust.oldIssuerCaSha256 === state.trust.newIssuerCaSha256))
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_STATE_TRUST');
  }
  if (!validKubernetes(state?.kubernetes)) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_STATE_KUBERNETES');
  }
  const expected = expectedAccess(state?.phase);
  if (
    !exactKeys(state?.access, [
      'oldCertificateStatus',
      'oldCertificateCode',
      'newCertificateStatus',
      'newCertificateCode',
    ]) ||
    state?.access?.oldCertificateStatus !== expected.old ||
    state?.access?.newCertificateStatus !== expected.next ||
    state?.access?.oldCertificateCode !==
      (expected.old === 401 ? 'client_certificate_required' : null) ||
    state?.access?.newCertificateCode !==
      (expected.next === 401 ? 'client_certificate_required' : null)
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_STATE_ACCESS');
  }
  if (
    !exactKeys(state?.gates, [
      'trustSetExact',
      'crlIssuerCoverageExact',
      'deploymentReady',
      'previousGenerationReplaced',
      'readOnlyCollectorAuthority',
      'expectedClientAccess',
      'passed',
    ]) ||
    Object.values(state?.gates ?? {}).some((entry) => entry !== true)
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_STATE_GATES');
  }
  if (containsSensitiveMaterial(state)) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_STATE_SECRET_EXPOSURE');
  }
  return Object.freeze({
    compatible: findings.length === 0,
    findings: Object.freeze(findings),
  });
}

function sameStageAuthority(previous, current) {
  if (
    previous.identity.issuer !== current.identity.issuer ||
    previous.identity.subjectSha256 !== current.identity.subjectSha256 ||
    JSON.stringify(previous.transport) !== JSON.stringify(current.transport) ||
    previous.kubernetes.clusterServerSha256 !==
      current.kubernetes.clusterServerSha256 ||
    previous.kubernetes.collectorSubjectSha256 !==
      current.kubernetes.collectorSubjectSha256 ||
    previous.kubernetes.deploymentUidSha256 !==
      current.kubernetes.deploymentUidSha256
  ) {
    fail('rollover phase authority does not match the previous state');
  }
  if (
    current.kubernetes.deploymentGeneration <=
      previous.kubernetes.deploymentGeneration ||
    current.kubernetes.deploymentResourceVersionSha256 ===
      previous.kubernetes.deploymentResourceVersionSha256 ||
    previous.kubernetes.podUidSha256.some((entry) =>
      current.kubernetes.podUidSha256.includes(entry),
    )
  ) {
    fail('rollover did not replace the complete previous generation');
  }
}

function phaseTrust(phase, oldProfile, newProfile, trust, previous) {
  const oldIssuer = issuerAuthority(oldProfile, trust);
  const newIssuer = issuerAuthority(newProfile, trust);
  if (phase === 'old') {
    if (trust.authorities.length !== 1 || oldIssuer === null || newIssuer !== null) {
      fail('old phase trust set is not exact');
    }
    return Object.freeze({ oldIssuer, newIssuer: null });
  }
  if (phase === 'overlap') {
    if (
      trust.authorities.length !== 2 ||
      oldIssuer === null ||
      newIssuer === null ||
      oldIssuer === newIssuer ||
      oldIssuer !== previous.trust.oldIssuerCaSha256
    ) {
      fail('overlap phase trust set is not the exact old plus new union');
    }
    return Object.freeze({ oldIssuer, newIssuer });
  }
  if (
    trust.authorities.length !== 1 ||
    oldIssuer !== null ||
    newIssuer === null ||
    newIssuer !== previous.trust.newIssuerCaSha256
  ) {
    fail('new phase trust set did not safely retire the old CA');
  }
  return Object.freeze({
    oldIssuer: previous.trust.oldIssuerCaSha256,
    newIssuer,
  });
}

async function observePhase(phase, options, runtime, previous) {
  const nowMs = runtime.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('clock is invalid');
  const identity = identityFromFile(options.assertionFile, nowMs);
  const command = commandFromFile(options.commandFile, runtime.normalize);
  const oldProfile = runtime.inspectClient(
    options.oldConfigFile,
    nowMs,
    runtime.inspectAuthoritySubject,
  );
  const newProfile = runtime.inspectClient(
    options.newConfigFile,
    nowMs,
    runtime.inspectAuthoritySubject,
  );
  sameClientTransport(oldProfile, newProfile);
  const trust = runtime.inspectTrust(
    options.caBundleFile,
    options.crlBundleFile,
    nowMs,
    runtime.inspectAuthoritySubject,
    runtime.inspectCrl,
  );
  const issuers = phaseTrust(phase, oldProfile, newProfile, trust, previous);
  const kubernetes = normalizeKubernetesSnapshot(
    await runtime.collectKubernetes(
      options.kubernetesFile,
      trust.crlBundleSha256,
    ),
    trust.caBundleSha256,
    trust.crlBundleSha256,
  );
  const expected = expectedAccess(phase);
  const oldAccess = await invokeClient(
    runtime.execute,
    options,
    options.oldConfigFile,
    expected.old,
  );
  const newAccess = await invokeClient(
    runtime.execute,
    options,
    options.newConfigFile,
    expected.next,
  );
  const state = Object.freeze({
    schemaVersion: 1,
    fixture: STATE_FIXTURE,
    phase,
    observedAt: new Date(nowMs).toISOString(),
    previousStateSha256:
      previous === null ? null : options.previousStateSha256,
    identity: Object.freeze({
      providerKind: 'external_oidc',
      issuer: identity.issuer,
      audience: AUDIENCE,
      type: TYPE,
      purpose: PURPOSE,
      subjectSha256: digest(
        'qinglong3.worker-management.subject.v1',
        identity.subject,
      ),
    }),
    transport: Object.freeze({
      endpointSha256: oldProfile.endpointSha256,
      servernameSha256: oldProfile.servernameSha256,
      serverTrustBundleSha256: oldProfile.serverTrustBundleSha256,
      serverAuthoritySha256: oldProfile.serverAuthoritySha256,
      commandSha256: command.sha256,
      oldClientCertificateSha256: oldProfile.clientCertificateSha256,
      newClientCertificateSha256: newProfile.clientCertificateSha256,
    }),
    trust: Object.freeze({
      caBundleSha256: trust.caBundleSha256,
      crlBundleSha256: trust.crlBundleSha256,
      caFingerprintSha256: trust.caFingerprintSha256,
      crlIssuerSha256: trust.crlIssuerSha256,
      oldIssuerCaSha256: issuers.oldIssuer,
      newIssuerCaSha256: issuers.newIssuer,
    }),
    kubernetes,
    access: Object.freeze({
      oldCertificateStatus: oldAccess.statusCode,
      oldCertificateCode: oldAccess.responseCode,
      newCertificateStatus: newAccess.statusCode,
      newCertificateCode: newAccess.responseCode,
    }),
    gates: Object.freeze({
      trustSetExact: true,
      crlIssuerCoverageExact: true,
      deploymentReady: true,
      previousGenerationReplaced: true,
      readOnlyCollectorAuthority: true,
      expectedClientAccess: true,
      passed: true,
    }),
  });
  if (phase !== 'old') sameStageAuthority(previous, state);
  return Object.freeze({ state, identity });
}

function readStage(filePath, expectedPhase) {
  const document = readJson(filePath, `${expectedPhase} rollover state`);
  const audit = validateStageState(document.value);
  if (!audit.compatible || document.value.phase !== expectedPhase) {
    document.bytes.fill(0);
    fail(`${expectedPhase} rollover state is incompatible`);
  }
  return document;
}

function commonOptionKeys() {
  return [
    'oldConfigFile',
    'newConfigFile',
    'assertionFile',
    'commandFile',
    'kubernetesFile',
    'caBundleFile',
    'crlBundleFile',
    'outputFile',
  ];
}

async function runOldEvidence(options, dependencies = {}) {
  exactObject(options, commonOptionKeys(), 'old evidence options');
  unusedOutput(options.outputFile);
  const runtime = reviewedDependencies(dependencies);
  const { state } = await observePhase('old', options, runtime, null);
  const audit = validateStageState(state);
  if (!audit.compatible) fail('assembled old state failed audit');
  writeNoReplace(options.outputFile, state);
  return state;
}

async function runOverlapEvidence(options, dependencies = {}) {
  exactObject(
    options,
    ['previousFile', ...commonOptionKeys()],
    'overlap evidence options',
  );
  unusedOutput(options.outputFile);
  const previousDocument = readStage(options.previousFile, 'old');
  try {
    const runtime = reviewedDependencies(dependencies);
    const phaseOptions = {
      ...options,
      previousStateSha256: rawDigest(previousDocument.bytes),
    };
    delete phaseOptions.previousFile;
    const { state } = await observePhase(
      'overlap',
      phaseOptions,
      runtime,
      previousDocument.value,
    );
    const audit = validateStageState(state);
    if (!audit.compatible) fail('assembled overlap state failed audit');
    writeNoReplace(options.outputFile, state);
    return state;
  } finally {
    previousDocument.bytes.fill(0);
  }
}

function assertSourceReports(ceremonyDocument, durableDocument) {
  const ceremonyAudit = validateWorkerCredentialManagementLiveCeremony(
    ceremonyDocument.value,
  );
  const durableAudit = validateWorkerCredentialManagementDurableAuditEvidence(
    durableDocument.value,
  );
  if (!ceremonyAudit.compatible || !durableAudit.compatible) {
    fail('ceremony or durable audit source report is incompatible');
  }
  if (
    durableDocument.value.source.ceremonyReportSha256 !==
      rawDigest(ceremonyDocument.bytes) ||
    durableDocument.value.durableState.requesterSubjectSha256 !==
      ceremonyDocument.value.identity.requesterSubjectSha256 ||
    durableDocument.value.durableState.reviewerSubjectSha256 !==
      ceremonyDocument.value.identity.reviewerSubjectSha256 ||
    durableDocument.value.durableState.planDigest !==
      ceremonyDocument.value.ceremony.planDigest ||
    durableDocument.value.durableState.previewDigest !==
      ceremonyDocument.value.ceremony.previewDigest
  ) {
    fail('durable audit report is not bound to the ceremony report');
  }
}

function validateWorkerCredentialManagementCaRolloverEvidence(report) {
  const findings = [];
  const add = (code) => findings.push(Object.freeze({ code }));
  if (
    !exactKeys(report, [
      'schemaVersion',
      'fixture',
      'observedAt',
      'source',
      'identity',
      'transport',
      'trustTransition',
      'access',
      'kubernetes',
      'gates',
    ]) ||
    report?.schemaVersion !== 1 ||
    report?.fixture !== FIXTURE ||
    !isIsoTime(report?.observedAt)
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_EVIDENCE_SHAPE');
  }
  if (
    !exactKeys(report?.source, [
      'oldStateSha256',
      'overlapStateSha256',
      'ceremonyReportSha256',
      'durableAuditReportSha256',
      'ceremonyFixture',
      'durableAuditFixture',
    ]) ||
    ![
      report?.source?.oldStateSha256,
      report?.source?.overlapStateSha256,
      report?.source?.ceremonyReportSha256,
      report?.source?.durableAuditReportSha256,
    ].every((entry) => SHA256_PATTERN.test(entry)) ||
    report?.source?.ceremonyFixture !== CEREMONY_FIXTURE ||
    report?.source?.durableAuditFixture !== DURABLE_FIXTURE
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_EVIDENCE_SOURCE');
  }
  if (
    !exactKeys(report?.identity, [
      'providerKind',
      'issuer',
      'audience',
      'type',
      'purpose',
      'subjectSha256',
      'ceremonyIdentityBound',
      'durableAuditBound',
    ]) ||
    report?.identity?.providerKind !== 'external_oidc' ||
    !externalIssuer(report?.identity?.issuer) ||
    report?.identity?.audience !== AUDIENCE ||
    report?.identity?.type !== TYPE ||
    report?.identity?.purpose !== PURPOSE ||
    !SHA256_PATTERN.test(report?.identity?.subjectSha256) ||
    report?.identity?.ceremonyIdentityBound !== true ||
    report?.identity?.durableAuditBound !== true
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_EVIDENCE_IDENTITY');
  }
  if (
    !exactKeys(report?.transport, [
      'endpointSha256',
      'servernameSha256',
      'serverTrustBundleSha256',
      'commandSha256',
      'oldClientCertificateSha256',
      'newClientCertificateSha256',
    ]) ||
    Object.values(report?.transport ?? {}).some(
      (entry) => !SHA256_PATTERN.test(entry),
    ) ||
    report?.transport?.oldClientCertificateSha256 ===
      report?.transport?.newClientCertificateSha256
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_EVIDENCE_TRANSPORT');
  }
  const trust = report?.trustTransition;
  if (
    !exactKeys(trust, [
      'oldCaBundleSha256',
      'overlapCaBundleSha256',
      'newCaBundleSha256',
      'oldCrlBundleSha256',
      'overlapCrlBundleSha256',
      'newCrlBundleSha256',
      'oldIssuerCaSha256',
      'newIssuerCaSha256',
      'oldSet',
      'overlapSet',
      'newSet',
      'crlIssuerCoverageExact',
    ]) ||
    ![
      trust?.oldCaBundleSha256,
      trust?.overlapCaBundleSha256,
      trust?.newCaBundleSha256,
      trust?.oldCrlBundleSha256,
      trust?.overlapCrlBundleSha256,
      trust?.newCrlBundleSha256,
      trust?.oldIssuerCaSha256,
      trust?.newIssuerCaSha256,
    ].every((entry) => SHA256_PATTERN.test(entry)) ||
    trust?.oldIssuerCaSha256 === trust?.newIssuerCaSha256 ||
    !validDigestArray(trust?.oldSet, 1) ||
    !validDigestArray(trust?.overlapSet, 2) ||
    !validDigestArray(trust?.newSet, 1) ||
    trust.oldSet[0] !== trust.oldIssuerCaSha256 ||
    trust.newSet[0] !== trust.newIssuerCaSha256 ||
    !trust.overlapSet.includes(trust.oldIssuerCaSha256) ||
    !trust.overlapSet.includes(trust.newIssuerCaSha256) ||
    trust?.crlIssuerCoverageExact !== true
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_EVIDENCE_TRUST');
  }
  if (
    !exactKeys(report?.access, [
      'oldCertificateStatus',
      'newCertificateStatus',
    ]) ||
    JSON.stringify(report?.access?.oldCertificateStatus) !==
      JSON.stringify([200, 200, 401]) ||
    JSON.stringify(report?.access?.newCertificateStatus) !==
      JSON.stringify([401, 200, 200])
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_EVIDENCE_ACCESS');
  }
  const kubernetes = report?.kubernetes;
  if (
    !exactKeys(kubernetes, [
      'clusterServerSha256',
      'collectorSubjectSha256',
      'deploymentUidSha256',
      'generations',
      'resourceVersionSha256',
      'podUidSha256',
      'allGenerationsFullyReplaced',
      'twoReadyReplicasOnDistinctNodes',
      'exactReadOnlyCollectorAuthority',
    ]) ||
    ![
      kubernetes?.clusterServerSha256,
      kubernetes?.collectorSubjectSha256,
      kubernetes?.deploymentUidSha256,
    ].every((entry) => SHA256_PATTERN.test(entry)) ||
    !Array.isArray(kubernetes?.generations) ||
    kubernetes.generations.length !== 3 ||
    !kubernetes.generations.every(Number.isSafeInteger) ||
    !(
      kubernetes.generations[0] < kubernetes.generations[1] &&
      kubernetes.generations[1] < kubernetes.generations[2]
    ) ||
    !validDigestSequence(kubernetes?.resourceVersionSha256, 3) ||
    !Array.isArray(kubernetes?.podUidSha256) ||
    kubernetes.podUidSha256.length !== 3 ||
    kubernetes.podUidSha256.some((set) => !validDigestArray(set, 2)) ||
    new Set(kubernetes.podUidSha256.flat()).size !== 6 ||
    kubernetes?.allGenerationsFullyReplaced !== true ||
    kubernetes?.twoReadyReplicasOnDistinctNodes !== true ||
    kubernetes?.exactReadOnlyCollectorAuthority !== true
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_EVIDENCE_KUBERNETES');
  }
  if (
    !exactKeys(report?.gates, [
      'sourceReportsBound',
      'externalIdentityBound',
      'serverTrustSeparatedFromClientIssuer',
      'oldOnlyObserved',
      'exactOverlapObserved',
      'safeRetirementObserved',
      'crlCoverageObservedEveryPhase',
      'allPodGenerationsReplaced',
      'readOnlyCollectorAuthority',
      'passed',
    ]) ||
    Object.values(report?.gates ?? {}).some((entry) => entry !== true)
  ) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_EVIDENCE_GATES');
  }
  if (containsSensitiveMaterial(report)) {
    add('QL3_WORKER_MANAGEMENT_CA_ROLLOVER_EVIDENCE_SECRET_EXPOSURE');
  }
  return Object.freeze({
    compatible: findings.length === 0,
    findings: Object.freeze(findings),
  });
}

async function runNewEvidence(options, dependencies = {}) {
  exactObject(
    options,
    [
      'oldFile',
      'previousFile',
      ...commonOptionKeys(),
      'ceremonyReportFile',
      'durableAuditReportFile',
    ],
    'new evidence options',
  );
  unusedOutput(options.outputFile);
  const oldDocument = readStage(options.oldFile, 'old');
  const overlapDocument = readStage(options.previousFile, 'overlap');
  const ceremonyDocument = readJson(
    options.ceremonyReportFile,
    'ceremony report',
  );
  const durableDocument = readJson(
    options.durableAuditReportFile,
    'durable audit report',
  );
  try {
    if (
      overlapDocument.value.previousStateSha256 !==
      rawDigest(oldDocument.bytes)
    ) {
      fail('overlap state is not chained to the old state');
    }
    assertSourceReports(ceremonyDocument, durableDocument);
    const runtime = reviewedDependencies(dependencies);
    const phaseOptions = {
      ...options,
      previousStateSha256: rawDigest(overlapDocument.bytes),
    };
    delete phaseOptions.oldFile;
    delete phaseOptions.previousFile;
    delete phaseOptions.ceremonyReportFile;
    delete phaseOptions.durableAuditReportFile;
    const { state: current, identity } = await observePhase(
      'new',
      phaseOptions,
      runtime,
      overlapDocument.value,
    );
    sameStageAuthority(oldDocument.value, overlapDocument.value);
    if (
      oldDocument.value.trust.oldIssuerCaSha256 !==
        overlapDocument.value.trust.oldIssuerCaSha256 ||
      current.trust.oldIssuerCaSha256 !==
        overlapDocument.value.trust.oldIssuerCaSha256 ||
      current.trust.newIssuerCaSha256 !==
        overlapDocument.value.trust.newIssuerCaSha256
    ) {
      fail('client CA identities drifted across rollover phases');
    }
    const subjectSha256 = digest(
      'qinglong3.worker-management.subject.v1',
      identity.subject,
    );
    const ceremonySubjects = [
      ceremonyDocument.value.identity.requesterSubjectSha256,
      ceremonyDocument.value.identity.reviewerSubjectSha256,
    ];
    if (
      current.identity.subjectSha256 !== subjectSha256 ||
      identity.issuer !== ceremonyDocument.value.identity.issuer ||
      !ceremonySubjects.includes(subjectSha256) ||
      ![
        durableDocument.value.durableState.requesterSubjectSha256,
        durableDocument.value.durableState.reviewerSubjectSha256,
      ].includes(subjectSha256)
    ) {
      fail('new phase identity is not bound to the reviewed ceremony');
    }
    const report = Object.freeze({
      schemaVersion: 1,
      fixture: FIXTURE,
      observedAt: current.observedAt,
      source: Object.freeze({
        oldStateSha256: rawDigest(oldDocument.bytes),
        overlapStateSha256: rawDigest(overlapDocument.bytes),
        ceremonyReportSha256: rawDigest(ceremonyDocument.bytes),
        durableAuditReportSha256: rawDigest(durableDocument.bytes),
        ceremonyFixture: CEREMONY_FIXTURE,
        durableAuditFixture: DURABLE_FIXTURE,
      }),
      identity: Object.freeze({
        ...current.identity,
        ceremonyIdentityBound: true,
        durableAuditBound: true,
      }),
      transport: Object.freeze({
        endpointSha256: current.transport.endpointSha256,
        servernameSha256: current.transport.servernameSha256,
        serverTrustBundleSha256:
          current.transport.serverTrustBundleSha256,
        commandSha256: current.transport.commandSha256,
        oldClientCertificateSha256:
          current.transport.oldClientCertificateSha256,
        newClientCertificateSha256:
          current.transport.newClientCertificateSha256,
      }),
      trustTransition: Object.freeze({
        oldCaBundleSha256: oldDocument.value.trust.caBundleSha256,
        overlapCaBundleSha256:
          overlapDocument.value.trust.caBundleSha256,
        newCaBundleSha256: current.trust.caBundleSha256,
        oldCrlBundleSha256: oldDocument.value.trust.crlBundleSha256,
        overlapCrlBundleSha256:
          overlapDocument.value.trust.crlBundleSha256,
        newCrlBundleSha256: current.trust.crlBundleSha256,
        oldIssuerCaSha256: current.trust.oldIssuerCaSha256,
        newIssuerCaSha256: current.trust.newIssuerCaSha256,
        oldSet: oldDocument.value.trust.caFingerprintSha256,
        overlapSet: overlapDocument.value.trust.caFingerprintSha256,
        newSet: current.trust.caFingerprintSha256,
        crlIssuerCoverageExact: true,
      }),
      access: Object.freeze({
        oldCertificateStatus: Object.freeze([
          oldDocument.value.access.oldCertificateStatus,
          overlapDocument.value.access.oldCertificateStatus,
          current.access.oldCertificateStatus,
        ]),
        newCertificateStatus: Object.freeze([
          oldDocument.value.access.newCertificateStatus,
          overlapDocument.value.access.newCertificateStatus,
          current.access.newCertificateStatus,
        ]),
      }),
      kubernetes: Object.freeze({
        clusterServerSha256: current.kubernetes.clusterServerSha256,
        collectorSubjectSha256:
          current.kubernetes.collectorSubjectSha256,
        deploymentUidSha256: current.kubernetes.deploymentUidSha256,
        generations: Object.freeze([
          oldDocument.value.kubernetes.deploymentGeneration,
          overlapDocument.value.kubernetes.deploymentGeneration,
          current.kubernetes.deploymentGeneration,
        ]),
        resourceVersionSha256: Object.freeze([
          oldDocument.value.kubernetes.deploymentResourceVersionSha256,
          overlapDocument.value.kubernetes
            .deploymentResourceVersionSha256,
          current.kubernetes.deploymentResourceVersionSha256,
        ]),
        podUidSha256: Object.freeze([
          oldDocument.value.kubernetes.podUidSha256,
          overlapDocument.value.kubernetes.podUidSha256,
          current.kubernetes.podUidSha256,
        ]),
        allGenerationsFullyReplaced: true,
        twoReadyReplicasOnDistinctNodes: true,
        exactReadOnlyCollectorAuthority: true,
      }),
      gates: Object.freeze({
        sourceReportsBound: true,
        externalIdentityBound: true,
        serverTrustSeparatedFromClientIssuer: true,
        oldOnlyObserved: true,
        exactOverlapObserved: true,
        safeRetirementObserved: true,
        crlCoverageObservedEveryPhase: true,
        allPodGenerationsReplaced: true,
        readOnlyCollectorAuthority: true,
        passed: true,
      }),
    });
    const audit = validateWorkerCredentialManagementCaRolloverEvidence(report);
    if (!audit.compatible) {
      fail(
        `assembled report failed audit: ${audit.findings
          .map(({ code }) => code)
          .join(',')}`,
      );
    }
    writeNoReplace(options.outputFile, report);
    return report;
  } finally {
    oldDocument.bytes.fill(0);
    overlapDocument.bytes.fill(0);
    ceremonyDocument.bytes.fill(0);
    durableDocument.bytes.fill(0);
  }
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (argument === '--') continue;
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) fail('arguments are invalid');
    values[match[1]] = match[2];
  }
  if (!['old', 'overlap', 'new'].includes(values.phase)) {
    fail('phase must be old, overlap or new');
  }
  const common = [
    'phase',
    'old-config',
    'new-config',
    'assertion',
    'command',
    'kubernetes',
    'client-ca-bundle',
    'client-crl-bundle',
    'output',
  ];
  const expected =
    values.phase === 'old'
      ? common
      : values.phase === 'overlap'
        ? [...common, 'previous']
        : [
            ...common,
            'old',
            'previous',
            'ceremony-report',
            'durable-audit-report',
          ];
  if (
    JSON.stringify(Object.keys(values).sort()) !==
    JSON.stringify(expected.sort())
  ) {
    fail('arguments are invalid');
  }
  const shared = {
    oldConfigFile: values['old-config'],
    newConfigFile: values['new-config'],
    assertionFile: values.assertion,
    commandFile: values.command,
    kubernetesFile: values.kubernetes,
    caBundleFile: values['client-ca-bundle'],
    crlBundleFile: values['client-crl-bundle'],
    outputFile: values.output,
  };
  return Object.freeze(
    values.phase === 'old'
      ? { phase: 'old', options: Object.freeze(shared) }
      : values.phase === 'overlap'
        ? {
            phase: 'overlap',
            options: Object.freeze({
              previousFile: values.previous,
              ...shared,
            }),
          }
        : {
            phase: 'new',
            options: Object.freeze({
              oldFile: values.old,
              previousFile: values.previous,
              ...shared,
              ceremonyReportFile: values['ceremony-report'],
              durableAuditReportFile: values['durable-audit-report'],
            }),
          },
  );
}

async function runCli(argv) {
  if (
    process.env.QL3_WORKER_CREDENTIAL_MANAGEMENT_CA_ROLLOVER_EVIDENCE !== '1'
  ) {
    fail('explicit CA rollover evidence opt-in is required');
  }
  const parsed = parseArguments(argv);
  if (parsed.phase === 'old') await runOldEvidence(parsed.options);
  else if (parsed.phase === 'overlap') {
    await runOverlapEvidence(parsed.options);
  } else await runNewEvidence(parsed.options);
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      fixture: FIXTURE,
      phase: parsed.phase,
      compatible: true,
    })}\n`,
  );
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'CA rollover evidence failed'}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  CA_ANNOTATION,
  CRL_ANNOTATION,
  FIXTURE,
  STATE_FIXTURE,
  WorkerCredentialManagementCaRolloverEvidenceError,
  defaultInspectAuthoritySubject,
  defaultInspectCrl,
  inspectClientConfiguration,
  inspectTrustBundles,
  normalizeKubernetesSnapshot,
  parseArguments,
  runNewEvidence,
  runOldEvidence,
  runOverlapEvidence,
  validateStageState,
  validateWorkerCredentialManagementCaRolloverEvidence,
};
