#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');

const {
  validateExercise,
} = require('./ql3-plugin-package-management-live-evidence-collect.cjs');

const STATE_FIXTURE =
  'qinglong/plugin-package-management-live-exercise-state@v1';
const EXERCISE_FIXTURE = 'qinglong/plugin-package-management-live-exercise@v1';
const MANAGEMENT_PATH = '/api/v3/plugin-packages/management';
const NAMESPACE = 'qinglong3-system';
const MANAGEMENT_NAME = 'ql3-plugin-package-management';
const IDENTITY_SECRET = 'ql3-plugin-package-management-identity';
const TLS_SECRET = 'ql3-plugin-package-management-tls';
const MAX_PRIVATE_BYTES = 1024 * 1024;
const MAX_ASSERTION_BYTES = 16 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 128 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const INGRESS_PROBE_SCRIPT = String.raw`
const net = require('node:net');
const tls = require('node:tls');
const [mode, host, rawPort, expected, servername] = process.argv.slice(1);
const port = Number(rawPort);
let settled = false;
const finish = (ok, outcome, extra = {}) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok, outcome, ...extra }) + '\n');
  process.exitCode = ok ? 0 : 1;
  socket.destroy();
};
const options = { host, port };
const socket = mode === 'tls'
  ? tls.connect({
      ...options,
      servername,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3'
    })
  : net.createConnection(options);
const timer = setTimeout(() => {
  finish(expected === 'timeout', 'timeout');
}, 4000);
socket.setTimeout(4500);
socket.once(mode === 'tls' ? 'secureConnect' : 'connect', () => {
  const protocol = mode === 'tls' ? socket.getProtocol() : null;
  finish(
    expected === 'connected' && (mode !== 'tls' || protocol === 'TLSv1.3'),
    'connected',
    protocol ? { protocol } : {}
  );
});
socket.once('error', (error) => {
  finish(false, 'error', { code: String(error.code || 'UNKNOWN').slice(0, 64) });
});
`;

const EGRESS_PROBE_SCRIPT = String.raw`
const net = require('node:net');
const targets = [
  { name: 'kubernetesApi', host: 'kubernetes.default.svc', port: 443, expected: 'timeout' },
  { name: 'publicInternet', host: '1.1.1.1', port: 443, expected: 'timeout' },
  { name: 'postgres', host: 'ql3-postgres-rw.qinglong3-system.svc', port: 5432, expected: 'connected' }
];
function probe(target) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: target.host, port: target.port });
    const finish = (outcome, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        name: target.name,
        expected: target.expected,
        outcome,
        ...(code ? { code } : {})
      });
    };
    const timer = setTimeout(() => finish('timeout'), 4000);
    socket.once('connect', () => finish('connected'));
    socket.once('error', (error) =>
      finish('error', String(error.code || 'UNKNOWN').slice(0, 64))
    );
  });
}
Promise.all(targets.map(probe)).then((results) => {
  const ok = results.every((entry) => entry.outcome === entry.expected);
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok, results }) + '\n');
  process.exitCode = ok ? 0 : 1;
});
`;

class PluginPackageManagementLiveExerciseError extends Error {
  constructor(message) {
    super(`Plugin Package management live exercise failed: ${message}`);
    this.name = 'PluginPackageManagementLiveExerciseError';
  }
}

function fail(message) {
  throw new PluginPackageManagementLiveExerciseError(message);
}

function exactKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    fail(`${label} shape is invalid`);
  }
}

function boundedToken(value, label, maximum = 256) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    CONTROL_PATTERN.test(value)
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function stateDigest(state) {
  const { stateSha256: _ignored, ...body } = state;
  return sha256(canonicalJson(body));
}

function finalizeState(body) {
  const state = { ...body, stateSha256: '' };
  state.stateSha256 = stateDigest(state);
  return Object.freeze(state);
}

function canonicalFile(filePath, label, options = {}) {
  if (!path.isAbsolute(filePath)) fail(`${label} path must be absolute`);
  const stat = fs.lstatSync(filePath);
  const maximum = options.maximum ?? MAX_PRIVATE_BYTES;
  const privateFile = options.private !== false;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > maximum ||
    (stat.mode & (privateFile ? 0o077 : 0o022)) !== 0 ||
    fs.realpathSync(filePath) !== filePath
  ) {
    fail(
      `${label} is not a canonical bounded ${
        privateFile ? 'private ' : ''
      }file`,
    );
  }
  return filePath;
}

function readText(filePath, label, options) {
  canonicalFile(filePath, label, options);
  return fs.readFileSync(filePath, 'utf8').trim();
}

function readJson(filePath, label, options) {
  try {
    return JSON.parse(readText(filePath, label, options));
  } catch (error) {
    if (error instanceof PluginPackageManagementLiveExerciseError) throw error;
    fail(`${label} is not valid JSON`);
  }
}

function unusedOutput(filePath, label) {
  if (!path.isAbsolute(filePath) || fs.existsSync(filePath)) {
    fail(`${label} must be an unused absolute path`);
  }
  const parent = fs.realpathSync(path.dirname(filePath));
  if (path.join(parent, path.basename(filePath)) !== filePath) {
    fail(`${label} parent must be canonical`);
  }
  return filePath;
}

function writeNoReplace(filePath, value) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseBase64UrlJson(segment, label, maximum = 8 * 1024) {
  if (
    typeof segment !== 'string' ||
    segment.length < 1 ||
    !BASE64URL_PATTERN.test(segment)
  ) {
    fail(`${label} encoding is invalid`);
  }
  const bytes = Buffer.from(segment, 'base64url');
  if (
    bytes.length < 2 ||
    bytes.length > maximum ||
    bytes.toString('base64url') !== segment
  ) {
    fail(`${label} encoding is not canonical`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} JSON is invalid`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function assertionEnvelope(assertion) {
  if (
    typeof assertion !== 'string' ||
    Buffer.byteLength(assertion, 'utf8') > MAX_ASSERTION_BYTES ||
    CONTROL_PATTERN.test(assertion)
  ) {
    fail('assertion is invalid');
  }
  const segments = assertion.split('.');
  if (segments.length !== 3) fail('assertion compact shape is invalid');
  const header = parseBase64UrlJson(segments[0], 'assertion header', 1024);
  const claims = parseBase64UrlJson(segments[1], 'assertion claims');
  exactKeys(header, ['alg', 'kid', 'typ'], 'assertion header');
  if (
    header.typ !== 'ql3-plugin-package-management+jwt' ||
    !KEY_ID_PATTERN.test(header.kid)
  ) {
    fail('assertion header does not bind the management purpose');
  }
  const claimKeys = [
    'acr',
    'amr',
    'aud',
    'auth_time',
    'exp',
    'iat',
    'iss',
    'jti',
    'ql3_purpose',
    'sub',
  ];
  if (Object.hasOwn(claims, 'nbf')) claimKeys.push('nbf');
  exactKeys(claims, claimKeys, 'assertion claims');
  boundedToken(claims.sub, 'assertion subject', 255);
  boundedToken(claims.jti, 'assertion jti', 255);
  boundedToken(claims.acr, 'assertion acr', 256);
  if (
    claims.ql3_purpose !== 'plugin-package-management' ||
    !Array.isArray(claims.amr) ||
    claims.amr.length < 1 ||
    claims.amr.length > 8 ||
    !claims.amr.every((value) => TOKEN_PATTERN.test(value)) ||
    new Set(claims.amr).size !== claims.amr.length ||
    ![claims.iat, claims.auth_time, claims.exp].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    fail('assertion claims are invalid');
  }
  return Object.freeze({ header, claims });
}

function validateKeyset(value) {
  exactKeys(
    value,
    [
      'schemaVersion',
      'generation',
      'issuer',
      'audience',
      'keys',
      'revokedKids',
      'assuranceMappings',
      'constraints',
    ],
    'identity keyset',
  );
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !Array.isArray(value.keys) ||
    value.keys.length < 1 ||
    value.keys.length > 8 ||
    !Array.isArray(value.revokedKids) ||
    value.revokedKids.length > 64 ||
    !Array.isArray(value.assuranceMappings) ||
    value.assuranceMappings.length < 1 ||
    value.assuranceMappings.length > 8
  ) {
    fail('identity keyset bounds are invalid');
  }
  boundedToken(value.issuer, 'identity issuer', 512);
  boundedToken(value.audience, 'identity audience', 256);
  const kids = new Set();
  for (const key of value.keys) {
    if (
      !key ||
      typeof key !== 'object' ||
      Array.isArray(key) ||
      !KEY_ID_PATTERN.test(key.kid) ||
      kids.has(key.kid) ||
      ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some((name) =>
        Object.hasOwn(key, name),
      )
    ) {
      fail('identity keyset contains an invalid or private JWK');
    }
    kids.add(key.kid);
  }
  if (
    !value.revokedKids.every(
      (kid) => KEY_ID_PATTERN.test(kid) && kids.has(kid),
    ) ||
    new Set(value.revokedKids).size !== value.revokedKids.length
  ) {
    fail('identity keyset revocation list is invalid');
  }
  const mappings = new Map();
  for (const mapping of value.assuranceMappings) {
    exactKeys(
      mapping,
      ['acr', 'assurance', 'requiredAmr'],
      'assurance mapping',
    );
    if (
      typeof mapping.acr !== 'string' ||
      boundedToken(mapping.acr, 'assurance mapping acr', 256) !== mapping.acr ||
      mappings.has(mapping.acr) ||
      !['multi_factor', 'hardware'].includes(mapping.assurance) ||
      !Array.isArray(mapping.requiredAmr) ||
      mapping.requiredAmr.length < 1 ||
      mapping.requiredAmr.length > 8 ||
      !mapping.requiredAmr.every((entry) => TOKEN_PATTERN.test(entry)) ||
      new Set(mapping.requiredAmr).size !== mapping.requiredAmr.length
    ) {
      fail('assurance mapping is invalid');
    }
    mappings.set(mapping.acr, mapping);
  }
  return Object.freeze({
    document: value,
    activeKids: Object.freeze(
      [...kids].filter((kid) => !value.revokedKids.includes(kid)).sort(),
    ),
    revokedKids: Object.freeze([...value.revokedKids].sort()),
    mappings,
  });
}

function assertionIdentity(assertion, keyset, nowMs = Date.now()) {
  const envelope = assertionEnvelope(assertion);
  const { claims, header } = envelope;
  const mapping = keyset.mappings.get(claims.acr);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    claims.iss !== keyset.document.issuer ||
    claims.aud !== keyset.document.audience ||
    !mapping ||
    !mapping.requiredAmr.every((entry) => claims.amr.includes(entry)) ||
    claims.auth_time > claims.iat ||
    claims.iat > nowSeconds + 60 ||
    claims.exp <= nowSeconds + 15 ||
    claims.exp - claims.iat > 15 * 60 ||
    nowSeconds - claims.auth_time > 15 * 60 ||
    (Object.hasOwn(claims, 'nbf') &&
      (!Number.isSafeInteger(claims.nbf) ||
        claims.nbf < claims.iat ||
        claims.nbf >= claims.exp ||
        claims.nbf > nowSeconds + 60))
  ) {
    fail('assertion identity, assurance or validity window is invalid');
  }
  return Object.freeze({
    kid: header.kid,
    subject: claims.sub,
    assurance: mapping.assurance,
    issuer: claims.iss,
    audience: claims.aud,
    expiresAt: claims.exp,
  });
}

function validateState(value, expectedPhase) {
  exactKeys(
    value,
    [
      'schemaVersion',
      'fixture',
      'phase',
      'recordedAt',
      'phaseObservedAt',
      'previousStateSha256',
      'clusterIdentitySha256',
      'endpoint',
      'action',
      'identity',
      'ceremony',
      'isolation',
      'rotation',
      'stateSha256',
    ],
    'exercise state',
  );
  if (
    value.schemaVersion !== 1 ||
    value.fixture !== STATE_FIXTURE ||
    value.phase !== expectedPhase ||
    !Number.isFinite(Date.parse(value.recordedAt)) ||
    !/^sha256:[a-f0-9]{64}$/.test(value.clusterIdentitySha256) ||
    !/^sha256:[a-f0-9]{64}$/.test(value.stateSha256) ||
    value.stateSha256 !== stateDigest(value)
  ) {
    fail('exercise state identity or digest is invalid');
  }
  const expectedPhaseTimes = { before: 1, overlap: 2, revoked: 3 }[
    expectedPhase
  ];
  if (
    !Array.isArray(value.phaseObservedAt) ||
    value.phaseObservedAt.length !== expectedPhaseTimes ||
    value.phaseObservedAt.some(
      (observedAt, index, observations) =>
        !Number.isFinite(Date.parse(observedAt)) ||
        (index > 0 &&
          Date.parse(observedAt) <= Date.parse(observations[index - 1])),
    ) ||
    value.recordedAt !== value.phaseObservedAt.at(-1)
  ) {
    fail('exercise phase observation timeline is invalid');
  }
  parseEndpoint(value.endpoint);
  exactKeys(
    value.action,
    [
      'actionRef',
      'approvalRequestId',
      'proposalAuditEventId',
      'approvalAuditEventId',
      'decisionAuditEventId',
      'decisionId',
      'approvalVersion',
    ],
    'state action',
  );
  const uuidValues = [
    value.action.approvalRequestId,
    value.action.proposalAuditEventId,
    value.action.approvalAuditEventId,
    value.action.decisionAuditEventId,
    value.action.decisionId,
  ];
  if (
    !TOKEN_PATTERN.test(value.action.actionRef) ||
    !uuidValues.every((entry) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        entry,
      ),
    ) ||
    new Set(uuidValues).size !== uuidValues.length ||
    !Number.isSafeInteger(value.action.approvalVersion) ||
    value.action.approvalVersion < 1
  ) {
    fail('state action identity is invalid');
  }
  exactKeys(
    value.identity,
    [
      'issuer',
      'audience',
      'requesterSubject',
      'reviewerSubject',
      'requesterAssurance',
      'reviewerAssurance',
      'oldKid',
      'newKid',
      'overlapOldAssertionSha256',
      'newAssertionSha256',
      'keysetGenerations',
    ],
    'state identity',
  );
  boundedToken(value.identity.issuer, 'state identity issuer', 512);
  boundedToken(value.identity.audience, 'state identity audience', 256);
  boundedToken(value.identity.requesterSubject, 'state requester subject', 255);
  boundedToken(value.identity.reviewerSubject, 'state reviewer subject', 255);
  if (
    value.identity.requesterSubject === value.identity.reviewerSubject ||
    !['multi_factor', 'hardware'].includes(value.identity.requesterAssurance) ||
    !['multi_factor', 'hardware'].includes(value.identity.reviewerAssurance) ||
    !KEY_ID_PATTERN.test(value.identity.oldKid) ||
    (expectedPhase === 'before'
      ? value.identity.newKid !== null
      : !KEY_ID_PATTERN.test(value.identity.newKid) ||
        value.identity.newKid === value.identity.oldKid) ||
    (expectedPhase === 'before'
      ? value.identity.overlapOldAssertionSha256 !== null ||
        value.identity.newAssertionSha256 !== null
      : !/^sha256:[a-f0-9]{64}$/.test(
          value.identity.overlapOldAssertionSha256,
        ) ||
        !/^sha256:[a-f0-9]{64}$/.test(value.identity.newAssertionSha256) ||
        value.identity.overlapOldAssertionSha256 ===
          value.identity.newAssertionSha256) ||
    !Array.isArray(value.identity.keysetGenerations) ||
    value.identity.keysetGenerations.length !==
      { before: 1, overlap: 2, revoked: 3 }[expectedPhase] ||
    value.identity.keysetGenerations.some(
      (generation, index, generations) =>
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        (index > 0 && generation <= generations[index - 1]),
    )
  ) {
    fail('state identity rotation is invalid');
  }
  exactKeys(
    value.ceremony,
    [
      'proposalAuditEventId',
      'approvalAuditEventId',
      'decisionAuditEventId',
      'proposeStatus',
      'proposeOperation',
      'selfDecisionStatus',
      'selfDecisionError',
      'reviewerDecisionStatus',
      'reviewerDecisionOperation',
      'inspectionStatus',
      'inspectionOperation',
    ],
    'state ceremony',
  );
  if (
    value.ceremony.proposalAuditEventId !== value.action.proposalAuditEventId ||
    value.ceremony.approvalAuditEventId !== value.action.approvalAuditEventId ||
    value.ceremony.decisionAuditEventId !== value.action.decisionAuditEventId ||
    value.ceremony.proposeStatus !== 200 ||
    value.ceremony.proposeOperation !== 'plugin-package.propose' ||
    value.ceremony.selfDecisionStatus !== 403 ||
    value.ceremony.selfDecisionError !== 'forbidden' ||
    value.ceremony.reviewerDecisionStatus !== 200 ||
    value.ceremony.reviewerDecisionOperation !== 'plugin-package.decide' ||
    value.ceremony.inspectionStatus !== 200 ||
    value.ceremony.inspectionOperation !== 'plugin-package.inspect'
  ) {
    fail('state ceremony does not prove the exact separation-of-duty flow');
  }
  exactKeys(
    value.isolation,
    [
      'labelledClientOutcome',
      'unlabelledClientOutcome',
      'wrongPortOutcome',
      'kubernetesApiEgressOutcome',
      'publicInternetEgressOutcome',
      'postgresEgressOutcome',
    ],
    'state isolation',
  );
  if (
    value.isolation.labelledClientOutcome !== 'tls13_connected' ||
    value.isolation.unlabelledClientOutcome !== 'timeout' ||
    value.isolation.wrongPortOutcome !== 'timeout' ||
    value.isolation.kubernetesApiEgressOutcome !== 'timeout' ||
    value.isolation.publicInternetEgressOutcome !== 'timeout' ||
    value.isolation.postgresEgressOutcome !== 'postgres_ready'
  ) {
    fail('state isolation outcomes are incomplete');
  }
  exactKeys(
    value.rotation,
    [
      'overlapOldStatus',
      'newStatus',
      'revokedOldStatus',
      'revokedOldError',
      'previousTlsSerial',
      'currentTlsSerial',
      'previousTlsSecretResourceVersion',
      'currentTlsSecretResourceVersion',
      'readinessSamples',
    ],
    'state rotation',
  );
  normalizeSerial(value.rotation.previousTlsSerial);
  boundedToken(
    value.rotation.previousTlsSecretResourceVersion,
    'previous TLS resourceVersion',
    256,
  );
  const phases = ['before', 'overlap', 'revoked'];
  const expectedSampleCount = phases.indexOf(expectedPhase) + 1;
  const invalidReadiness =
    !Array.isArray(value.rotation.readinessSamples) ||
    value.rotation.readinessSamples.length !== expectedSampleCount ||
    value.rotation.readinessSamples.some((sample, index) => {
      try {
        exactKeys(
          sample,
          [
            'phase',
            'replicas',
            'readyReplicas',
            'unavailableReplicas',
            'tlsProtocol',
          ],
          `state readiness sample ${index + 1}`,
        );
      } catch {
        return true;
      }
      return (
        sample.phase !== phases[index] ||
        sample.replicas !== 2 ||
        sample.readyReplicas !== 2 ||
        sample.unavailableReplicas !== 0 ||
        sample.tlsProtocol !== 'TLSv1.3'
      );
    });
  const invalidBeforeRotation =
    expectedPhase === 'before' &&
    (value.rotation.overlapOldStatus !== null ||
      value.rotation.newStatus !== null ||
      value.rotation.revokedOldStatus !== null ||
      value.rotation.revokedOldError !== null ||
      value.rotation.currentTlsSerial !== null ||
      value.rotation.currentTlsSecretResourceVersion !== null);
  const invalidPostOverlapRotation =
    expectedPhase !== 'before' &&
    (value.rotation.overlapOldStatus !== 200 ||
      value.rotation.newStatus !== 200 ||
      normalizeSerial(value.rotation.currentTlsSerial) ===
        normalizeSerial(value.rotation.previousTlsSerial) ||
      boundedToken(
        value.rotation.currentTlsSecretResourceVersion,
        'current TLS resourceVersion',
        256,
      ) === value.rotation.previousTlsSecretResourceVersion ||
      (expectedPhase === 'overlap'
        ? value.rotation.revokedOldStatus !== null ||
          value.rotation.revokedOldError !== null
        : value.rotation.revokedOldStatus !== 401 ||
          value.rotation.revokedOldError !== 'authentication_required'));
  if (
    invalidReadiness ||
    invalidBeforeRotation ||
    invalidPostOverlapRotation ||
    (expectedPhase === 'before' && value.previousStateSha256 !== null) ||
    (expectedPhase !== 'before' &&
      !/^sha256:[a-f0-9]{64}$/.test(value.previousStateSha256))
  ) {
    fail('state chain predecessor is invalid');
  }
  return value;
}

function readinessSample(phase, snapshot) {
  if (
    snapshot.replicas !== 2 ||
    snapshot.readyReplicas !== 2 ||
    snapshot.unavailableReplicas !== 0
  ) {
    fail(`management replicas were unavailable during ${phase}`);
  }
  return Object.freeze({
    phase,
    replicas: 2,
    readyReplicas: 2,
    unavailableReplicas: 0,
    tlsProtocol: 'TLSv1.3',
  });
}

function normalizeSerial(value) {
  const normalized =
    typeof value === 'string' ? value.replace(/:/g, '').toUpperCase() : '';
  if (!/^[0-9A-F]{1,128}$/.test(normalized)) {
    fail('TLS certificate serial is invalid');
  }
  return normalized.replace(/^0+(?=[0-9A-F])/, '');
}

function parseEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail('management endpoint is invalid');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.pathname !== MANAGEMENT_PATH ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    endpoint.toString() !== value
  ) {
    fail(`management endpoint must be canonical HTTPS ${MANAGEMENT_PATH}`);
  }
  return endpoint;
}

function managementRequest(options) {
  const endpoint = parseEndpoint(options.endpoint);
  const body = Buffer.from(JSON.stringify(options.command));
  if (body.length < 2 || body.length > 256 * 1024) {
    fail('management command size is invalid');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const request = https.request(
      endpoint,
      {
        method: 'POST',
        ca: options.ca,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        rejectUnauthorized: true,
        servername: endpoint.hostname,
        headers: {
          authorization: `Bearer ${options.assertion}`,
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
        timeout: 10_000,
      },
      (response) => {
        const chunks = [];
        let length = 0;
        response.on('data', (chunkValue) => {
          const chunk = Buffer.from(chunkValue);
          length += chunk.length;
          if (length > MAX_HTTP_RESPONSE_BYTES) {
            request.destroy(new Error('management response is too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          let payload;
          try {
            payload = JSON.parse(
              Buffer.concat(chunks, length).toString('utf8'),
            );
          } catch {
            finish(
              new PluginPackageManagementLiveExerciseError(
                'management response is not JSON',
              ),
            );
            return;
          }
          const protocol = response.socket.getProtocol();
          const peer = response.socket.getPeerCertificate();
          try {
            finish(null, {
              status: response.statusCode,
              payload,
              tlsProtocol: protocol,
              tlsSerial: normalizeSerial(peer.serialNumber),
            });
          } catch (error) {
            finish(error);
          }
        });
      },
    );
    request.once('timeout', () => {
      request.destroy(new Error('management request timed out'));
    });
    request.once('error', (error) => {
      finish(
        new PluginPackageManagementLiveExerciseError(
          `management request failed without exposing credentials: ${
            error.code ?? error.name
          }`,
        ),
      );
    });
    request.end(body);
  });
}

function commandResult(result, label, allowFailure = false) {
  if (
    !result ||
    result.error ||
    (!allowFailure && result.status !== 0) ||
    result.signal
  ) {
    fail(
      `${label} failed with status ${String(result?.status)}${
        result?.signal ? ` signal ${result.signal}` : ''
      }`,
    );
  }
  return Object.freeze({
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  });
}

function createKubectl(options) {
  const binary = process.env.QL3_KUBECTL_BIN || 'kubectl';
  const base = [
    '--kubeconfig',
    options.kubeconfig,
    '--context',
    options.context,
  ];
  const run = (args, runOptions = {}) => {
    const result = spawnSync(binary, [...base, ...args], {
      encoding: 'utf8',
      input: runOptions.input,
      timeout: runOptions.timeout ?? 30_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return commandResult(
      result,
      runOptions.label ?? `kubectl ${args.join(' ')}`,
      runOptions.allowFailure,
    );
  };
  const json = (args, label) => {
    const result = run([...args, '-o', 'json'], { label });
    try {
      return JSON.parse(result.stdout);
    } catch {
      fail(`${label} did not return JSON`);
    }
  };
  return Object.freeze({ run, json });
}

function parseJsonPathPair(stdout, label) {
  const newline = stdout.indexOf('\n');
  if (newline < 1 || newline === stdout.length - 1) {
    fail(`${label} public fields are incomplete`);
  }
  const resourceVersion = boundedToken(
    stdout.slice(0, newline),
    `${label} resourceVersion`,
    256,
  );
  let bytes;
  try {
    bytes = Buffer.from(stdout.slice(newline + 1), 'base64');
  } catch {
    fail(`${label} public data is not base64`);
  }
  if (bytes.length < 2 || bytes.length > MAX_PRIVATE_BYTES) {
    fail(`${label} public data size is invalid`);
  }
  return Object.freeze({ resourceVersion, bytes });
}

function readPublicKeyset(kubectl) {
  const pair = parseJsonPathPair(
    kubectl.run([
      '-n',
      NAMESPACE,
      'get',
      'secret',
      IDENTITY_SECRET,
      '-o',
      'jsonpath={.metadata.resourceVersion}{"\\n"}{.data.keyset\\.json}',
    ]).stdout,
    'identity keyset',
  );
  let document;
  try {
    document = JSON.parse(pair.bytes.toString('utf8'));
  } catch {
    fail('identity keyset public document is not JSON');
  }
  return Object.freeze({
    ...validateKeyset(document),
    resourceVersion: pair.resourceVersion,
  });
}

function readPublicTls(kubectl) {
  const pair = parseJsonPathPair(
    kubectl.run([
      '-n',
      NAMESPACE,
      'get',
      'secret',
      TLS_SECRET,
      '-o',
      'jsonpath={.metadata.resourceVersion}{"\\n"}{.data.tls\\.crt}',
    ]).stdout,
    'management TLS certificate',
  );
  let certificate;
  try {
    certificate = new X509Certificate(pair.bytes);
  } catch {
    fail('management TLS public certificate is invalid');
  }
  return Object.freeze({
    resourceVersion: pair.resourceVersion,
    serial: normalizeSerial(certificate.serialNumber),
  });
}

function managementSnapshot(kubectl) {
  const namespace = kubectl.json(
    ['get', 'namespace', 'kube-system'],
    'cluster identity namespace',
  );
  const deployment = kubectl.json(
    ['-n', NAMESPACE, 'get', 'deployment', MANAGEMENT_NAME],
    'management Deployment',
  );
  const pods = (
    kubectl.json(
      [
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/name=ql3-plugin-package-management,app.kubernetes.io/component=plugin-package-management',
      ],
      'management Pods',
    ).items ?? []
  ).filter((pod) => !pod.metadata?.deletionTimestamp);
  const readyPods = pods.filter((pod) =>
    pod.status?.conditions?.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    ),
  );
  if (
    deployment.spec?.replicas !== 2 ||
    deployment.status?.readyReplicas !== 2 ||
    (deployment.status?.unavailableReplicas ?? 0) !== 0 ||
    readyPods.length !== 2 ||
    new Set(readyPods.map((pod) => pod.spec?.nodeName)).size !== 2 ||
    !readyPods.every(
      (pod) =>
        pod.spec?.serviceAccountName === MANAGEMENT_NAME &&
        pod.spec?.automountServiceAccountToken === false,
    )
  ) {
    fail('management Deployment is not two-replica ready on distinct nodes');
  }
  const container = deployment.spec?.template?.spec?.containers?.find(
    (candidate) => candidate.name === 'management',
  );
  if (!container?.image) fail('management image is unavailable');
  return Object.freeze({
    clusterIdentitySha256: sha256(
      `qinglong3.cluster-identity.v1\0${namespace.metadata?.uid}`,
    ),
    replicas: 2,
    readyReplicas: 2,
    unavailableReplicas: 0,
    pods: Object.freeze(
      readyPods.map((pod) =>
        Object.freeze({
          name: pod.metadata.name,
          uid: pod.metadata.uid,
          ip: pod.status.podIP,
        }),
      ),
    ),
    image: container.image,
    imagePullPolicy: container.imagePullPolicy ?? 'IfNotPresent',
    imagePullSecrets: Object.freeze(
      deployment.spec?.template?.spec?.imagePullSecrets ?? [],
    ),
    keyset: readPublicKeyset(kubectl),
    tls: readPublicTls(kubectl),
  });
}

function probePod(
  name,
  image,
  imagePullPolicy,
  imagePullSecrets,
  labels,
  args,
) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: {
        'app.kubernetes.io/name': 'ql3-management-live-probe',
        'app.kubernetes.io/component': 'evidence-probe',
        ...labels,
      },
    },
    spec: {
      automountServiceAccountToken: false,
      restartPolicy: 'Never',
      activeDeadlineSeconds: 20,
      terminationGracePeriodSeconds: 1,
      imagePullSecrets,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        runAsGroup: 10001,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'probe',
          image,
          imagePullPolicy,
          command: ['node', '-e', INGRESS_PROBE_SCRIPT, '--', ...args],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          resources: {
            requests: { cpu: '5m', memory: '16Mi' },
            limits: { cpu: '100m', memory: '64Mi' },
          },
        },
      ],
    },
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitProbe(kubectl, name) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const pod = kubectl.json(
      ['-n', NAMESPACE, 'get', 'pod', name],
      `probe Pod ${name}`,
    );
    if (['Succeeded', 'Failed'].includes(pod.status?.phase)) {
      const logs = kubectl.run([
        '-n',
        NAMESPACE,
        'logs',
        name,
        '-c',
        'probe',
      ]).stdout;
      let result;
      try {
        result = JSON.parse(logs);
      } catch {
        fail(`probe Pod ${name} did not emit JSON`);
      }
      if (pod.status.phase !== 'Succeeded' || result.ok !== true) {
        fail(`probe Pod ${name} rejected the expected network outcome`);
      }
      return result;
    }
    await sleep(500);
  }
  fail(`probe Pod ${name} timed out`);
}

async function ingressProbes(kubectl, snapshot, runId) {
  const serviceHost = `${MANAGEMENT_NAME}.${NAMESPACE}.svc`;
  const podIp = boundedToken(snapshot.pods[0]?.ip, 'management Pod IP', 64);
  const definitions = [
    {
      suffix: 'allowed',
      labels: {
        'qinglong.io/plugin-package-management-client': 'true',
      },
      args: ['tls', serviceHost, '8443', 'connected', serviceHost],
    },
    {
      suffix: 'unlabelled',
      labels: {},
      args: ['tls', serviceHost, '8443', 'timeout', serviceHost],
    },
    {
      suffix: 'wrong-port',
      labels: {
        'qinglong.io/plugin-package-management-client': 'true',
      },
      args: ['tcp', podIp, '8080', 'timeout', serviceHost],
    },
  ];
  const names = definitions.map(
    ({ suffix }) => `ql3-management-evidence-${runId.slice(0, 8)}-${suffix}`,
  );
  const createdNames = [];
  let outcome;
  let primaryError;
  try {
    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index];
      const manifest = probePod(
        names[index],
        snapshot.image,
        snapshot.imagePullPolicy,
        snapshot.imagePullSecrets,
        definition.labels,
        definition.args,
      );
      kubectl.run(['create', '-f', '-'], {
        input: `${JSON.stringify(manifest)}\n`,
        label: `create exact probe Pod ${names[index]}`,
      });
      createdNames.push(names[index]);
    }
    const [allowed, unlabelled, wrongPort] = await Promise.all(
      names.map((name) => waitProbe(kubectl, name)),
    );
    if (
      allowed.outcome !== 'connected' ||
      allowed.protocol !== 'TLSv1.3' ||
      unlabelled.outcome !== 'timeout' ||
      wrongPort.outcome !== 'timeout'
    ) {
      fail('ingress probe outcomes are incomplete');
    }
    outcome = Object.freeze({
      labelledClientOutcome: 'tls13_connected',
      unlabelledClientOutcome: 'timeout',
      wrongPortOutcome: 'timeout',
    });
  } catch (error) {
    primaryError = error;
  }
  const cleanupFailures = [];
  for (const name of createdNames) {
    const result = kubectl.run(
      [
        '-n',
        NAMESPACE,
        'delete',
        'pod',
        name,
        '--ignore-not-found=true',
        '--wait=true',
        '--timeout=30s',
      ],
      {
        allowFailure: true,
        label: `delete exact probe Pod ${name}`,
      },
    );
    if (result.status !== 0) cleanupFailures.push(name);
  }
  if (primaryError) throw primaryError;
  if (cleanupFailures.length > 0) {
    fail(`probe Pod cleanup failed for ${cleanupFailures.join(', ')}`);
  }
  return outcome;
}

function egressProbes(kubectl, snapshot) {
  for (const pod of snapshot.pods) {
    const result = kubectl.run(
      [
        '-n',
        NAMESPACE,
        'exec',
        pod.name,
        '-c',
        'management',
        '--',
        'node',
        '-e',
        EGRESS_PROBE_SCRIPT,
      ],
      {
        timeout: 30_000,
        label: `execute bounded egress probes in ${pod.name}`,
      },
    );
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      fail(`${pod.name} egress probe did not emit JSON`);
    }
    if (
      payload.ok !== true ||
      JSON.stringify(payload.results) !==
        JSON.stringify([
          {
            name: 'kubernetesApi',
            expected: 'timeout',
            outcome: 'timeout',
          },
          {
            name: 'publicInternet',
            expected: 'timeout',
            outcome: 'timeout',
          },
          {
            name: 'postgres',
            expected: 'connected',
            outcome: 'connected',
          },
        ])
    ) {
      fail(`${pod.name} egress isolation did not match the exact policy`);
    }
  }
  return Object.freeze({
    kubernetesApiEgressOutcome: 'timeout',
    publicInternetEgressOutcome: 'timeout',
    postgresEgressOutcome: 'postgres_ready',
  });
}

function requestCommand(action, operation, overrides = {}) {
  switch (operation) {
    case 'inspect':
      return {
        schemaVersion: 1,
        operation: 'plugin-package.inspect',
        request: {
          actionRef: action.actionRef,
          approvalRequestId: action.approvalRequestId,
          inspectionId: crypto.randomUUID(),
        },
      };
    case 'decide':
      return {
        schemaVersion: 1,
        operation: 'plugin-package.decide',
        request: {
          actionRef: action.actionRef,
          approvalRequestId: action.approvalRequestId,
          expectedVersion: action.approvalVersion,
          decisionId: action.decisionId,
          auditEventId: action.decisionAuditEventId,
          decision: 'approved',
          reasonCode: 'live_evidence_reviewed',
        },
      };
    case 'propose':
      return {
        schemaVersion: 1,
        operation: 'plugin-package.propose',
        request: {
          actionRef: action.actionRef,
          approvalRequestId: action.approvalRequestId,
          proposalAuditEventId: action.proposalAuditEventId,
          approvalAuditEventId: action.approvalAuditEventId,
          actionInput: overrides.actionInput,
        },
      };
    default:
      fail('management operation is invalid');
  }
}

function assertHttpFact(response, expected, snapshot, label) {
  if (
    response.status !== expected.status ||
    response.tlsProtocol !== 'TLSv1.3' ||
    normalizeSerial(response.tlsSerial) !== snapshot.tls.serial
  ) {
    fail(`${label} HTTP or TLS fact is invalid`);
  }
  if (expected.operation) {
    if (
      response.payload?.schemaVersion !== 1 ||
      response.payload?.result?.schemaVersion !== 1 ||
      response.payload.result.operation !== expected.operation
    ) {
      fail(`${label} success response is invalid`);
    }
  } else if (
    response.payload?.schemaVersion !== 1 ||
    response.payload?.error?.code !== expected.error
  ) {
    fail(`${label} error response is invalid`);
  }
  return response;
}

async function beforePhase(input, live) {
  const snapshot = await live.snapshot();
  const requester = assertionIdentity(
    input.requesterAssertion,
    snapshot.keyset,
    input.nowMs,
  );
  const reviewer = assertionIdentity(
    input.reviewerAssertion,
    snapshot.keyset,
    input.nowMs,
  );
  if (
    requester.subject === reviewer.subject ||
    !snapshot.keyset.activeKids.includes(requester.kid) ||
    !snapshot.keyset.activeKids.includes(reviewer.kid)
  ) {
    fail('before phase requires two distinct active strong Users');
  }
  const runId = crypto.randomUUID();
  const action = {
    actionRef: `ql3-live-evidence:${runId}`,
    approvalRequestId: crypto.randomUUID(),
    proposalAuditEventId: crypto.randomUUID(),
    approvalAuditEventId: crypto.randomUUID(),
    decisionAuditEventId: crypto.randomUUID(),
    decisionId: crypto.randomUUID(),
    approvalVersion: 0,
  };
  const proposal = assertHttpFact(
    await live.request(
      input.requesterAssertion,
      requestCommand(action, 'propose', { actionInput: input.actionInput }),
    ),
    { status: 200, operation: 'plugin-package.propose' },
    snapshot,
    'requester propose',
  );
  const approvalVersion = proposal.payload.result.approval?.version;
  if (!Number.isSafeInteger(approvalVersion) || approvalVersion < 1) {
    fail('proposal did not return a pending approval version');
  }
  action.approvalVersion = approvalVersion;
  const selfDecision = assertHttpFact(
    await live.request(
      input.requesterAssertion,
      requestCommand(action, 'decide'),
    ),
    { status: 403, error: 'forbidden' },
    snapshot,
    'requester self-decision',
  );
  const reviewerDecision = assertHttpFact(
    await live.request(
      input.reviewerAssertion,
      requestCommand(action, 'decide'),
    ),
    { status: 200, operation: 'plugin-package.decide' },
    snapshot,
    'reviewer decision',
  );
  if (reviewerDecision.payload.result.approval?.state !== 'approved') {
    fail('reviewer decision did not persist an approved state');
  }
  assertHttpFact(
    await live.request(
      input.reviewerAssertion,
      requestCommand(action, 'inspect'),
    ),
    { status: 200, operation: 'plugin-package.inspect' },
    snapshot,
    'reviewer inspection',
  );
  const isolation = await live.network(snapshot, runId);
  const recordedAt = new Date(input.nowMs).toISOString();
  return finalizeState({
    schemaVersion: 1,
    fixture: STATE_FIXTURE,
    phase: 'before',
    recordedAt,
    phaseObservedAt: [recordedAt],
    previousStateSha256: null,
    clusterIdentitySha256: snapshot.clusterIdentitySha256,
    endpoint: input.endpoint,
    action: Object.freeze({ ...action }),
    identity: {
      issuer: requester.issuer,
      audience: requester.audience,
      requesterSubject: requester.subject,
      reviewerSubject: reviewer.subject,
      requesterAssurance: requester.assurance,
      reviewerAssurance: reviewer.assurance,
      oldKid: requester.kid,
      newKid: null,
      overlapOldAssertionSha256: null,
      newAssertionSha256: null,
      keysetGenerations: [snapshot.keyset.document.generation],
    },
    ceremony: {
      proposalAuditEventId: action.proposalAuditEventId,
      approvalAuditEventId: action.approvalAuditEventId,
      decisionAuditEventId: action.decisionAuditEventId,
      proposeStatus: proposal.status,
      proposeOperation: proposal.payload.result.operation,
      selfDecisionStatus: selfDecision.status,
      selfDecisionError: selfDecision.payload.error.code,
      reviewerDecisionStatus: reviewerDecision.status,
      reviewerDecisionOperation: reviewerDecision.payload.result.operation,
      inspectionStatus: 200,
      inspectionOperation: 'plugin-package.inspect',
    },
    isolation,
    rotation: {
      overlapOldStatus: null,
      newStatus: null,
      revokedOldStatus: null,
      revokedOldError: null,
      previousTlsSerial: snapshot.tls.serial,
      currentTlsSerial: null,
      previousTlsSecretResourceVersion: snapshot.tls.resourceVersion,
      currentTlsSecretResourceVersion: null,
      readinessSamples: [readinessSample('before', snapshot)],
    },
  });
}

function assertSameLiveTarget(state, snapshot, endpoint) {
  if (
    state.clusterIdentitySha256 !== snapshot.clusterIdentitySha256 ||
    state.endpoint !== endpoint ||
    state.identity.issuer !== snapshot.keyset.document.issuer ||
    state.identity.audience !== snapshot.keyset.document.audience
  ) {
    fail('phase target changed cluster, endpoint or identity trust domain');
  }
}

async function overlapPhase(input, live) {
  const previous = validateState(input.state, 'before');
  const snapshot = await live.snapshot();
  assertSameLiveTarget(previous, snapshot, input.endpoint);
  const oldIdentity = assertionIdentity(
    input.oldAssertion,
    snapshot.keyset,
    input.nowMs,
  );
  const newIdentity = assertionIdentity(
    input.newAssertion,
    snapshot.keyset,
    input.nowMs,
  );
  if (
    oldIdentity.kid !== previous.identity.oldKid ||
    newIdentity.kid === previous.identity.oldKid ||
    !snapshot.keyset.activeKids.includes(oldIdentity.kid) ||
    !snapshot.keyset.activeKids.includes(newIdentity.kid) ||
    snapshot.keyset.document.generation <=
      previous.identity.keysetGenerations[0] ||
    snapshot.tls.serial === previous.rotation.previousTlsSerial ||
    snapshot.tls.resourceVersion ===
      previous.rotation.previousTlsSecretResourceVersion
  ) {
    fail('overlap phase does not contain two active key IDs and new TLS');
  }
  const oldResponse = assertHttpFact(
    await live.request(
      input.oldAssertion,
      requestCommand(previous.action, 'inspect'),
    ),
    { status: 200, operation: 'plugin-package.inspect' },
    snapshot,
    'overlap old assertion',
  );
  const newResponse = assertHttpFact(
    await live.request(
      input.newAssertion,
      requestCommand(previous.action, 'inspect'),
    ),
    { status: 200, operation: 'plugin-package.inspect' },
    snapshot,
    'overlap new assertion',
  );
  return finalizeState({
    ...previous,
    phase: 'overlap',
    recordedAt: new Date(input.nowMs).toISOString(),
    phaseObservedAt: [
      ...previous.phaseObservedAt,
      new Date(input.nowMs).toISOString(),
    ],
    previousStateSha256: previous.stateSha256,
    identity: {
      ...previous.identity,
      newKid: newIdentity.kid,
      overlapOldAssertionSha256: sha256(input.oldAssertion),
      newAssertionSha256: sha256(input.newAssertion),
      keysetGenerations: [
        ...previous.identity.keysetGenerations,
        snapshot.keyset.document.generation,
      ],
    },
    rotation: {
      ...previous.rotation,
      overlapOldStatus: oldResponse.status,
      newStatus: newResponse.status,
      currentTlsSerial: snapshot.tls.serial,
      currentTlsSecretResourceVersion: snapshot.tls.resourceVersion,
      readinessSamples: [
        ...previous.rotation.readinessSamples,
        readinessSample('overlap', snapshot),
      ],
    },
    stateSha256: '',
  });
}

async function revokedPhase(input, live) {
  const previous = validateState(input.state, 'overlap');
  const snapshot = await live.snapshot();
  assertSameLiveTarget(previous, snapshot, input.endpoint);
  const oldIdentity = assertionIdentity(
    input.oldAssertion,
    snapshot.keyset,
    input.nowMs,
  );
  const newIdentity = assertionIdentity(
    input.newAssertion,
    snapshot.keyset,
    input.nowMs,
  );
  if (
    oldIdentity.kid !== previous.identity.oldKid ||
    newIdentity.kid !== previous.identity.newKid ||
    sha256(input.oldAssertion) !==
      previous.identity.overlapOldAssertionSha256 ||
    sha256(input.newAssertion) !== previous.identity.newAssertionSha256 ||
    snapshot.keyset.activeKids.includes(oldIdentity.kid) ||
    !snapshot.keyset.revokedKids.includes(oldIdentity.kid) ||
    !snapshot.keyset.activeKids.includes(newIdentity.kid) ||
    snapshot.keyset.document.generation <=
      previous.identity.keysetGenerations[1] ||
    snapshot.tls.serial !== previous.rotation.currentTlsSerial ||
    snapshot.tls.resourceVersion !==
      previous.rotation.currentTlsSecretResourceVersion
  ) {
    fail('revoked phase does not prove append-only old-key revocation');
  }
  const oldResponse = assertHttpFact(
    await live.request(
      input.oldAssertion,
      requestCommand(previous.action, 'inspect'),
    ),
    { status: 401, error: 'authentication_required' },
    snapshot,
    'revoked old assertion',
  );
  assertHttpFact(
    await live.request(
      input.newAssertion,
      requestCommand(previous.action, 'inspect'),
    ),
    { status: 200, operation: 'plugin-package.inspect' },
    snapshot,
    'revoked new assertion',
  );
  return finalizeState({
    ...previous,
    phase: 'revoked',
    recordedAt: new Date(input.nowMs).toISOString(),
    phaseObservedAt: [
      ...previous.phaseObservedAt,
      new Date(input.nowMs).toISOString(),
    ],
    previousStateSha256: previous.stateSha256,
    identity: {
      ...previous.identity,
      keysetGenerations: [
        ...previous.identity.keysetGenerations,
        snapshot.keyset.document.generation,
      ],
    },
    rotation: {
      ...previous.rotation,
      revokedOldStatus: oldResponse.status,
      revokedOldError: oldResponse.payload.error.code,
      readinessSamples: [
        ...previous.rotation.readinessSamples,
        readinessSample('revoked', snapshot),
      ],
    },
    stateSha256: '',
  });
}

function exerciseFromState(state, nowMs = Date.now()) {
  const finalState = validateState(state, 'revoked');
  if (
    Date.parse(finalState.phaseObservedAt[0]) > nowMs + 5 * 60_000 ||
    nowMs - Date.parse(finalState.phaseObservedAt[0]) > 24 * 60 * 60_000 ||
    Date.parse(finalState.recordedAt) > nowMs + 5 * 60_000 ||
    nowMs - Date.parse(finalState.recordedAt) > 5 * 60_000
  ) {
    fail('exercise phase timeline is stale or in the future');
  }
  const exercise = {
    schemaVersion: 1,
    fixture: EXERCISE_FIXTURE,
    observedAt: new Date(nowMs).toISOString(),
    identity: {
      issuer: finalState.identity.issuer,
      audience: finalState.identity.audience,
      requesterSubject: finalState.identity.requesterSubject,
      reviewerSubject: finalState.identity.reviewerSubject,
      requesterAssurance: finalState.identity.requesterAssurance,
      reviewerAssurance: finalState.identity.reviewerAssurance,
      keysetGenerations: [...finalState.identity.keysetGenerations],
    },
    ceremony: { ...finalState.ceremony },
    isolation: { ...finalState.isolation },
    rotation: { ...finalState.rotation },
  };
  validateExercise(exercise, nowMs);
  return Object.freeze(exercise);
}

function liveAdapter(options) {
  const kubectl = createKubectl(options);
  return Object.freeze({
    snapshot: async () => managementSnapshot(kubectl),
    request: (assertion, command) =>
      managementRequest({
        endpoint: options.endpoint,
        ca: options.ca,
        assertion,
        command,
      }),
    async network(snapshot, runId) {
      const ingress = await ingressProbes(kubectl, snapshot, runId);
      const egress = egressProbes(kubectl, snapshot);
      return Object.freeze({ ...ingress, ...egress });
    },
  });
}

function parseFlags(argv, expected) {
  const values = new Map();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || !expected.includes(match[1]) || values.has(match[1])) {
      fail(`unknown or duplicate argument ${argument}`);
    }
    values.set(match[1], match[2]);
  }
  if (
    values.size !== expected.length ||
    expected.some((name) => !values.has(name))
  ) {
    fail(`required arguments are: ${expected.join(', ')}`);
  }
  return values;
}

function liveOptions(values) {
  const endpoint = values.get('endpoint');
  parseEndpoint(endpoint);
  return Object.freeze({
    kubeconfig: canonicalFile(values.get('kubeconfig'), 'Kubernetes config'),
    context: boundedToken(values.get('context'), 'Kubernetes context', 253),
    endpoint,
    ca: Buffer.from(
      readText(values.get('ca-file'), 'management TLS CA', {
        private: false,
      }),
    ),
  });
}

function readAssertion(values, name) {
  const assertion = readText(values.get(name), name.replaceAll('-', ' '), {
    maximum: MAX_ASSERTION_BYTES,
  });
  assertionEnvelope(assertion);
  return assertion;
}

function requireLiveMutationOptIn() {
  if (process.env.QL3_PLUGIN_PACKAGE_MANAGEMENT_LIVE_EXERCISE !== '1') {
    fail(
      'refusing live mutations without QL3_PLUGIN_PACKAGE_MANAGEMENT_LIVE_EXERCISE=1',
    );
  }
}

async function runCli(argv) {
  const [phase, ...args] = argv;
  if (!['before', 'overlap', 'revoked', 'finalize'].includes(phase)) {
    fail('phase must be before, overlap, revoked or finalize');
  }
  if (phase === 'finalize') {
    const values = parseFlags(args, ['input-state', 'output']);
    const state = readJson(values.get('input-state'), 'revoked exercise state');
    const output = unusedOutput(values.get('output'), 'exercise output');
    const exercise = exerciseFromState(state);
    writeNoReplace(output, exercise);
    return Object.freeze({
      schemaVersion: 1,
      fixture: EXERCISE_FIXTURE,
      phase,
      output,
      compatible: true,
    });
  }

  requireLiveMutationOptIn();
  const common = [
    'kubeconfig',
    'context',
    'endpoint',
    'ca-file',
    'output-state',
  ];
  const expected =
    phase === 'before'
      ? [...common, 'requester-assertion', 'reviewer-assertion', 'action-input']
      : [...common, 'input-state', 'old-assertion', 'new-assertion'];
  const values = parseFlags(args, expected);
  const options = liveOptions(values);
  const output = unusedOutput(values.get('output-state'), 'phase state output');
  const live = liveAdapter(options);
  const nowMs = Date.now();
  let state;
  if (phase === 'before') {
    state = await beforePhase(
      {
        endpoint: options.endpoint,
        requesterAssertion: readAssertion(values, 'requester-assertion'),
        reviewerAssertion: readAssertion(values, 'reviewer-assertion'),
        actionInput: readJson(
          values.get('action-input'),
          'Plugin Package evidence action input',
          { maximum: 256 * 1024 },
        ),
        nowMs,
      },
      live,
    );
  } else {
    const inputState = readJson(
      values.get('input-state'),
      `${phase} input state`,
    );
    const input = {
      endpoint: options.endpoint,
      state: inputState,
      oldAssertion: readAssertion(values, 'old-assertion'),
      newAssertion: readAssertion(values, 'new-assertion'),
      nowMs,
    };
    state =
      phase === 'overlap'
        ? await overlapPhase(input, live)
        : await revokedPhase(input, live);
  }
  writeNoReplace(output, state);
  return Object.freeze({
    schemaVersion: 1,
    fixture: STATE_FIXTURE,
    phase,
    stateSha256: state.stateSha256,
    output,
  });
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    },
    (error) => {
      process.stderr.write(
        `${
          error instanceof Error ? error.message : 'unknown live exercise error'
        }\n`,
      );
      process.exitCode = 1;
    },
  );
}

module.exports = {
  EXERCISE_FIXTURE,
  PluginPackageManagementLiveExerciseError,
  STATE_FIXTURE,
  assertionIdentity,
  beforePhase,
  exerciseFromState,
  finalizeState,
  ingressProbes,
  normalizeSerial,
  overlapPhase,
  probePod,
  revokedPhase,
  runCli,
  stateDigest,
  validateKeyset,
  validateState,
};
