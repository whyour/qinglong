#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { createServer } = require('node:net');
const { request: httpRequest } = require('node:http');

const ARCHITECTURES = Object.freeze(['x64', 'arm64']);
const IMAGE_ARCHITECTURES = Object.freeze({ x64: 'amd64', arm64: 'arm64' });
const NODE_VERSION = 'v24.18.0';
const MEMORY_MAX_BYTES = 192 * 1024 * 1024;
const MINIMUM_MEMORY_HEADROOM_BYTES = 32 * 1024 * 1024;
const SWAP_MAX_BYTES = 0;
const CPU_QUOTA_MICROS = 25_000;
const CPU_PERIOD_MICROS = 100_000;
const PIDS_MAX = 32;
const TMPFS_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_CANONICAL_DEPTH = 24;
const MAX_CANONICAL_NODES = 20_000;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,31}$/u;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SERVICE_NAME = 'ql3-plugin-package-management.qinglong3-system.svc';
const MANAGEMENT_PORT = 8443;
const LIMITATIONS = Object.freeze([
  'The 192 MiB workstation Console envelope is not Cluster throughput or capacity planning',
  'Native CI evidence is not a physical Edge minimum, power-loss, flash, thermal, or soak claim',
  'The management service is a bounded synthetic mTLS verifier, not an external IdP attestation',
  'GitHub workflow source binding is not a cryptographic hardware attestation',
]);
const ASSERTION_SEQUENCE = Object.freeze([
  'initial_accepted',
  'rotated_accepted',
  'expired_rejected',
  'rotated_recovered',
]);

class QingLong3ClusterCopilotConsoleCapacityEvidenceError extends Error {
  constructor(message) {
    super(
      `QingLong 3.0 Cluster Copilot Console capacity evidence failed: ${message}`,
    );
    this.name = 'QingLong3ClusterCopilotConsoleCapacityEvidenceError';
  }
}

function fail(message) {
  throw new QingLong3ClusterCopilotConsoleCapacityEvidenceError(message);
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be a plain object`);
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(assertRecord(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields are invalid`);
  }
}

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function boundedString(value, label, maximum = 128) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function canonicalize(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_NODES) fail('evidence node budget exceeded');
  if (depth > MAX_CANONICAL_DEPTH) fail('evidence depth budget exceeded');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('evidence contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry, depth + 1, budget));
  }
  if (!isRecord(value)) fail('evidence contains an unsupported value');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key.length < 1 || key.length > 128) fail('evidence key is invalid');
    result[key] = canonicalize(value[key], depth + 1, budget);
  }
  return result;
}

function evidenceDigest(value) {
  return createHash('sha256')
    .update('qinglong/cluster-console-capacity-evidence\0')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function normalizeSource(source) {
  assertExactKeys(
    source,
    ['repository', 'revision', 'workflow', 'runId', 'runAttempt'],
    'source',
  );
  if (
    typeof source.repository !== 'string' ||
    !REPOSITORY_PATTERN.test(source.repository)
  ) {
    fail('source repository is invalid');
  }
  if (
    typeof source.revision !== 'string' ||
    !REVISION_PATTERN.test(source.revision)
  ) {
    fail('source revision is invalid');
  }
  boundedString(source.workflow, 'source workflow');
  if (typeof source.runId !== 'string' || !RUN_ID_PATTERN.test(source.runId)) {
    fail('source runId is invalid');
  }
  safeInteger(source.runAttempt, 'source runAttempt', 1);
  return Object.freeze({
    repository: source.repository,
    revision: source.revision,
    workflow: source.workflow,
    runId: source.runId,
    runAttempt: source.runAttempt,
  });
}

function validateMemoryEvents(value, label) {
  assertExactKeys(
    value,
    ['low', 'high', 'max', 'oom', 'oomKill', 'oomGroupKill'],
    label,
  );
  return Object.freeze({
    low: safeInteger(value.low, `${label}.low`),
    high: safeInteger(value.high, `${label}.high`),
    max: safeInteger(value.max, `${label}.max`),
    oom: safeInteger(value.oom, `${label}.oom`),
    oomKill: safeInteger(value.oomKill, `${label}.oomKill`),
    oomGroupKill: safeInteger(value.oomGroupKill, `${label}.oomGroupKill`),
  });
}

function validateObservation(value, expectedArchitecture) {
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'observedAtMs',
      'platform',
      'architecture',
      'image',
      'runtime',
      'envelope',
      'assertionLifecycle',
    ],
    'observation',
  );
  if (
    value.schemaVersion !== 1 ||
    value.platform !== 'linux' ||
    value.architecture !== expectedArchitecture ||
    !ARCHITECTURES.includes(value.architecture)
  ) {
    fail('observation native identity is invalid');
  }
  safeInteger(value.observedAtMs, 'observation observedAtMs', 1);

  assertExactKeys(
    value.image,
    ['architecture', 'id', 'bytes', 'user'],
    'observation image',
  );
  if (
    value.image.architecture !== IMAGE_ARCHITECTURES[expectedArchitecture] ||
    typeof value.image.id !== 'string' ||
    !IMAGE_ID_PATTERN.test(value.image.id) ||
    value.image.user !== '10001:10001'
  ) {
    fail('observation image identity is invalid');
  }
  safeInteger(value.image.bytes, 'observation image bytes', 1);

  assertExactKeys(value.runtime, ['node', 'uid', 'gid'], 'observation runtime');
  if (
    value.runtime.node !== NODE_VERSION ||
    value.runtime.uid !== 10001 ||
    value.runtime.gid !== 10001
  ) {
    fail('observation runtime identity is invalid');
  }

  assertExactKeys(
    value.envelope,
    [
      'memoryMaxBytes',
      'memoryPeakBytes',
      'memoryHeadroomBytes',
      'swapMaxBytes',
      'cpuQuotaMicros',
      'cpuPeriodMicros',
      'pidsMax',
      'pidsCurrent',
      'noNewPrivileges',
      'seccompMode',
      'readOnlyRoot',
      'tmpfsBytes',
      'publishedHostAddress',
      'capabilityDrop',
      'memoryEventsBefore',
      'memoryEventsAfter',
    ],
    'observation envelope',
  );
  const memoryPeakBytes = safeInteger(
    value.envelope.memoryPeakBytes,
    'observation memoryPeakBytes',
    1,
  );
  const memoryHeadroomBytes = safeInteger(
    value.envelope.memoryHeadroomBytes,
    'observation memoryHeadroomBytes',
  );
  const pidsCurrent = safeInteger(
    value.envelope.pidsCurrent,
    'observation pidsCurrent',
    1,
  );
  if (
    value.envelope.memoryMaxBytes !== MEMORY_MAX_BYTES ||
    memoryPeakBytes + memoryHeadroomBytes !== MEMORY_MAX_BYTES ||
    memoryHeadroomBytes < MINIMUM_MEMORY_HEADROOM_BYTES ||
    value.envelope.swapMaxBytes !== SWAP_MAX_BYTES ||
    value.envelope.cpuQuotaMicros !== CPU_QUOTA_MICROS ||
    value.envelope.cpuPeriodMicros !== CPU_PERIOD_MICROS ||
    value.envelope.pidsMax !== PIDS_MAX ||
    pidsCurrent > PIDS_MAX ||
    value.envelope.noNewPrivileges !== 1 ||
    value.envelope.seccompMode !== 2 ||
    value.envelope.readOnlyRoot !== true ||
    value.envelope.tmpfsBytes !== TMPFS_BYTES ||
    value.envelope.publishedHostAddress !== '127.0.0.1' ||
    value.envelope.capabilityDrop !== 'ALL'
  ) {
    fail('observation resource envelope drifted');
  }
  const before = validateMemoryEvents(
    value.envelope.memoryEventsBefore,
    'observation memoryEventsBefore',
  );
  const after = validateMemoryEvents(
    value.envelope.memoryEventsAfter,
    'observation memoryEventsAfter',
  );
  for (const key of ['max', 'oom', 'oomKill', 'oomGroupKill']) {
    if (after[key] !== before[key]) fail(`memory event ${key} changed`);
  }

  assertExactKeys(
    value.assertionLifecycle,
    [
      'requestCount',
      'sequence',
      'tlsVersion',
      'mutualTls',
      'consoleRestarted',
      'mutation',
      'operation',
      'expiredConsoleStatus',
      'expiredCode',
    ],
    'observation assertionLifecycle',
  );
  if (
    value.assertionLifecycle.requestCount !== 4 ||
    JSON.stringify(value.assertionLifecycle.sequence) !==
      JSON.stringify(ASSERTION_SEQUENCE) ||
    value.assertionLifecycle.tlsVersion !== 'TLSv1.3' ||
    value.assertionLifecycle.mutualTls !== true ||
    value.assertionLifecycle.consoleRestarted !== false ||
    value.assertionLifecycle.mutation !== false ||
    value.assertionLifecycle.operation !== 'run.cancellation.summary' ||
    value.assertionLifecycle.expiredConsoleStatus !== 502 ||
    value.assertionLifecycle.expiredCode !== 'assertion_expired'
  ) {
    fail('observation assertion lifecycle drifted');
  }
  canonicalize(value);
  return value;
}

function architecturePayload(source, architecture, observation) {
  return {
    schemaVersion: 1,
    fixture: 'qinglong/cluster-console-capacity-architecture-evidence@v1',
    source,
    architecture,
    observation,
    gates: {
      nativeLinux: true,
      exactImageIdentity: true,
      compactEnvelope: true,
      memoryHeadroom: true,
      noSwapOrOom: true,
      loopbackOnly: true,
      assertionRotation: true,
      assertionExpiryRejected: true,
      assertionRecoveryWithoutRestart: true,
      mutationAbsent: true,
      sourceBound: true,
      passed: true,
    },
    limitations: LIMITATIONS,
  };
}

function createArchitectureEvidence({ source, architecture, observation }) {
  const normalizedSource = normalizeSource(source);
  if (!ARCHITECTURES.includes(architecture)) fail('architecture is invalid');
  const normalizedObservation = validateObservation(observation, architecture);
  const payload = architecturePayload(
    normalizedSource,
    architecture,
    normalizedObservation,
  );
  return Object.freeze({
    ...payload,
    bundleDigest: evidenceDigest(payload),
  });
}

function validateArchitectureEvidence(value, expectedSource, architecture) {
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'fixture',
      'source',
      'architecture',
      'observation',
      'gates',
      'limitations',
      'bundleDigest',
    ],
    `${architecture} evidence`,
  );
  const rebuilt = createArchitectureEvidence({
    source: value.source,
    architecture: value.architecture,
    observation: value.observation,
  });
  if (
    value.schemaVersion !== rebuilt.schemaVersion ||
    value.fixture !== rebuilt.fixture ||
    value.architecture !== architecture ||
    JSON.stringify(value.gates) !== JSON.stringify(rebuilt.gates) ||
    JSON.stringify(value.limitations) !== JSON.stringify(rebuilt.limitations) ||
    value.bundleDigest !== rebuilt.bundleDigest
  ) {
    fail(`${architecture} evidence digest or gates drifted`);
  }
  if (
    JSON.stringify(rebuilt.source) !==
    JSON.stringify(normalizeSource(expectedSource))
  ) {
    fail(`${architecture} evidence belongs to another source`);
  }
  return rebuilt;
}

function releasePayload(source, x64, arm64) {
  return {
    schemaVersion: 1,
    fixture: 'qinglong/cluster-console-capacity-cross-architecture-evidence@v1',
    source,
    architectures: [x64, arm64].map((entry) => ({
      architecture: entry.architecture,
      imageArchitecture: entry.observation.image.architecture,
      imageId: entry.observation.image.id,
      imageBytes: entry.observation.image.bytes,
      memoryMaxBytes: entry.observation.envelope.memoryMaxBytes,
      memoryPeakBytes: entry.observation.envelope.memoryPeakBytes,
      memoryHeadroomBytes: entry.observation.envelope.memoryHeadroomBytes,
      pidsCurrent: entry.observation.envelope.pidsCurrent,
      bundleDigest: entry.bundleDigest,
    })),
    assertionLifecycle: {
      sequence: ASSERTION_SEQUENCE,
      tlsVersion: 'TLSv1.3',
      mutualTls: true,
      consoleRestarted: false,
      mutation: false,
    },
    gates: {
      nativeX64Passed: true,
      nativeArm64Passed: true,
      sameSourceRevision: true,
      sameWorkflowRun: true,
      independentImages: true,
      compactEnvelopeParity: true,
      assertionLifecycleParity: true,
      releaseEvidenceComplete: true,
      passed: true,
    },
    limitations: LIMITATIONS,
  };
}

function mergeCrossArchitectureEvidence({ source, x64, arm64 }) {
  const normalizedSource = normalizeSource(source);
  const validatedX64 = validateArchitectureEvidence(
    x64,
    normalizedSource,
    'x64',
  );
  const validatedArm64 = validateArchitectureEvidence(
    arm64,
    normalizedSource,
    'arm64',
  );
  if (
    validatedX64.bundleDigest === validatedArm64.bundleDigest ||
    validatedX64.observation.image.id === validatedArm64.observation.image.id
  ) {
    fail('architecture evidence must use independently measured images');
  }
  const payload = releasePayload(
    normalizedSource,
    validatedX64,
    validatedArm64,
  );
  return Object.freeze({
    ...payload,
    releaseDigest: evidenceDigest(payload),
  });
}

function validateReleaseEvidence(value, expectedSource) {
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'fixture',
      'source',
      'architectures',
      'assertionLifecycle',
      'gates',
      'limitations',
      'releaseDigest',
    ],
    'release evidence',
  );
  if (!Array.isArray(value.architectures) || value.architectures.length !== 2) {
    fail('release architecture summaries are invalid');
  }
  const expectedArchitectures = ['x64', 'arm64'];
  for (let index = 0; index < expectedArchitectures.length; index += 1) {
    const entry = value.architectures[index];
    assertExactKeys(
      entry,
      [
        'architecture',
        'imageArchitecture',
        'imageId',
        'imageBytes',
        'memoryMaxBytes',
        'memoryPeakBytes',
        'memoryHeadroomBytes',
        'pidsCurrent',
        'bundleDigest',
      ],
      `release architecture ${index}`,
    );
    if (
      entry.architecture !== expectedArchitectures[index] ||
      entry.imageArchitecture !== IMAGE_ARCHITECTURES[entry.architecture] ||
      typeof entry.imageId !== 'string' ||
      !IMAGE_ID_PATTERN.test(entry.imageId) ||
      typeof entry.bundleDigest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(entry.bundleDigest) ||
      entry.memoryMaxBytes !== MEMORY_MAX_BYTES
    ) {
      fail('release architecture summary drifted');
    }
    safeInteger(entry.imageBytes, 'release imageBytes', 1);
    const peak = safeInteger(
      entry.memoryPeakBytes,
      'release memoryPeakBytes',
      1,
    );
    const headroom = safeInteger(
      entry.memoryHeadroomBytes,
      'release memoryHeadroomBytes',
    );
    if (
      peak + headroom !== MEMORY_MAX_BYTES ||
      headroom < MINIMUM_MEMORY_HEADROOM_BYTES
    ) {
      fail('release memory headroom drifted');
    }
    const pids = safeInteger(entry.pidsCurrent, 'release pidsCurrent', 1);
    if (pids > PIDS_MAX) fail('release pidsCurrent exceeded');
  }
  if (
    value.architectures[0].imageId === value.architectures[1].imageId ||
    value.architectures[0].bundleDigest ===
      value.architectures[1].bundleDigest ||
    JSON.stringify(value.assertionLifecycle) !==
      JSON.stringify({
        sequence: ASSERTION_SEQUENCE,
        tlsVersion: 'TLSv1.3',
        mutualTls: true,
        consoleRestarted: false,
        mutation: false,
      }) ||
    JSON.stringify(value.gates) !==
      JSON.stringify({
        nativeX64Passed: true,
        nativeArm64Passed: true,
        sameSourceRevision: true,
        sameWorkflowRun: true,
        independentImages: true,
        compactEnvelopeParity: true,
        assertionLifecycleParity: true,
        releaseEvidenceComplete: true,
        passed: true,
      }) ||
    JSON.stringify(value.limitations) !== JSON.stringify(LIMITATIONS)
  ) {
    fail('release evidence gates drifted');
  }
  if (
    JSON.stringify(normalizeSource(value.source)) !==
    JSON.stringify(normalizeSource(expectedSource))
  ) {
    fail('release evidence belongs to another source');
  }
  const { releaseDigest, ...payload } = value;
  if (releaseDigest !== evidenceDigest(payload)) {
    fail('release evidence digest drifted');
  }
  canonicalize(value);
  return value;
}

function readJsonFile(filePath, label) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    fail(`${label} path must be absolute`);
  }
  let descriptor = -1;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_EVIDENCE_BYTES) {
      fail(`${label} size is invalid`);
    }
    const bytes = fs.readFileSync(descriptor);
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail(`${label} must contain valid JSON`);
    }
    canonicalize(value);
    return value;
  } catch (error) {
    if (error instanceof QingLong3ClusterCopilotConsoleCapacityEvidenceError) {
      throw error;
    }
    fail(`${label} must be a readable non-symlink file`);
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function writeJsonFile(filePath, value) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    fail('output path must be absolute');
  }
  const parent = path.dirname(filePath);
  let parentStat;
  try {
    parentStat = fs.lstatSync(parent);
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      fs.realpathSync(parent) !== parent
    ) {
      fail('output parent is invalid');
    }
  } catch (error) {
    if (error instanceof QingLong3ClusterCopilotConsoleCapacityEvidenceError) {
      throw error;
    }
    fail('output parent is invalid');
  }
  let descriptor = -1;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch (error) {
    if (error instanceof QingLong3ClusterCopilotConsoleCapacityEvidenceError) {
      throw error;
    }
    fail('output must be a new private file');
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

function cleanupDocker(args) {
  spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

function dockerLogs(container) {
  return docker(['logs', container]);
}

function waitForLog(container, event) {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const logs = dockerLogs(container);
    for (const line of logs.trim().split('\n')) {
      try {
        const fact = JSON.parse(line);
        if (fact?.event === event) return fact;
      } catch {}
    }
    Atomics.wait(waitArray, 0, 0, 25);
  }
  fail(`${container} did not publish ${event}`);
}

function syntheticJwt(subject, expiration, marker) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode({
    sub: subject,
    exp: expiration,
    assurance: 'strong',
  })}.${Buffer.alloc(32, marker).toString('base64url')}`;
}

const VOLUME_SEED_SOURCE = String.raw`
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const [name, contents] of Object.entries(value.files)) {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name) || typeof contents !== 'string') process.exit(91);
  const target = value.root + '/' + name;
  fs.writeFileSync(target, contents, { mode: 0o600, flag: 'wx' });
  fs.chownSync(target, 10001, 10001);
}
`;

const ASSERTION_ROTATE_SOURCE = String.raw`
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(0, 'utf8'));
if (typeof value.assertion !== 'string' || value.assertion.length > 8192) process.exit(92);
const next = '/authority/assertion.next';
fs.writeFileSync(next, value.assertion, { mode: 0o600, flag: 'wx' });
fs.chownSync(next, 10001, 10001);
fs.renameSync(next, '/authority/assertion.jwt');
`;

const MANAGEMENT_SERVER_SOURCE = String.raw`
const fs = require('node:fs');
const https = require('node:https');
const assertions = JSON.parse(fs.readFileSync('/server/assertions.json', 'utf8'));
const server = https.createServer({
  key: fs.readFileSync('/server/server-key.pem'),
  cert: fs.readFileSync('/server/server-cert.pem'),
  ca: fs.readFileSync('/server/client-ca.pem'),
  requestCert: true,
  rejectUnauthorized: true,
  minVersion: 'TLSv1.3',
  maxVersion: 'TLSv1.3',
}, (request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.once('end', () => {
    let command;
    try { command = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { process.exit(93); }
    const authorization = request.headers.authorization;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const label = token === assertions.initial ? 'initial' : token === assertions.rotated ? 'rotated' : token === assertions.expired ? 'expired' : 'unknown';
    const observation = {
      event: 'management_request',
      label,
      tlsVersion: request.socket.getProtocol(),
      mutualTls: request.client.authorized === true,
      method: request.method,
      path: request.url,
      operation: command?.operation ?? null,
      mutation: command?.operation !== 'run.cancellation.summary',
    };
    process.stdout.write(JSON.stringify(observation) + '\n');
    const requestId = command?.request?.requestId ?? 'invalid-request';
    if (label === 'expired' || label === 'unknown') {
      const body = Buffer.from(JSON.stringify({ schemaVersion: 1, requestId, error: { code: label === 'expired' ? 'assertion_expired' : 'assertion_invalid' } }));
      response.writeHead(label === 'expired' ? 401 : 403, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
      response.end(body);
      return;
    }
    const blocked = label === 'rotated';
    const summary = {
      schema: 'qinglong/run-cancellation-dispatch-summary@v1',
      projectId: command.request.projectId,
      observedAtMs: 1700000000000,
      assessment: blocked ? 'attention_required' : 'clear',
      operatorAction: blocked ? 'inspect' : 'none',
      dispatches: { total: blocked ? 1 : 0, pending: 0, leased: 0, retryWait: 0, dispatched: 0, blocked: blocked ? 1 : 0 },
      signals: { due: 0, expiredLease: 0 },
      blockingResults: { identityMismatch: blocked ? 1 : 0, pidMismatch: 0, unsupported: 0, invalid: 0 },
      ...(blocked ? { oldestBlockedAtMs: 1699999999000 } : {}),
    };
    const body = Buffer.from(JSON.stringify({ schemaVersion: 1, requestId, result: { schemaVersion: 1, operation: 'run.cancellation.summary', summary } }));
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
    response.end(body);
  });
});
server.listen(8443, '0.0.0.0', () => process.stdout.write(JSON.stringify({ event: 'management_ready' }) + '\n'));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
`;

const CGROUP_SNAPSHOT_SOURCE = String.raw`
const fs = require('node:fs');
function text(name) { return fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim(); }
function integer(name) { const value = text(name); if (!/^(?:0|[1-9][0-9]*)$/.test(value)) process.exit(94); return Number(value); }
const events = Object.fromEntries(text('memory.events').split('\n').map((line) => { const [key, value] = line.split(' '); return [key, Number(value)]; }));
const [cpuQuota, cpuPeriod] = text('cpu.max').split(' ').map(Number);
const status = fs.readFileSync('/proc/self/status', 'utf8');
const field = (name) => Number(new RegExp('^' + name + ':\\s+([0-9]+)$', 'm').exec(status)?.[1]);
process.stdout.write(JSON.stringify({
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  uid: process.getuid(),
  gid: process.getgid(),
  memoryMaxBytes: integer('memory.max'),
  memoryPeakBytes: integer('memory.peak'),
  swapMaxBytes: integer('memory.swap.max'),
  cpuQuotaMicros: cpuQuota,
  cpuPeriodMicros: cpuPeriod,
  pidsMax: integer('pids.max'),
  pidsCurrent: integer('pids.current'),
  noNewPrivileges: field('NoNewPrivs'),
  seccompMode: field('Seccomp'),
  memoryEvents: { low: events.low, high: events.high, max: events.max, oom: events.oom, oomKill: events.oom_kill, oomGroupKill: events.oom_group_kill },
}));
`;

function seedVolume(image, volume, root, files) {
  docker(
    [
      'run',
      '--rm',
      '--interactive',
      '--read-only',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'CHOWN',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '0:0',
      '--volume',
      `${volume}:${root}`,
      '--entrypoint',
      'node',
      image,
      '-e',
      VOLUME_SEED_SOURCE,
    ],
    { input: JSON.stringify({ root, files }) },
  );
}

function rotateAssertion(image, volume, assertion) {
  docker(
    [
      'run',
      '--rm',
      '--interactive',
      '--read-only',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'CHOWN',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '0:0',
      '--volume',
      `${volume}:/authority`,
      '--entrypoint',
      'node',
      image,
      '-e',
      ASSERTION_ROTATE_SOURCE,
    ],
    { input: JSON.stringify({ assertion }) },
  );
}

function parseCgroupSnapshot(container) {
  let value;
  try {
    value = JSON.parse(
      docker([
        'exec',
        '--user',
        '10001:10001',
        container,
        'node',
        '-e',
        CGROUP_SNAPSHOT_SOURCE,
      ]),
    );
  } catch {
    fail('Console cgroup v2 snapshot is unavailable');
  }
  return value;
}

function unusedLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('invalid address'));
        return;
      }
      const port = address.port;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function postConsole(origin, session, requestId) {
  const target = new URL(origin);
  const body = Buffer.from(
    JSON.stringify({
      schema: 'qinglong/cluster-copilot-console-read-request@v1',
      operation: 'run_cancellation_status',
      projectId: 'capacity-project',
      requestId,
    }),
    'utf8',
  );
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: Number(target.port),
        method: 'POST',
        path: '/api/v1/run-management/cancellation-status',
        agent: false,
        headers: {
          authorization: `QL3-Console ${session}`,
          origin,
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.length),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () => {
          try {
            resolve({
              statusCode: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

function parseJsonLines(text) {
  const values = [];
  for (const line of text.trim().split('\n')) {
    if (!line) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      fail('container emitted a non-JSON diagnostic');
    }
  }
  return values;
}

async function captureLiveObservation(image, architecture) {
  if (process.platform !== 'linux' || process.arch !== architecture) {
    fail('capture requires the exact native Linux architecture');
  }
  if (process.version !== NODE_VERSION) fail('capture requires Node v24.18.0');
  const inspectedImage = JSON.parse(docker(['image', 'inspect', image]));
  if (!Array.isArray(inspectedImage) || inspectedImage.length !== 1) {
    fail('image inspection shape is invalid');
  }
  const imageFact = inspectedImage[0];
  if (
    imageFact?.Os !== 'linux' ||
    imageFact?.Architecture !== IMAGE_ARCHITECTURES[architecture] ||
    imageFact?.Config?.User !== '10001:10001' ||
    typeof imageFact?.Id !== 'string' ||
    !IMAGE_ID_PATTERN.test(imageFact.Id) ||
    !Number.isSafeInteger(imageFact?.Size) ||
    imageFact.Size < 1
  ) {
    fail('image identity is invalid');
  }

  const suffix = `${process.pid}-${Date.now()}`;
  const network = `ql3-console-capacity-${suffix}`;
  const authorityVolume = `ql3-console-authority-${suffix}`;
  const serverVolume = `ql3-console-server-${suffix}`;
  const serverContainer = `ql3-console-manager-${suffix}`;
  const consoleContainer = `ql3-console-capacity-${suffix}`;
  const created = {
    network: false,
    authorityVolume: false,
    serverVolume: false,
    serverContainer: false,
    consoleContainer: false,
  };
  const fixtureRoot = path.resolve(
    __dirname,
    '../packages/ql3-cluster-control/test/fixtures/mtls',
  );
  const managementFixtureRoot = path.resolve(
    __dirname,
    '../packages/ql3-cluster-admin/test/fixtures',
  );
  const session = randomBytes(32).toString('base64url');
  const initialAssertion = syntheticJwt(
    'capacity-operator-a',
    4_102_444_800,
    1,
  );
  const rotatedAssertion = syntheticJwt(
    'capacity-operator-b',
    4_102_444_800,
    2,
  );
  const expiredAssertion = syntheticJwt('capacity-operator-expired', 1, 3);
  const port = await unusedLoopbackPort();
  const runConfig = JSON.stringify({
    schemaVersion: 1,
    endpoint: `https://${SERVICE_NAME}:${MANAGEMENT_PORT}/api/v3/runs/management`,
    servername: SERVICE_NAME,
    caFile: '/authority/management-service-cert.pem',
    clientCertificateFile: '/authority/client-cert.pem',
    clientPrivateKeyFile: '/authority/client-key.pem',
    requestTimeoutMs: 2_000,
  });
  const projectConfig = JSON.stringify({
    schema: 'qinglong/cluster-copilot-client-config@v1',
    endpoint: `https://${SERVICE_NAME}:${MANAGEMENT_PORT}/`,
    servername: SERVICE_NAME,
    caFile: '/authority/management-service-cert.pem',
    requestTimeoutMs: 2_000,
  });

  try {
    docker(['network', 'create', '--driver', 'bridge', network]);
    created.network = true;
    docker(['volume', 'create', authorityVolume]);
    created.authorityVolume = true;
    docker(['volume', 'create', serverVolume]);
    created.serverVolume = true;
    seedVolume(image, authorityVolume, '/authority', {
      'management-service-cert.pem': fs.readFileSync(
        path.join(managementFixtureRoot, 'management-service-cert.pem'),
        'utf8',
      ),
      'client-cert.pem': fs.readFileSync(
        path.join(fixtureRoot, 'client-cert.pem'),
        'utf8',
      ),
      'client-key.pem': fs.readFileSync(
        path.join(fixtureRoot, 'client-key.pem'),
        'utf8',
      ),
      'project.json': projectConfig,
      credential: `ql3c_console_${randomBytes(32).toString('base64url')}`,
      session,
      'run.json': runConfig,
      'assertion.jwt': initialAssertion,
    });
    seedVolume(image, serverVolume, '/server', {
      'server-cert.pem': fs.readFileSync(
        path.join(managementFixtureRoot, 'management-service-cert.pem'),
        'utf8',
      ),
      'server-key.pem': fs.readFileSync(
        path.join(managementFixtureRoot, 'management-service-key.pem'),
        'utf8',
      ),
      'client-ca.pem': fs.readFileSync(
        path.join(fixtureRoot, 'ca-cert.pem'),
        'utf8',
      ),
      'assertions.json': JSON.stringify({
        initial: initialAssertion,
        rotated: rotatedAssertion,
        expired: expiredAssertion,
      }),
    });

    docker([
      'run',
      '--detach',
      '--name',
      serverContainer,
      '--read-only',
      '--network',
      network,
      '--network-alias',
      SERVICE_NAME,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '10001:10001',
      '--pids-limit',
      '16',
      '--memory',
      '96m',
      '--memory-swap',
      '96m',
      '--cpus',
      '0.25',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=8m,mode=700,uid=10001,gid=10001',
      '--volume',
      `${serverVolume}:/server:ro`,
      '--entrypoint',
      'node',
      image,
      '-e',
      MANAGEMENT_SERVER_SOURCE,
    ]);
    created.serverContainer = true;
    waitForLog(serverContainer, 'management_ready');

    docker([
      'run',
      '--detach',
      '--name',
      consoleContainer,
      '--read-only',
      '--network',
      network,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '10001:10001',
      '--pids-limit',
      String(PIDS_MAX),
      '--memory',
      '192m',
      '--memory-swap',
      '192m',
      '--cpus',
      '0.25',
      '--stop-timeout',
      '3',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=8m,mode=700,uid=10001,gid=10001',
      '--publish',
      `127.0.0.1:${port}:${port}/tcp`,
      '--volume',
      `${authorityVolume}:/authority:ro`,
      image,
      'copilot-console',
      '--container-published-loopback',
      `--port=${port}`,
      '--config',
      '/authority/project.json',
      '--credential',
      '/authority/credential',
      '--session',
      '/authority/session',
      '--run-management-config',
      '/authority/run.json',
      '--run-management-assertion',
      '/authority/assertion.jwt',
    ]);
    created.consoleContainer = true;
    const started = waitForLog(consoleContainer, 'started');
    if (
      started?.origin !== `http://127.0.0.1:${port}` ||
      started?.networkBoundary !== 'container-published-loopback' ||
      started?.publishedHostAddress !== '127.0.0.1' ||
      started?.runManagementAuthority !== 'server_only' ||
      started?.mutation !== false
    ) {
      fail('Console start boundary drifted');
    }
    const beforeInspect = JSON.parse(docker(['inspect', consoleContainer]))[0];
    const beforeSnapshot = parseCgroupSnapshot(consoleContainer);
    const origin = `http://127.0.0.1:${port}`;
    const initial = await postConsole(origin, session, 'capacity-initial');
    rotateAssertion(image, authorityVolume, rotatedAssertion);
    const rotated = await postConsole(origin, session, 'capacity-rotated');
    rotateAssertion(image, authorityVolume, expiredAssertion);
    const expired = await postConsole(origin, session, 'capacity-expired');
    rotateAssertion(image, authorityVolume, rotatedAssertion);
    const recovered = await postConsole(origin, session, 'capacity-recovered');
    const afterSnapshot = parseCgroupSnapshot(consoleContainer);
    const afterInspect = JSON.parse(docker(['inspect', consoleContainer]))[0];
    if (
      initial.statusCode !== 200 ||
      initial.body?.result?.result?.assessment !== 'clear' ||
      rotated.statusCode !== 200 ||
      rotated.body?.result?.result?.assessment !== 'attention_required' ||
      expired.statusCode !== 502 ||
      expired.body?.code !== 'assertion_expired' ||
      recovered.statusCode !== 200 ||
      recovered.body?.result?.result?.assessment !== 'attention_required'
    ) {
      fail('assertion lifecycle response drifted');
    }
    const serializedResponses = JSON.stringify([
      initial,
      rotated,
      expired,
      recovered,
    ]);
    if (
      serializedResponses.includes(initialAssertion) ||
      serializedResponses.includes(rotatedAssertion) ||
      serializedResponses.includes(expiredAssertion) ||
      serializedResponses.includes('/authority/') ||
      serializedResponses.includes(SERVICE_NAME)
    ) {
      fail('Console response leaked private authority');
    }
    const managementRequests = parseJsonLines(
      dockerLogs(serverContainer),
    ).filter(({ event }) => event === 'management_request');
    if (
      JSON.stringify(managementRequests.map(({ label }) => label)) !==
        JSON.stringify(['initial', 'rotated', 'expired', 'rotated']) ||
      managementRequests.some(
        (entry) =>
          entry.tlsVersion !== 'TLSv1.3' ||
          entry.mutualTls !== true ||
          entry.method !== 'POST' ||
          entry.path !== '/api/v3/runs/management' ||
          entry.operation !== 'run.cancellation.summary' ||
          entry.mutation !== false,
      )
    ) {
      fail('management assertion observations drifted');
    }
    const binding =
      afterInspect?.HostConfig?.PortBindings?.[`${port}/tcp`]?.[0];
    const authorityMount = afterInspect?.Mounts?.find(
      ({ Destination }) => Destination === '/authority',
    );
    if (
      beforeInspect?.State?.StartedAt !== afterInspect?.State?.StartedAt ||
      afterInspect?.State?.Running !== true ||
      afterInspect?.Config?.User !== '10001:10001' ||
      afterInspect?.HostConfig?.ReadonlyRootfs !== true ||
      afterInspect?.HostConfig?.Memory !== MEMORY_MAX_BYTES ||
      afterInspect?.HostConfig?.MemorySwap !== MEMORY_MAX_BYTES ||
      afterInspect?.HostConfig?.NanoCpus !== 250_000_000 ||
      afterInspect?.HostConfig?.PidsLimit !== PIDS_MAX ||
      afterInspect?.HostConfig?.NetworkMode !== network ||
      binding?.HostIp !== '127.0.0.1' ||
      !afterInspect?.HostConfig?.CapDrop?.includes('ALL') ||
      !afterInspect?.HostConfig?.SecurityOpt?.includes('no-new-privileges') ||
      authorityMount?.RW !== false ||
      afterInspect?.HostConfig?.Tmpfs?.['/tmp'] !==
        'rw,noexec,nosuid,nodev,size=8m,mode=700,uid=10001,gid=10001'
    ) {
      fail('Console container envelope drifted');
    }
    if (
      beforeSnapshot.platform !== 'linux' ||
      beforeSnapshot.architecture !== architecture ||
      beforeSnapshot.node !== NODE_VERSION ||
      beforeSnapshot.uid !== 10001 ||
      beforeSnapshot.gid !== 10001 ||
      afterSnapshot.platform !== beforeSnapshot.platform ||
      afterSnapshot.architecture !== beforeSnapshot.architecture ||
      afterSnapshot.node !== beforeSnapshot.node ||
      afterSnapshot.uid !== beforeSnapshot.uid ||
      afterSnapshot.gid !== beforeSnapshot.gid
    ) {
      fail('Console runtime identity drifted');
    }

    return {
      schemaVersion: 1,
      observedAtMs: Date.now(),
      platform: 'linux',
      architecture,
      image: {
        architecture: imageFact.Architecture,
        id: imageFact.Id,
        bytes: imageFact.Size,
        user: imageFact.Config.User,
      },
      runtime: {
        node: afterSnapshot.node,
        uid: afterSnapshot.uid,
        gid: afterSnapshot.gid,
      },
      envelope: {
        memoryMaxBytes: afterSnapshot.memoryMaxBytes,
        memoryPeakBytes: afterSnapshot.memoryPeakBytes,
        memoryHeadroomBytes:
          afterSnapshot.memoryMaxBytes - afterSnapshot.memoryPeakBytes,
        swapMaxBytes: afterSnapshot.swapMaxBytes,
        cpuQuotaMicros: afterSnapshot.cpuQuotaMicros,
        cpuPeriodMicros: afterSnapshot.cpuPeriodMicros,
        pidsMax: afterSnapshot.pidsMax,
        pidsCurrent: afterSnapshot.pidsCurrent,
        noNewPrivileges: afterSnapshot.noNewPrivileges,
        seccompMode: afterSnapshot.seccompMode,
        readOnlyRoot: true,
        tmpfsBytes: TMPFS_BYTES,
        publishedHostAddress: '127.0.0.1',
        capabilityDrop: 'ALL',
        memoryEventsBefore: beforeSnapshot.memoryEvents,
        memoryEventsAfter: afterSnapshot.memoryEvents,
      },
      assertionLifecycle: {
        requestCount: managementRequests.length,
        sequence: ASSERTION_SEQUENCE,
        tlsVersion: 'TLSv1.3',
        mutualTls: true,
        consoleRestarted: false,
        mutation: false,
        operation: 'run.cancellation.summary',
        expiredConsoleStatus: expired.statusCode,
        expiredCode: expired.body.code,
      },
    };
  } finally {
    if (created.consoleContainer) {
      cleanupDocker(['stop', '--time', '3', consoleContainer]);
      cleanupDocker(['rm', '--force', consoleContainer]);
    }
    if (created.serverContainer) {
      cleanupDocker(['stop', '--time', '3', serverContainer]);
      cleanupDocker(['rm', '--force', serverContainer]);
    }
    if (created.authorityVolume)
      cleanupDocker(['volume', 'rm', authorityVolume]);
    if (created.serverVolume) cleanupDocker(['volume', 'rm', serverVolume]);
    if (created.network) cleanupDocker(['network', 'rm', network]);
  }
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    const separator = argument.indexOf('=');
    if (!argument.startsWith('--') || separator < 3) {
      fail(`unsupported argument ${argument}`);
    }
    const key = argument.slice(2, separator);
    if (Object.hasOwn(options, key)) fail(`duplicate argument --${key}`);
    options[key] = argument.slice(separator + 1);
  }
  const common = [
    'mode',
    'repository',
    'revision',
    'workflow',
    'run-id',
    'run-attempt',
  ];
  const modeKeys =
    options.mode === 'capture'
      ? [...common, 'architecture', 'image', 'output']
      : options.mode === 'merge'
      ? [...common, 'x64', 'arm64', 'output']
      : options.mode === 'audit'
      ? [...common, 'report']
      : fail('--mode must be capture, merge, or audit');
  if (
    JSON.stringify(Object.keys(options).sort()) !==
    JSON.stringify(modeKeys.sort())
  ) {
    fail(`${options.mode} arguments are incomplete or widened`);
  }
  const source = normalizeSource({
    repository: options.repository,
    revision: options.revision,
    workflow: options.workflow,
    runId: options['run-id'],
    runAttempt: Number(options['run-attempt']),
  });
  if (
    options.mode === 'capture' &&
    (typeof options.image !== 'string' || !IMAGE_PATTERN.test(options.image))
  ) {
    fail('image is invalid');
  }
  return Object.freeze({ ...options, source });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === 'capture') {
    if (process.env.QL3_CLUSTER_COPILOT_CONSOLE_CAPACITY_LIVE !== '1') {
      fail('QL3_CLUSTER_COPILOT_CONSOLE_CAPACITY_LIVE=1 is required');
    }
    if (!ARCHITECTURES.includes(options.architecture)) {
      fail('architecture is invalid');
    }
    const observation = await captureLiveObservation(
      options.image,
      options.architecture,
    );
    const result = createArchitectureEvidence({
      source: options.source,
      architecture: options.architecture,
      observation,
    });
    writeJsonFile(options.output, result);
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        mode: 'capture',
        architecture: result.architecture,
        bundleDigest: result.bundleDigest,
        passed: true,
      })}\n`,
    );
    return;
  }
  if (options.mode === 'merge') {
    const result = mergeCrossArchitectureEvidence({
      source: options.source,
      x64: readJsonFile(options.x64, 'x64 evidence'),
      arm64: readJsonFile(options.arm64, 'arm64 evidence'),
    });
    writeJsonFile(options.output, result);
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        mode: 'merge',
        releaseDigest: result.releaseDigest,
        passed: true,
      })}\n`,
    );
    return;
  }
  const report = readJsonFile(options.report, 'release evidence');
  validateReleaseEvidence(report, options.source);
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      mode: 'audit',
      releaseDigest: report.releaseDigest,
      passed: true,
    })}\n`,
  );
}

module.exports = {
  ARCHITECTURES,
  ASSERTION_SEQUENCE,
  CPU_PERIOD_MICROS,
  CPU_QUOTA_MICROS,
  LIMITATIONS,
  MAX_EVIDENCE_BYTES,
  MEMORY_MAX_BYTES,
  MINIMUM_MEMORY_HEADROOM_BYTES,
  NODE_VERSION,
  PIDS_MAX,
  QingLong3ClusterCopilotConsoleCapacityEvidenceError,
  SWAP_MAX_BYTES,
  TMPFS_BYTES,
  createArchitectureEvidence,
  evidenceDigest,
  mergeCrossArchitectureEvidence,
  normalizeSource,
  parseArguments,
  readJsonFile,
  validateArchitectureEvidence,
  validateObservation,
  validateReleaseEvidence,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
