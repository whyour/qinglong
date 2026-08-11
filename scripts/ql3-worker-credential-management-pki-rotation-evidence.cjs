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

const FIXTURE =
  'qinglong/worker-credential-management-pki-rotation-evidence@v2';
const STATE_FIXTURE =
  'qinglong/worker-credential-management-pki-rotation-state@v2';
const CEREMONY_FIXTURE =
  'qinglong/worker-credential-management-live-ceremony@v1';
const DURABLE_FIXTURE =
  'qinglong/worker-credential-management-durable-audit-evidence@v1';
const TYPE = 'ql3-worker-credential-management+jwt';
const PURPOSE = 'worker-credential-management';
const AUDIENCE = 'qinglong3-worker-credential-management';
const NAMESPACE = 'qinglong3-system';
const DEPLOYMENT = 'ql3-worker-credential-management';
const LABEL_SELECTOR =
  'app.kubernetes.io/name=ql3-worker-credential-management,' +
  'app.kubernetes.io/component=worker-credential-management';
const CRL_ANNOTATION =
  'qinglong.io/worker-credential-management-client-crl-sha256';
const MAX_FILE_BYTES = 1024 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HEX_PATTERN = /^[a-f0-9]{1,64}$/;
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

class WorkerCredentialManagementPkiRotationEvidenceError extends Error {
  constructor(message) {
    super(
      `Worker credential management PKI rotation evidence failed: ${message}`,
    );
    this.name = 'WorkerCredentialManagementPkiRotationEvidenceError';
  }
}

function fail(message) {
  throw new WorkerCredentialManagementPkiRotationEvidenceError(message);
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
    fail(
      `${label} must be one canonical bounded ${
        privateFile ? 'private ' : ''
      }file`,
    );
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
    if (error instanceof WorkerCredentialManagementPkiRotationEvidenceError) {
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
    const text = `${JSON.stringify(value, null, 2)}\n`;
    fs.writeFileSync(descriptor, text, { encoding: 'utf8' });
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

function normalizeHex(value, label) {
  if (typeof value !== 'string') fail(`${label} is invalid`);
  const normalized = value.replace(/^0x/i, '').replace(/^0+/, '') || '0';
  if (!HEX_PATTERN.test(normalized)) fail(`${label} is invalid`);
  return normalized;
}

function parseCrlInspectionOutput(output) {
  const lines = output.trim().split('\n');
  if (lines.length !== 5) fail('CRL metadata is incomplete');
  const fingerprint = /^SHA256 Fingerprint=([A-F0-9:]{95})$/i.exec(
    lines[0],
  )?.[1];
  const issuer = /^issuer=(.+)$/.exec(lines[1])?.[1];
  const lastUpdate = /^lastUpdate=(.+)$/.exec(lines[2])?.[1];
  const nextUpdate = /^nextUpdate=(.+)$/.exec(lines[3])?.[1];
  const number = /^crlNumber=(0x[A-F0-9]+)$/i.exec(lines[4])?.[1];
  const parsedLast = Date.parse(lastUpdate ?? '');
  const parsedNext = Date.parse(nextUpdate ?? '');
  if (
    !fingerprint ||
    !issuer ||
    !Number.isFinite(parsedLast) ||
    !Number.isFinite(parsedNext) ||
    parsedNext <= parsedLast ||
    !number
  ) {
    fail('CRL metadata is invalid');
  }
  return Object.freeze({
    sha256: `sha256:${fingerprint.replaceAll(':', '').toLowerCase()}`,
    issuerSha256: digest('qinglong3.worker-management.crl-issuer.v1', issuer),
    number: normalizeHex(number, 'CRL number'),
    lastUpdateMs: parsedLast,
    nextUpdateMs: parsedNext,
  });
}

function defaultInspectCrl(bytes) {
  const result = spawnSync(
    'openssl',
    [
      'crl',
      '-inform',
      'PEM',
      '-noout',
      '-fingerprint',
      '-sha256',
      '-issuer',
      '-nameopt',
      'RFC2253',
      '-lastupdate',
      '-nextupdate',
      '-crlnumber',
    ],
    {
      input: bytes,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: {
        PATH: process.env.PATH,
        LANG: 'C',
        LC_ALL: 'C',
      },
    },
  );
  if (result.status !== 0 || result.signal !== null) {
    fail('CRL is not accepted by OpenSSL');
  }
  return parseCrlInspectionOutput(result.stdout);
}

function exactCertificateBlocks(bytes, label) {
  let value;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} must be strict UTF-8`);
  }
  const pattern =
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const matches = value.match(pattern);
  if (!matches || matches.length < 1 || matches.length > 16) {
    fail(`${label} must contain 1 to 16 certificates`);
  }
  if (value.replace(pattern, '').trim() !== '') {
    fail(`${label} contains unsupported data`);
  }
  return matches.map((match) => Buffer.from(`${match}\n`, 'utf8'));
}

function defaultInspectAuthoritySubject(bytes) {
  const result = spawnSync(
    'openssl',
    ['x509', '-noout', '-subject', '-nameopt', 'RFC2253'],
    {
      input: bytes,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: {
        PATH: process.env.PATH,
        LANG: 'C',
        LC_ALL: 'C',
      },
    },
  );
  const subject = /^subject=(.+)$/.exec(result.stdout.trim())?.[1];
  if (result.status !== 0 || result.signal !== null || !subject) {
    fail('client issuer CA subject is not accepted by OpenSSL');
  }
  return subject;
}

function inspectAuthorityBundle(bytes, nowMs, label, inspectSubject) {
  const blocks = exactCertificateBlocks(bytes, label);
  const fingerprints = new Set();
  const subjects = new Set();
  const authorities = [];
  try {
    for (const block of blocks) {
      let certificate;
      try {
        certificate = new X509Certificate(block);
      } catch {
        fail(`${label} contains an invalid certificate`);
      }
      const fingerprintSha256 = `sha256:${certificate.fingerprint256
        .replaceAll(':', '')
        .toLowerCase()}`;
      const subject = inspectSubject(block);
      if (
        certificate.ca !== true ||
        Date.parse(certificate.validFrom) > nowMs ||
        Date.parse(certificate.validTo) <= nowMs ||
        fingerprints.has(fingerprintSha256) ||
        subjects.has(subject)
      ) {
        fail(`${label} contains inactive or duplicate CA material`);
      }
      fingerprints.add(fingerprintSha256);
      subjects.add(subject);
      authorities.push(
        Object.freeze({ certificate, fingerprintSha256, subject }),
      );
    }
    return Object.freeze({
      bundleSha256: rawDigest(bytes),
      authorities: Object.freeze(authorities),
      authoritySha256: Object.freeze(
        authorities.map(({ fingerprintSha256 }) => fingerprintSha256).sort(),
      ),
    });
  } finally {
    for (const block of blocks) block.fill(0);
  }
}

function inspectClientIssuerAuthority(
  issuerCaFile,
  nowMs,
  inspectSubject = defaultInspectAuthoritySubject,
) {
  const bytes = readBuffer(issuerCaFile, 'client issuer CA', {
    private: false,
    maximum: 256 * 1024,
  });
  try {
    const bundle = inspectAuthorityBundle(
      bytes,
      nowMs,
      'client issuer CA',
      inspectSubject,
    );
    if (bundle.authorities.length !== 1) {
      fail('client issuer CA must contain exactly one authority');
    }
    const authority = bundle.authorities[0];
    return Object.freeze({
      bundleSha256: bundle.bundleSha256,
      certificateSha256: authority.fingerprintSha256,
      subjectSha256: digest(
        'qinglong3.worker-management.crl-issuer.v1',
        authority.subject,
      ),
      certificate: authority.certificate,
    });
  } finally {
    bytes.fill(0);
  }
}

function inspectClientConfiguration(
  configFile,
  nowMs,
  inspectSubject = defaultInspectAuthoritySubject,
) {
  const configDocument = readJson(configFile, 'management client config');
  try {
    const config = exactObject(
      configDocument.value,
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
    const caBytes = readBuffer(config.caFile, 'management server CA', {
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
      const serverTrust = inspectAuthorityBundle(
        caBytes,
        nowMs,
        'management server CA bundle',
        inspectSubject,
      );
      const certificate = new X509Certificate(certificateBytes);
      const privateKey = createPrivateKey(privateKeyBytes);
      if (
        certificate.ca !== false ||
        certificate.checkPrivateKey(privateKey) !== true ||
        !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.2') ||
        Date.parse(certificate.validFrom) > nowMs ||
        Date.parse(certificate.validTo) <= nowMs
      ) {
        fail('management client certificate profile is invalid');
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
        serverTrustBundleSha256: serverTrust.bundleSha256,
        serverAuthoritySha256: serverTrust.authoritySha256,
        clientCertificateSha256: `sha256:${certificate.fingerprint256
          .replaceAll(':', '')
          .toLowerCase()}`,
        certificate,
      });
    } catch (error) {
      if (error instanceof WorkerCredentialManagementPkiRotationEvidenceError) {
        throw error;
      }
      fail('management client certificate material is invalid');
    } finally {
      caBytes.fill(0);
      certificateBytes.fill(0);
      privateKeyBytes.fill(0);
    }
  } finally {
    configDocument.bytes.fill(0);
  }
}

function decodeCanonicalBase64(value, label, maximum) {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > maximum * 2 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    fail(`${label} encoding is invalid`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.length < 1 ||
    bytes.length > maximum ||
    bytes.toString('base64') !== value
  ) {
    bytes.fill(0);
    fail(`${label} encoding is invalid`);
  }
  return bytes;
}

function parseKubernetesConfig(filePath) {
  const configDocument = readJson(filePath, 'Kubernetes evidence config');
  try {
    const config = exactObject(
      configDocument.value,
      [
        'schemaVersion',
        'kubeconfigFile',
        'context',
        'namespace',
        'deployment',
        'labelSelector',
        'apiTimeoutMs',
      ],
      'Kubernetes evidence config',
    );
    if (
      config.schemaVersion !== 1 ||
      typeof config.kubeconfigFile !== 'string' ||
      typeof config.context !== 'string' ||
      !TOKEN_PATTERN.test(config.context) ||
      config.namespace !== NAMESPACE ||
      config.deployment !== DEPLOYMENT ||
      config.labelSelector !== LABEL_SELECTOR ||
      !Number.isSafeInteger(config.apiTimeoutMs) ||
      config.apiTimeoutMs < 1_000 ||
      config.apiTimeoutMs > 30_000
    ) {
      fail('Kubernetes evidence config is invalid');
    }
    const kubeconfigDocument = readJson(
      config.kubeconfigFile,
      'Kubernetes evidence kubeconfig',
    );
    try {
      const kubeconfig = exactObject(
        kubeconfigDocument.value,
        [
          'apiVersion',
          'kind',
          'clusters',
          'users',
          'contexts',
          'current-context',
        ],
        'Kubernetes evidence kubeconfig',
      );
      if (
        kubeconfig.apiVersion !== 'v1' ||
        kubeconfig.kind !== 'Config' ||
        kubeconfig['current-context'] !== config.context ||
        !Array.isArray(kubeconfig.clusters) ||
        kubeconfig.clusters.length !== 1 ||
        !Array.isArray(kubeconfig.users) ||
        kubeconfig.users.length !== 1 ||
        !Array.isArray(kubeconfig.contexts) ||
        kubeconfig.contexts.length !== 1
      ) {
        fail('Kubernetes evidence kubeconfig topology is invalid');
      }
      const clusterEntry = exactObject(
        kubeconfig.clusters[0],
        ['name', 'cluster'],
        'Kubernetes cluster entry',
      );
      const userEntry = exactObject(
        kubeconfig.users[0],
        ['name', 'user'],
        'Kubernetes user entry',
      );
      const contextEntry = exactObject(
        kubeconfig.contexts[0],
        ['name', 'context'],
        'Kubernetes context entry',
      );
      const cluster = exactObject(
        clusterEntry.cluster,
        ['server', 'certificate-authority-data'],
        'Kubernetes cluster authority',
      );
      const context = exactObject(
        contextEntry.context,
        ['cluster', 'user', 'namespace'],
        'Kubernetes context authority',
      );
      const user = userEntry.user;
      if (!user || typeof user !== 'object' || Array.isArray(user)) {
        fail('Kubernetes user authority is invalid');
      }
      const userKeys = Object.keys(user).sort();
      if (
        JSON.stringify(userKeys) !== JSON.stringify(['token']) &&
        JSON.stringify(userKeys) !==
          JSON.stringify(['client-certificate-data', 'client-key-data'].sort())
      ) {
        fail('Kubernetes user authority is not a static identity');
      }
      if (
        typeof clusterEntry.name !== 'string' ||
        !TOKEN_PATTERN.test(clusterEntry.name) ||
        typeof userEntry.name !== 'string' ||
        !TOKEN_PATTERN.test(userEntry.name) ||
        contextEntry.name !== config.context ||
        context.cluster !== clusterEntry.name ||
        context.user !== userEntry.name ||
        context.namespace !== NAMESPACE
      ) {
        fail('Kubernetes evidence context is invalid');
      }
      let server;
      try {
        server = new URL(cluster.server);
      } catch {
        fail('Kubernetes API server is invalid');
      }
      if (
        server.protocol !== 'https:' ||
        server.username !== '' ||
        server.password !== '' ||
        (server.pathname !== '' && server.pathname !== '/') ||
        server.search !== '' ||
        server.hash !== '' ||
        server.hostname.length < 1
      ) {
        fail('Kubernetes API server authority is invalid');
      }
      const ca = decodeCanonicalBase64(
        cluster['certificate-authority-data'],
        'Kubernetes CA',
        256 * 1024,
      );
      try {
        new X509Certificate(ca);
      } catch {
        fail('Kubernetes CA is invalid');
      } finally {
        ca.fill(0);
      }
      if (Object.hasOwn(user, 'token')) {
        if (
          typeof user.token !== 'string' ||
          user.token.length < 16 ||
          user.token.length > 16 * 1024 ||
          CONTROL_PATTERN.test(user.token)
        ) {
          fail('Kubernetes static token is invalid');
        }
      } else {
        const certificate = decodeCanonicalBase64(
          user['client-certificate-data'],
          'Kubernetes client certificate',
          256 * 1024,
        );
        const privateKey = decodeCanonicalBase64(
          user['client-key-data'],
          'Kubernetes client private key',
          256 * 1024,
        );
        try {
          const parsedCertificate = new X509Certificate(certificate);
          const parsedPrivateKey = createPrivateKey(privateKey);
          if (!parsedCertificate.checkPrivateKey(parsedPrivateKey)) {
            fail('Kubernetes client identity does not match');
          }
        } catch (error) {
          if (
            error instanceof WorkerCredentialManagementPkiRotationEvidenceError
          ) {
            throw error;
          }
          fail('Kubernetes client identity is invalid');
        } finally {
          certificate.fill(0);
          privateKey.fill(0);
        }
      }
      return Object.freeze({
        kubeconfigFile: config.kubeconfigFile,
        context: config.context,
        namespace: NAMESPACE,
        deployment: DEPLOYMENT,
        labelSelector: LABEL_SELECTOR,
        apiTimeoutMs: config.apiTimeoutMs,
        clusterServerSha256: digest(
          'qinglong3.worker-management.kubernetes-server.v1',
          server.toString(),
        ),
        collectorSubjectSha256: digest(
          'qinglong3.worker-management.kubernetes-subject.v1',
          userEntry.name,
        ),
      });
    } finally {
      kubeconfigDocument.bytes.fill(0);
    }
  } finally {
    configDocument.bytes.fill(0);
  }
}

function defaultRunKubectl(config, args) {
  const binary = process.env.QL3_KUBECTL_BIN || 'kubectl';
  return spawnSync(
    binary,
    [
      '--kubeconfig',
      config.kubeconfigFile,
      '--context',
      config.context,
      `--request-timeout=${config.apiTimeoutMs}ms`,
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: config.apiTimeoutMs + 2_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        LANG: 'C',
        LC_ALL: 'C',
      },
    },
  );
}

function kubectlOutput(config, args, runKubectl, label) {
  const result = runKubectl(config, args);
  if (
    !result ||
    result.status !== 0 ||
    result.signal !== null ||
    typeof result.stdout !== 'string' ||
    result.stdout.length < 1 ||
    result.stdout.length > 2 * 1024 * 1024
  ) {
    fail(`${label} Kubernetes observation failed`);
  }
  return result.stdout.trim();
}

const REVIEWED_AUTHORITY = Object.freeze([
  Object.freeze({
    verb: 'get',
    resource: `deployments.apps/${DEPLOYMENT}`,
    allowed: true,
  }),
  Object.freeze({ verb: 'list', resource: 'pods', allowed: true }),
  Object.freeze({ verb: 'get', resource: 'secrets', allowed: false }),
  Object.freeze({ verb: 'list', resource: 'secrets', allowed: false }),
  Object.freeze({ verb: 'get', resource: 'configmaps', allowed: false }),
  Object.freeze({ verb: 'list', resource: 'deployments.apps', allowed: false }),
  ...['create', 'update', 'patch', 'delete'].flatMap((verb) =>
    ['deployments.apps', 'secrets', 'pods'].map((resource) =>
      Object.freeze({ verb, resource, allowed: false }),
    ),
  ),
  Object.freeze({ verb: 'create', resource: 'pods/exec', allowed: false }),
  Object.freeze({
    verb: 'create',
    resource: 'pods/portforward',
    allowed: false,
  }),
  Object.freeze({
    verb: 'create',
    resource: 'serviceaccounts/token',
    allowed: false,
  }),
]);

function collectKubernetesSnapshot(
  kubernetesFile,
  _crlSha256,
  runKubectl = defaultRunKubectl,
) {
  const config = parseKubernetesConfig(kubernetesFile);
  const authorization = REVIEWED_AUTHORITY.map((check) => {
    const output = kubectlOutput(
      config,
      ['--namespace', NAMESPACE, 'auth', 'can-i', check.verb, check.resource],
      runKubectl,
      'authorization',
    );
    if (!['yes', 'no'].includes(output)) {
      fail('Kubernetes authorization response is invalid');
    }
    return Object.freeze({ ...check, observed: output === 'yes' });
  });
  const deployment = jsonFromBytes(
    Buffer.from(
      kubectlOutput(
        config,
        [
          '--namespace',
          NAMESPACE,
          'get',
          'deployment.apps',
          DEPLOYMENT,
          '--output=json',
        ],
        runKubectl,
        'Deployment',
      ),
    ),
    'Deployment response',
  );
  const pods = jsonFromBytes(
    Buffer.from(
      kubectlOutput(
        config,
        [
          '--namespace',
          NAMESPACE,
          'get',
          'pods',
          '--selector',
          LABEL_SELECTOR,
          '--output=json',
        ],
        runKubectl,
        'Pod',
      ),
    ),
    'Pod response',
  );
  return Object.freeze({
    clusterServerSha256: config.clusterServerSha256,
    collectorSubjectSha256: config.collectorSubjectSha256,
    authorization,
    deployment,
    pods,
  });
}

function readyCondition(conditions, type) {
  return (
    Array.isArray(conditions) &&
    conditions.some(
      (condition) => condition?.type === type && condition?.status === 'True',
    )
  );
}

function normalizeKubernetesSnapshot(value, crlSha256) {
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
    spec?.template?.metadata?.annotations?.[CRL_ANNOTATION] !== crlSha256 ||
    status?.observedGeneration !== metadata.generation ||
    status?.replicas !== 2 ||
    status?.updatedReplicas !== 2 ||
    status?.readyReplicas !== 2 ||
    status?.availableReplicas !== 2 ||
    (status?.unavailableReplicas ?? 0) !== 0
  ) {
    fail('Kubernetes Deployment is not one converged CRL-bound rollout');
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
        !readyCondition(pod.status?.conditions, 'Ready') ||
        pod.status?.containerStatuses?.some(
          (container) =>
            container.name === 'management' && container.ready === true,
        ) !== true,
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
    observedGeneration: status.observedGeneration,
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
    podTemplateSha256: digest(
      'qinglong3.worker-management.pod-template.v1',
      current[0].metadata.labels['pod-template-hash'],
    ),
    replicas: 2,
    distinctNodes: true,
    exactReadOnlyCollectorAuthority: true,
    secretReadDenied: true,
    mutationDenied: true,
  });
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

function isIsoTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validKubernetesEvidence(value) {
  return (
    exactKeys(value, [
      'clusterServerSha256',
      'collectorSubjectSha256',
      'deploymentUidSha256',
      'deploymentResourceVersionSha256',
      'deploymentGeneration',
      'observedGeneration',
      'crlAnnotationSha256',
      'podUidSha256',
      'podNodeSha256',
      'podTemplateSha256',
      'replicas',
      'distinctNodes',
      'exactReadOnlyCollectorAuthority',
      'secretReadDenied',
      'mutationDenied',
    ]) &&
    [
      value.clusterServerSha256,
      value.collectorSubjectSha256,
      value.deploymentUidSha256,
      value.deploymentResourceVersionSha256,
      value.crlAnnotationSha256,
      value.podTemplateSha256,
    ].every((entry) => SHA256_PATTERN.test(entry)) &&
    Number.isSafeInteger(value.deploymentGeneration) &&
    value.deploymentGeneration >= 1 &&
    value.observedGeneration === value.deploymentGeneration &&
    value.replicas === 2 &&
    value.distinctNodes === true &&
    value.exactReadOnlyCollectorAuthority === true &&
    value.secretReadDenied === true &&
    value.mutationDenied === true &&
    Array.isArray(value.podUidSha256) &&
    value.podUidSha256.length === 2 &&
    value.podUidSha256.every((entry) => SHA256_PATTERN.test(entry)) &&
    new Set(value.podUidSha256).size === 2 &&
    Array.isArray(value.podNodeSha256) &&
    value.podNodeSha256.length === 2 &&
    value.podNodeSha256.every((entry) => SHA256_PATTERN.test(entry)) &&
    new Set(value.podNodeSha256).size === 2
  );
}

function validateBeforeState(state) {
  const findings = [];
  const add = (code) => findings.push(Object.freeze({ code }));
  if (
    !exactKeys(state, [
      'schemaVersion',
      'fixture',
      'observedAt',
      'identity',
      'transport',
      'pki',
      'kubernetes',
      'access',
      'gates',
    ]) ||
    state?.schemaVersion !== 2 ||
    state?.fixture !== STATE_FIXTURE ||
    !isIsoTime(state?.observedAt)
  ) {
    add('QL3_WORKER_MANAGEMENT_PKI_STATE_SHAPE');
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
    add('QL3_WORKER_MANAGEMENT_PKI_STATE_IDENTITY');
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
    new Set(state.transport.serverAuthoritySha256).size !==
      state.transport.serverAuthoritySha256.length ||
    JSON.stringify(state.transport.serverAuthoritySha256) !==
      JSON.stringify([...state.transport.serverAuthoritySha256].sort()) ||
    state?.transport?.oldClientCertificateSha256 ===
      state?.transport?.newClientCertificateSha256
  ) {
    add('QL3_WORKER_MANAGEMENT_PKI_STATE_TRANSPORT');
  }
  if (
    !exactKeys(state?.pki, [
      'clientIssuerBundleSha256',
      'clientIssuerCaSha256',
      'clientIssuerSubjectSha256',
      'crlSha256',
      'crlIssuerSha256',
      'crlNumber',
      'lastUpdateMs',
      'nextUpdateMs',
    ]) ||
    !SHA256_PATTERN.test(state?.pki?.clientIssuerBundleSha256) ||
    !SHA256_PATTERN.test(state?.pki?.clientIssuerCaSha256) ||
    !SHA256_PATTERN.test(state?.pki?.clientIssuerSubjectSha256) ||
    !SHA256_PATTERN.test(state?.pki?.crlSha256) ||
    !SHA256_PATTERN.test(state?.pki?.crlIssuerSha256) ||
    state?.pki?.clientIssuerSubjectSha256 !==
      state?.pki?.crlIssuerSha256 ||
    !HEX_PATTERN.test(state?.pki?.crlNumber) ||
    !Number.isSafeInteger(state?.pki?.lastUpdateMs) ||
    !Number.isSafeInteger(state?.pki?.nextUpdateMs) ||
    state.pki.nextUpdateMs <= state.pki.lastUpdateMs
  ) {
    add('QL3_WORKER_MANAGEMENT_PKI_STATE_CRL');
  }
  if (!validKubernetesEvidence(state?.kubernetes)) {
    add('QL3_WORKER_MANAGEMENT_PKI_STATE_KUBERNETES');
  }
  if (
    !exactKeys(state?.access, [
      'oldCertificateStatus',
      'newCertificateStatus',
    ]) ||
    state?.access?.oldCertificateStatus !== 200 ||
    state?.access?.newCertificateStatus !== 200
  ) {
    add('QL3_WORKER_MANAGEMENT_PKI_STATE_ACCESS');
  }
  if (
    !exactKeys(state?.gates, [
      'externalIdentity',
      'sameEndpointAndServerTrust',
      'serverTrustSeparatedFromClientIssuer',
      'sameClientIssuer',
      'distinctClientCertificates',
      'bothCertificatesInitiallyAccepted',
      'crlBoundDeploymentReady',
      'readOnlyCollectorAuthority',
      'passed',
    ]) ||
    Object.values(state?.gates ?? {}).some((entry) => entry !== true)
  ) {
    add('QL3_WORKER_MANAGEMENT_PKI_STATE_GATES');
  }
  if (containsSensitiveMaterial(state)) {
    add('QL3_WORKER_MANAGEMENT_PKI_STATE_SECRET_EXPOSURE');
  }
  return Object.freeze({
    compatible: findings.length === 0,
    findings: Object.freeze(findings),
  });
}

function validateWorkerCredentialManagementPkiRotationEvidence(report) {
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
      'pki',
      'kubernetes',
      'gates',
    ]) ||
    report?.schemaVersion !== 2 ||
    report?.fixture !== FIXTURE ||
    !isIsoTime(report?.observedAt)
  ) {
    add('QL3_WORKER_MANAGEMENT_PKI_EVIDENCE_SHAPE');
  }
  if (
    !exactKeys(report?.source, [
      'beforeStateSha256',
      'ceremonyReportSha256',
      'durableAuditReportSha256',
      'ceremonyFixture',
      'durableAuditFixture',
    ]) ||
    ![
      report?.source?.beforeStateSha256,
      report?.source?.ceremonyReportSha256,
      report?.source?.durableAuditReportSha256,
    ].every((entry) => SHA256_PATTERN.test(entry)) ||
    report?.source?.ceremonyFixture !== CEREMONY_FIXTURE ||
    report?.source?.durableAuditFixture !== DURABLE_FIXTURE
  ) {
    add('QL3_WORKER_MANAGEMENT_PKI_EVIDENCE_SOURCE');
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
    add('QL3_WORKER_MANAGEMENT_PKI_EVIDENCE_IDENTITY');
  }
  const transport = report?.transport;
  if (
    !exactKeys(transport, [
      'endpointSha256',
      'servernameSha256',
      'serverTrustBundleSha256',
      'serverAuthoritySha256',
      'commandSha256',
      'oldClientCertificateSha256',
      'newClientCertificateSha256',
      'beforeOldStatus',
      'beforeNewStatus',
      'afterOldStatus',
      'afterOldCode',
      'afterNewStatus',
    ]) ||
    ![
      transport?.endpointSha256,
      transport?.servernameSha256,
      transport?.serverTrustBundleSha256,
      transport?.commandSha256,
      transport?.oldClientCertificateSha256,
      transport?.newClientCertificateSha256,
    ].every((entry) => SHA256_PATTERN.test(entry)) ||
    !Array.isArray(transport?.serverAuthoritySha256) ||
    transport.serverAuthoritySha256.length < 1 ||
    transport.serverAuthoritySha256.length > 16 ||
    transport.serverAuthoritySha256.some(
      (entry) => !SHA256_PATTERN.test(entry),
    ) ||
    new Set(transport.serverAuthoritySha256).size !==
      transport.serverAuthoritySha256.length ||
    JSON.stringify(transport.serverAuthoritySha256) !==
      JSON.stringify([...transport.serverAuthoritySha256].sort()) ||
    transport?.oldClientCertificateSha256 ===
      transport?.newClientCertificateSha256 ||
    transport?.beforeOldStatus !== 200 ||
    transport?.beforeNewStatus !== 200 ||
    transport?.afterOldStatus !== 401 ||
    transport?.afterOldCode !== 'client_certificate_required' ||
    transport?.afterNewStatus !== 200
  ) {
    add('QL3_WORKER_MANAGEMENT_PKI_EVIDENCE_TRANSPORT');
  }
  const pki = report?.pki;
  if (
    !exactKeys(pki, [
      'clientIssuerBundleSha256',
      'clientIssuerCaSha256',
      'clientIssuerSubjectSha256',
      'beforeCrlSha256',
      'afterCrlSha256',
      'crlIssuerSha256',
      'beforeCrlNumber',
      'afterCrlNumber',
      'crlNumberIncreased',
      'oldCertificateRevoked',
      'replacementCertificateAccepted',
    ]) ||
    !SHA256_PATTERN.test(pki?.clientIssuerBundleSha256) ||
    !SHA256_PATTERN.test(pki?.clientIssuerCaSha256) ||
    !SHA256_PATTERN.test(pki?.clientIssuerSubjectSha256) ||
    !SHA256_PATTERN.test(pki?.beforeCrlSha256) ||
    !SHA256_PATTERN.test(pki?.afterCrlSha256) ||
    pki?.beforeCrlSha256 === pki?.afterCrlSha256 ||
    !SHA256_PATTERN.test(pki?.crlIssuerSha256) ||
    pki?.clientIssuerSubjectSha256 !== pki?.crlIssuerSha256 ||
    !HEX_PATTERN.test(pki?.beforeCrlNumber) ||
    !HEX_PATTERN.test(pki?.afterCrlNumber) ||
    BigInt(`0x${pki?.afterCrlNumber ?? '0'}`) <=
      BigInt(`0x${pki?.beforeCrlNumber ?? '0'}`) ||
    pki?.crlNumberIncreased !== true ||
    pki?.oldCertificateRevoked !== true ||
    pki?.replacementCertificateAccepted !== true
  ) {
    add('QL3_WORKER_MANAGEMENT_PKI_EVIDENCE_CRL');
  }
  const kubernetes = report?.kubernetes;
  if (
    !exactKeys(kubernetes, [
      'clusterServerSha256',
      'collectorSubjectSha256',
      'deploymentUidSha256',
      'beforeDeploymentResourceVersionSha256',
      'afterDeploymentResourceVersionSha256',
      'beforeGeneration',
      'afterGeneration',
      'beforeCrlAnnotationSha256',
      'afterCrlAnnotationSha256',
      'beforePodUidSha256',
      'afterPodUidSha256',
      'oldPodsFullyReplaced',
      'twoReadyReplicasOnDistinctNodes',
      'exactReadOnlyCollectorAuthority',
      'secretReadDenied',
      'mutationDenied',
    ]) ||
    ![
      kubernetes?.clusterServerSha256,
      kubernetes?.collectorSubjectSha256,
      kubernetes?.deploymentUidSha256,
      kubernetes?.beforeDeploymentResourceVersionSha256,
      kubernetes?.afterDeploymentResourceVersionSha256,
      kubernetes?.beforeCrlAnnotationSha256,
      kubernetes?.afterCrlAnnotationSha256,
    ].every((entry) => SHA256_PATTERN.test(entry)) ||
    !Number.isSafeInteger(kubernetes?.beforeGeneration) ||
    !Number.isSafeInteger(kubernetes?.afterGeneration) ||
    kubernetes.afterGeneration <= kubernetes.beforeGeneration ||
    kubernetes.beforeDeploymentResourceVersionSha256 ===
      kubernetes.afterDeploymentResourceVersionSha256 ||
    kubernetes.beforeCrlAnnotationSha256 ===
      kubernetes.afterCrlAnnotationSha256 ||
    !Array.isArray(kubernetes.beforePodUidSha256) ||
    kubernetes.beforePodUidSha256.length !== 2 ||
    !Array.isArray(kubernetes.afterPodUidSha256) ||
    kubernetes.afterPodUidSha256.length !== 2 ||
    [...kubernetes.beforePodUidSha256, ...kubernetes.afterPodUidSha256].some(
      (entry) => !SHA256_PATTERN.test(entry),
    ) ||
    kubernetes.beforePodUidSha256.some((entry) =>
      kubernetes.afterPodUidSha256.includes(entry),
    ) ||
    kubernetes.oldPodsFullyReplaced !== true ||
    kubernetes.twoReadyReplicasOnDistinctNodes !== true ||
    kubernetes.exactReadOnlyCollectorAuthority !== true ||
    kubernetes.secretReadDenied !== true ||
    kubernetes.mutationDenied !== true
  ) {
    add('QL3_WORKER_MANAGEMENT_PKI_EVIDENCE_KUBERNETES');
  }
  if (
    !exactKeys(report?.gates, [
      'sourceReportsBound',
      'externalIdentityBound',
      'serverTrustSeparatedFromClientIssuer',
      'sameClientIssuer',
      'oldAndReplacementInitiallyAccepted',
      'crlMonotonic',
      'deploymentRolled',
      'oldPodsRetired',
      'revokedCertificateRejected',
      'replacementCertificateAccepted',
      'readOnlyCollectorAuthority',
      'passed',
    ]) ||
    Object.values(report?.gates ?? {}).some((entry) => entry !== true)
  ) {
    add('QL3_WORKER_MANAGEMENT_PKI_EVIDENCE_GATES');
  }
  if (containsSensitiveMaterial(report)) {
    add('QL3_WORKER_MANAGEMENT_PKI_EVIDENCE_SECRET_EXPOSURE');
  }
  return Object.freeze({
    compatible: findings.length === 0,
    findings: Object.freeze(findings),
  });
}

function exactInspectCommand(value, normalize) {
  const command = normalize(value);
  if (command?.operation !== 'worker-credential.inspect') {
    fail('evidence command must be worker-credential.inspect');
  }
  return command;
}

function sameTransport(oldProfile, newProfile) {
  if (
    oldProfile.endpointSha256 !== newProfile.endpointSha256 ||
    oldProfile.servernameSha256 !== newProfile.servernameSha256 ||
    oldProfile.serverTrustBundleSha256 !==
      newProfile.serverTrustBundleSha256 ||
    JSON.stringify(oldProfile.serverAuthoritySha256) !==
      JSON.stringify(newProfile.serverAuthoritySha256) ||
    oldProfile.clientCertificateSha256 === newProfile.clientCertificateSha256
  ) {
    fail(
      'client certificates must be distinct on one endpoint and server trust',
    );
  }
}

function bindClientIssuer(oldProfile, newProfile, issuer, crl) {
  const issued = [oldProfile, newProfile].every(
    (profile) =>
      profile.certificate.checkIssued(issuer.certificate) &&
      profile.certificate.verify(issuer.certificate.publicKey),
  );
  if (!issued || crl.issuerSha256 !== issuer.subjectSha256) {
    fail('client certificates and CRL are not bound to one explicit issuer CA');
  }
}

async function invokeClient(execute, paths, expected) {
  try {
    await execute(paths);
    if (expected !== 200) fail('revoked client certificate was accepted');
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
    if (error instanceof WorkerCredentialManagementPkiRotationEvidenceError) {
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
    inspectIssuer: inspectClientIssuerAuthority,
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
      'inspectIssuer',
      'inspectAuthoritySubject',
      'inspectCrl',
      'collectKubernetes',
    ],
    'evidence dependencies',
  );
  if (
    Object.values(dependencies).some((entry) => typeof entry !== 'function')
  ) {
    fail('evidence dependencies are invalid');
  }
  return Object.freeze(dependencies);
}

function clientPaths(options, configFile) {
  return Object.freeze({
    configFile,
    commandFile: options.commandFile,
    assertionFile: options.assertionFile,
  });
}

function identityFromFile(filePath, nowMs) {
  const bytes = readBuffer(filePath, 'identity assertion');
  try {
    const assertion = bytes.toString('ascii');
    if (bytes.some((byte) => byte > 0x7f)) {
      fail('identity assertion encoding is invalid');
    }
    return assertionIdentity(assertion, nowMs);
  } finally {
    bytes.fill(0);
  }
}

function crlFromFile(filePath, inspectCrl, nowMs) {
  const bytes = readBuffer(filePath, 'client certificate revocation list', {
    private: false,
    maximum: 256 * 1024,
  });
  try {
    const inspected = inspectCrl(bytes);
    exactObject(
      inspected,
      ['sha256', 'issuerSha256', 'number', 'lastUpdateMs', 'nextUpdateMs'],
      'CRL inspection',
    );
    if (
      !SHA256_PATTERN.test(inspected.sha256) ||
      !SHA256_PATTERN.test(inspected.issuerSha256) ||
      !HEX_PATTERN.test(inspected.number) ||
      !Number.isSafeInteger(inspected.lastUpdateMs) ||
      !Number.isSafeInteger(inspected.nextUpdateMs) ||
      inspected.lastUpdateMs > nowMs + 5 * 60_000 ||
      inspected.nextUpdateMs <= nowMs ||
      inspected.nextUpdateMs <= inspected.lastUpdateMs
    ) {
      fail('CRL inspection is not current and canonical');
    }
    return Object.freeze({ ...inspected });
  } finally {
    bytes.fill(0);
  }
}

function commandFromFile(filePath, normalize) {
  const document = readJson(filePath, 'management inspect command');
  try {
    const command = exactInspectCommand(document.value, normalize);
    return Object.freeze({
      command,
      sha256: digest(
        'qinglong3.worker-management.pki-evidence-command.v1',
        JSON.stringify(command),
      ),
    });
  } finally {
    document.bytes.fill(0);
  }
}

async function runBeforeEvidence(options, dependencies = {}) {
  exactObject(
    options,
    [
      'oldConfigFile',
      'newConfigFile',
      'assertionFile',
      'commandFile',
      'kubernetesFile',
      'issuerCaFile',
      'crlFile',
      'outputFile',
    ],
    'before evidence options',
  );
  unusedOutput(options.outputFile);
  const runtime = reviewedDependencies(dependencies);
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
  sameTransport(oldProfile, newProfile);
  const issuer = runtime.inspectIssuer(
    options.issuerCaFile,
    nowMs,
    runtime.inspectAuthoritySubject,
  );
  const crl = crlFromFile(options.crlFile, runtime.inspectCrl, nowMs);
  bindClientIssuer(oldProfile, newProfile, issuer, crl);
  const kubernetes = normalizeKubernetesSnapshot(
    await runtime.collectKubernetes(options.kubernetesFile, crl.sha256),
    crl.sha256,
  );
  const oldAccess = await invokeClient(
    runtime.execute,
    clientPaths(options, options.oldConfigFile),
    200,
  );
  const newAccess = await invokeClient(
    runtime.execute,
    clientPaths(options, options.newConfigFile),
    200,
  );
  const state = Object.freeze({
    schemaVersion: 2,
    fixture: STATE_FIXTURE,
    observedAt: new Date(nowMs).toISOString(),
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
    pki: Object.freeze({
      clientIssuerBundleSha256: issuer.bundleSha256,
      clientIssuerCaSha256: issuer.certificateSha256,
      clientIssuerSubjectSha256: issuer.subjectSha256,
      crlSha256: crl.sha256,
      crlIssuerSha256: crl.issuerSha256,
      crlNumber: crl.number,
      lastUpdateMs: crl.lastUpdateMs,
      nextUpdateMs: crl.nextUpdateMs,
    }),
    kubernetes,
    access: Object.freeze({
      oldCertificateStatus: oldAccess.statusCode,
      newCertificateStatus: newAccess.statusCode,
    }),
    gates: Object.freeze({
      externalIdentity: true,
      sameEndpointAndServerTrust: true,
      serverTrustSeparatedFromClientIssuer: true,
      sameClientIssuer: true,
      distinctClientCertificates: true,
      bothCertificatesInitiallyAccepted: true,
      crlBoundDeploymentReady: true,
      readOnlyCollectorAuthority: true,
      passed: true,
    }),
  });
  const audit = validateBeforeState(state);
  if (!audit.compatible) {
    fail(
      `before state failed audit: ${audit.findings
        .map(({ code }) => code)
        .join(',')}`,
    );
  }
  writeNoReplace(options.outputFile, state);
  return state;
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

function assertSameBeforeSource(
  before,
  identity,
  command,
  oldProfile,
  newProfile,
  issuer,
) {
  const subjectSha256 = digest(
    'qinglong3.worker-management.subject.v1',
    identity.subject,
  );
  if (
    before.identity.issuer !== identity.issuer ||
    before.identity.subjectSha256 !== subjectSha256 ||
    before.transport.endpointSha256 !== oldProfile.endpointSha256 ||
    before.transport.servernameSha256 !== oldProfile.servernameSha256 ||
    before.transport.serverTrustBundleSha256 !==
      oldProfile.serverTrustBundleSha256 ||
    JSON.stringify(before.transport.serverAuthoritySha256) !==
      JSON.stringify(oldProfile.serverAuthoritySha256) ||
    before.transport.commandSha256 !== command.sha256 ||
    before.transport.oldClientCertificateSha256 !==
      oldProfile.clientCertificateSha256 ||
    before.transport.newClientCertificateSha256 !==
      newProfile.clientCertificateSha256 ||
    before.pki.clientIssuerBundleSha256 !== issuer.bundleSha256 ||
    before.pki.clientIssuerCaSha256 !== issuer.certificateSha256 ||
    before.pki.clientIssuerSubjectSha256 !== issuer.subjectSha256
  ) {
    fail('after phase authority does not match the before state');
  }
  return subjectSha256;
}

async function runAfterEvidence(options, dependencies = {}) {
  exactObject(
    options,
    [
      'beforeFile',
      'oldConfigFile',
      'newConfigFile',
      'assertionFile',
      'commandFile',
      'kubernetesFile',
      'issuerCaFile',
      'crlFile',
      'ceremonyReportFile',
      'durableAuditReportFile',
      'outputFile',
    ],
    'after evidence options',
  );
  unusedOutput(options.outputFile);
  const runtime = reviewedDependencies(dependencies);
  const nowMs = runtime.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('clock is invalid');
  const beforeDocument = readJson(options.beforeFile, 'before state');
  const ceremonyDocument = readJson(
    options.ceremonyReportFile,
    'ceremony report',
  );
  const durableDocument = readJson(
    options.durableAuditReportFile,
    'durable audit report',
  );
  try {
    const beforeAudit = validateBeforeState(beforeDocument.value);
    if (!beforeAudit.compatible) fail('before state is incompatible');
    assertSourceReports(ceremonyDocument, durableDocument);
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
    sameTransport(oldProfile, newProfile);
    const issuer = runtime.inspectIssuer(
      options.issuerCaFile,
      nowMs,
      runtime.inspectAuthoritySubject,
    );
    const subjectSha256 = assertSameBeforeSource(
      beforeDocument.value,
      identity,
      command,
      oldProfile,
      newProfile,
      issuer,
    );
    const ceremonySubjects = [
      ceremonyDocument.value.identity.requesterSubjectSha256,
      ceremonyDocument.value.identity.reviewerSubjectSha256,
    ];
    if (
      identity.issuer !== ceremonyDocument.value.identity.issuer ||
      !ceremonySubjects.includes(subjectSha256) ||
      ![
        durableDocument.value.durableState.requesterSubjectSha256,
        durableDocument.value.durableState.reviewerSubjectSha256,
      ].includes(subjectSha256)
    ) {
      fail('after phase identity is not bound to the reviewed ceremony');
    }
    const crl = crlFromFile(options.crlFile, runtime.inspectCrl, nowMs);
    bindClientIssuer(oldProfile, newProfile, issuer, crl);
    const beforeCrl = beforeDocument.value.pki;
    if (
      crl.sha256 === beforeCrl.crlSha256 ||
      crl.issuerSha256 !== beforeCrl.crlIssuerSha256 ||
      BigInt(`0x${crl.number}`) <= BigInt(`0x${beforeCrl.crlNumber}`) ||
      crl.lastUpdateMs <= beforeCrl.lastUpdateMs
    ) {
      fail('CRL did not advance monotonically');
    }
    const kubernetes = normalizeKubernetesSnapshot(
      await runtime.collectKubernetes(options.kubernetesFile, crl.sha256),
      crl.sha256,
    );
    const beforeKubernetes = beforeDocument.value.kubernetes;
    if (
      kubernetes.clusterServerSha256 !== beforeKubernetes.clusterServerSha256 ||
      kubernetes.collectorSubjectSha256 !==
        beforeKubernetes.collectorSubjectSha256 ||
      kubernetes.deploymentUidSha256 !== beforeKubernetes.deploymentUidSha256 ||
      kubernetes.deploymentGeneration <=
        beforeKubernetes.deploymentGeneration ||
      kubernetes.deploymentResourceVersionSha256 ===
        beforeKubernetes.deploymentResourceVersionSha256 ||
      beforeKubernetes.podUidSha256.some((entry) =>
        kubernetes.podUidSha256.includes(entry),
      )
    ) {
      fail('Kubernetes rollout did not replace the complete old generation');
    }
    const oldAccess = await invokeClient(
      runtime.execute,
      clientPaths(options, options.oldConfigFile),
      401,
    );
    const newAccess = await invokeClient(
      runtime.execute,
      clientPaths(options, options.newConfigFile),
      200,
    );
    const report = Object.freeze({
      schemaVersion: 2,
      fixture: FIXTURE,
      observedAt: new Date(nowMs).toISOString(),
      source: Object.freeze({
        beforeStateSha256: rawDigest(beforeDocument.bytes),
        ceremonyReportSha256: rawDigest(ceremonyDocument.bytes),
        durableAuditReportSha256: rawDigest(durableDocument.bytes),
        ceremonyFixture: CEREMONY_FIXTURE,
        durableAuditFixture: DURABLE_FIXTURE,
      }),
      identity: Object.freeze({
        providerKind: 'external_oidc',
        issuer: identity.issuer,
        audience: AUDIENCE,
        type: TYPE,
        purpose: PURPOSE,
        subjectSha256,
        ceremonyIdentityBound: true,
        durableAuditBound: true,
      }),
      transport: Object.freeze({
        endpointSha256: oldProfile.endpointSha256,
        servernameSha256: oldProfile.servernameSha256,
        serverTrustBundleSha256: oldProfile.serverTrustBundleSha256,
        serverAuthoritySha256: oldProfile.serverAuthoritySha256,
        commandSha256: command.sha256,
        oldClientCertificateSha256: oldProfile.clientCertificateSha256,
        newClientCertificateSha256: newProfile.clientCertificateSha256,
        beforeOldStatus: beforeDocument.value.access.oldCertificateStatus,
        beforeNewStatus: beforeDocument.value.access.newCertificateStatus,
        afterOldStatus: oldAccess.statusCode,
        afterOldCode: oldAccess.responseCode,
        afterNewStatus: newAccess.statusCode,
      }),
      pki: Object.freeze({
        clientIssuerBundleSha256: issuer.bundleSha256,
        clientIssuerCaSha256: issuer.certificateSha256,
        clientIssuerSubjectSha256: issuer.subjectSha256,
        beforeCrlSha256: beforeCrl.crlSha256,
        afterCrlSha256: crl.sha256,
        crlIssuerSha256: crl.issuerSha256,
        beforeCrlNumber: beforeCrl.crlNumber,
        afterCrlNumber: crl.number,
        crlNumberIncreased: true,
        oldCertificateRevoked: true,
        replacementCertificateAccepted: true,
      }),
      kubernetes: Object.freeze({
        clusterServerSha256: kubernetes.clusterServerSha256,
        collectorSubjectSha256: kubernetes.collectorSubjectSha256,
        deploymentUidSha256: kubernetes.deploymentUidSha256,
        beforeDeploymentResourceVersionSha256:
          beforeKubernetes.deploymentResourceVersionSha256,
        afterDeploymentResourceVersionSha256:
          kubernetes.deploymentResourceVersionSha256,
        beforeGeneration: beforeKubernetes.deploymentGeneration,
        afterGeneration: kubernetes.deploymentGeneration,
        beforeCrlAnnotationSha256: beforeKubernetes.crlAnnotationSha256,
        afterCrlAnnotationSha256: kubernetes.crlAnnotationSha256,
        beforePodUidSha256: beforeKubernetes.podUidSha256,
        afterPodUidSha256: kubernetes.podUidSha256,
        oldPodsFullyReplaced: true,
        twoReadyReplicasOnDistinctNodes: true,
        exactReadOnlyCollectorAuthority: true,
        secretReadDenied: true,
        mutationDenied: true,
      }),
      gates: Object.freeze({
        sourceReportsBound: true,
        externalIdentityBound: true,
        serverTrustSeparatedFromClientIssuer: true,
        sameClientIssuer: true,
        oldAndReplacementInitiallyAccepted: true,
        crlMonotonic: true,
        deploymentRolled: true,
        oldPodsRetired: true,
        revokedCertificateRejected: true,
        replacementCertificateAccepted: true,
        readOnlyCollectorAuthority: true,
        passed: true,
      }),
    });
    const audit = validateWorkerCredentialManagementPkiRotationEvidence(report);
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
    beforeDocument.bytes.fill(0);
    ceremonyDocument.bytes.fill(0);
    durableDocument.bytes.fill(0);
  }
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (argument === '--') continue;
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1]))
      fail('arguments are invalid');
    values[match[1]] = match[2];
  }
  if (!['before', 'after'].includes(values.phase)) {
    fail('phase must be before or after');
  }
  const common = [
    'phase',
    'old-config',
    'new-config',
    'assertion',
    'command',
    'kubernetes',
    'client-issuer-ca',
    'crl',
    'output',
  ];
  const expected =
    values.phase === 'before'
      ? common
      : [...common, 'before', 'ceremony-report', 'durable-audit-report'];
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
    issuerCaFile: values['client-issuer-ca'],
    crlFile: values.crl,
    outputFile: values.output,
  };
  return Object.freeze(
    values.phase === 'before'
      ? { phase: 'before', options: Object.freeze(shared) }
      : {
          phase: 'after',
          options: Object.freeze({
            beforeFile: values.before,
            ...shared,
            ceremonyReportFile: values['ceremony-report'],
            durableAuditReportFile: values['durable-audit-report'],
          }),
        },
  );
}

async function runCli(argv) {
  if (
    process.env.QL3_WORKER_CREDENTIAL_MANAGEMENT_PKI_ROTATION_EVIDENCE !== '1'
  ) {
    fail('explicit PKI rotation evidence opt-in is required');
  }
  const parsed = parseArguments(argv);
  if (parsed.phase === 'before') await runBeforeEvidence(parsed.options);
  else await runAfterEvidence(parsed.options);
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 2,
      fixture: FIXTURE,
      phase: parsed.phase,
      compatible: true,
    })}\n`,
  );
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'Worker credential management PKI rotation evidence failed'
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  CRL_ANNOTATION,
  FIXTURE,
  REVIEWED_AUTHORITY,
  STATE_FIXTURE,
  WorkerCredentialManagementPkiRotationEvidenceError,
  collectKubernetesSnapshot,
  defaultInspectAuthoritySubject,
  defaultInspectCrl,
  inspectClientConfiguration,
  inspectClientIssuerAuthority,
  normalizeKubernetesSnapshot,
  parseCrlInspectionOutput,
  parseArguments,
  runAfterEvidence,
  runBeforeEvidence,
  validateBeforeState,
  validateWorkerCredentialManagementPkiRotationEvidence,
};
