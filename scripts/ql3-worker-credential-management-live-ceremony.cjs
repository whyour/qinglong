#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const FIXTURE = 'qinglong/worker-credential-management-live-ceremony@v1';
const TYPE = 'ql3-worker-credential-management+jwt';
const PURPOSE = 'worker-credential-management';
const AUDIENCE = 'qinglong3-worker-credential-management';
const MAX_FILE_BYTES = 1024 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BANNED_KEYS = new Set([
  'assertion',
  'authorization',
  'bearer',
  'connectionstring',
  'dsn',
  'password',
  'privatekey',
  'secret',
  'tlskey',
  'token',
]);

class WorkerCredentialManagementLiveCeremonyError extends Error {
  constructor(message) {
    super(`Worker credential management live ceremony failed: ${message}`);
    this.name = 'WorkerCredentialManagementLiveCeremonyError';
  }
}

function fail(message) {
  throw new WorkerCredentialManagementLiveCeremonyError(message);
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

function sha256(domain, value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex')}`;
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
      `${label} must be a canonical bounded ${
        privateFile ? 'private ' : ''
      }file`,
    );
  }
  return filePath;
}

function readPrivateText(filePath, label, maximum = MAX_FILE_BYTES) {
  canonicalFile(filePath, label, { maximum });
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
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  } catch (error) {
    if (error instanceof WorkerCredentialManagementLiveCeremonyError) {
      throw error;
    }
    fail(`${label} could not be read safely`);
  } finally {
    bytes?.fill(0);
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function readPrivateJson(filePath, label) {
  try {
    return JSON.parse(readPrivateText(filePath, label));
  } catch (error) {
    if (error instanceof WorkerCredentialManagementLiveCeremonyError) {
      throw error;
    }
    fail(`${label} must contain JSON`);
  }
}

function parseSegment(value, label, maximum) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    fail(`${label} encoding is invalid`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.length < 2 ||
    bytes.length > maximum ||
    bytes.toString('base64url') !== value
  ) {
    fail(`${label} encoding is invalid`);
  }
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(`${label} must be an object`);
    }
    return value;
  } catch (error) {
    if (error instanceof WorkerCredentialManagementLiveCeremonyError) {
      throw error;
    }
    fail(`${label} JSON is invalid`);
  }
}

function assertionIdentity(assertion, nowMs) {
  if (
    typeof assertion !== 'string' ||
    assertion.length > 16 * 1024 ||
    CONTROL_PATTERN.test(assertion)
  ) {
    fail('identity assertion is invalid');
  }
  const segments = assertion.split('.');
  if (segments.length !== 3)
    fail('identity assertion compact shape is invalid');
  if (
    !BASE64URL_PATTERN.test(segments[2]) ||
    Buffer.from(segments[2], 'base64url').length < 32 ||
    Buffer.from(segments[2], 'base64url').length > 512 ||
    Buffer.from(segments[2], 'base64url').toString('base64url') !== segments[2]
  ) {
    fail('identity signature encoding is invalid');
  }
  const header = parseSegment(segments[0], 'identity header', 1024);
  exactObject(header, ['alg', 'kid', 'typ'], 'identity header');
  const claims = parseSegment(segments[1], 'identity claims', 8 * 1024);
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
  exactObject(claims, claimKeys, 'identity claims');
  const now = Math.floor(nowMs / 1000);
  if (
    header.typ !== TYPE ||
    typeof header.alg !== 'string' ||
    header.alg === 'none' ||
    !TOKEN_PATTERN.test(header.kid) ||
    claims.aud !== AUDIENCE ||
    claims.ql3_purpose !== PURPOSE ||
    !externalIssuer(claims.iss) ||
    !TOKEN_PATTERN.test(claims.sub) ||
    !TOKEN_PATTERN.test(claims.jti) ||
    typeof claims.acr !== 'string' ||
    claims.acr.length < 1 ||
    claims.acr.length > 256 ||
    CONTROL_PATTERN.test(claims.acr) ||
    !Array.isArray(claims.amr) ||
    claims.amr.length < 1 ||
    claims.amr.length > 8 ||
    claims.amr.some((value) => !TOKEN_PATTERN.test(value)) ||
    new Set(claims.amr).size !== claims.amr.length ||
    ![claims.iat, claims.auth_time, claims.exp].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    claims.exp <= now ||
    claims.iat > now + 60 ||
    claims.auth_time > now + 60 ||
    claims.exp - claims.iat < 30 ||
    claims.exp - claims.iat > 15 * 60 ||
    now - claims.auth_time > 15 * 60 ||
    (claims.nbf !== undefined &&
      (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 60))
  ) {
    fail(
      'identity assertion does not bind one live strong Worker management identity',
    );
  }
  return Object.freeze({
    issuer: claims.iss,
    subject: claims.sub,
    jti: claims.jti,
    kid: header.kid,
    acr: claims.acr,
    amr: Object.freeze([...claims.amr]),
  });
}

function ceremonyCommands(value, normalize) {
  exactObject(
    value,
    [
      'schemaVersion',
      'planRequest',
      'approvalRequestId',
      'approvalAuditEventId',
      'requesterDecisionId',
      'requesterDecisionAuditEventId',
      'reviewerDecisionId',
      'reviewerDecisionAuditEventId',
      'decisionReasonCode',
      'inspectionId',
    ],
    'ceremony',
  );
  if (value.schemaVersion !== 1) fail('ceremony schemaVersion is invalid');
  for (const name of [
    'approvalRequestId',
    'approvalAuditEventId',
    'requesterDecisionId',
    'requesterDecisionAuditEventId',
    'reviewerDecisionId',
    'reviewerDecisionAuditEventId',
    'decisionReasonCode',
    'inspectionId',
  ]) {
    if (!TOKEN_PATTERN.test(value[name])) fail(`ceremony ${name} is invalid`);
  }
  if (
    value.requesterDecisionId === value.reviewerDecisionId ||
    value.requesterDecisionAuditEventId === value.reviewerDecisionAuditEventId
  ) {
    fail('requester and reviewer decision identities must be distinct');
  }
  const shared = {
    actionRef: value.planRequest?.actionRef,
    authorityProjectId: value.planRequest?.authorityProjectId,
    approvalRequestId: value.approvalRequestId,
  };
  const commands = {
    plan: {
      schemaVersion: 1,
      operation: 'worker-credential.plan',
      request: value.planRequest,
    },
    propose: {
      schemaVersion: 1,
      operation: 'worker-credential.propose',
      request: {
        ...shared,
        approvalAuditEventId: value.approvalAuditEventId,
      },
    },
    requesterDecide: {
      schemaVersion: 1,
      operation: 'worker-credential.decide',
      request: {
        ...shared,
        expectedVersion: 1,
        decisionId: value.requesterDecisionId,
        auditEventId: value.requesterDecisionAuditEventId,
        decision: 'approved',
        reasonCode: value.decisionReasonCode,
      },
    },
    reviewerDecide: {
      schemaVersion: 1,
      operation: 'worker-credential.decide',
      request: {
        ...shared,
        expectedVersion: 1,
        decisionId: value.reviewerDecisionId,
        auditEventId: value.reviewerDecisionAuditEventId,
        decision: 'approved',
        reasonCode: value.decisionReasonCode,
      },
    },
    inspect: {
      schemaVersion: 1,
      operation: 'worker-credential.inspect',
      request: { ...shared, inspectionId: value.inspectionId },
    },
  };
  for (const command of Object.values(commands)) normalize(command);
  return Object.freeze(commands);
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

function validateWorkerCredentialManagementLiveCeremony(report) {
  const findings = [];
  const add = (code) => findings.push(Object.freeze({ code }));
  if (
    !report ||
    typeof report !== 'object' ||
    Array.isArray(report) ||
    JSON.stringify(Object.keys(report).sort()) !==
      JSON.stringify(
        [
          'schemaVersion',
          'fixture',
          'observedAt',
          'identity',
          'ceremony',
          'gates',
        ].sort(),
      ) ||
    report.schemaVersion !== 1 ||
    report.fixture !== FIXTURE ||
    !isIsoTime(report.observedAt)
  ) {
    add('QL3_WORKER_MANAGEMENT_LIVE_CEREMONY_SHAPE');
  }
  const identity = report?.identity;
  if (
    !exactKeys(identity, [
      'providerKind',
      'issuer',
      'discoveryDocumentSha256',
      'jwksSha256',
      'audience',
      'type',
      'purpose',
      'requesterSubjectSha256',
      'reviewerSubjectSha256',
      'requesterKeyIdSha256',
      'reviewerKeyIdSha256',
    ]) ||
    !externalIssuer(identity.issuer) ||
    identity.providerKind !== 'external_oidc' ||
    identity.audience !== AUDIENCE ||
    identity.type !== TYPE ||
    identity.purpose !== PURPOSE ||
    !SHA256_PATTERN.test(identity.discoveryDocumentSha256) ||
    !SHA256_PATTERN.test(identity.jwksSha256) ||
    !SHA256_PATTERN.test(identity.requesterSubjectSha256) ||
    !SHA256_PATTERN.test(identity.reviewerSubjectSha256) ||
    identity.requesterSubjectSha256 === identity.reviewerSubjectSha256 ||
    !SHA256_PATTERN.test(identity.requesterKeyIdSha256) ||
    !SHA256_PATTERN.test(identity.reviewerKeyIdSha256)
  ) {
    add('QL3_WORKER_MANAGEMENT_LIVE_CEREMONY_IDENTITY');
  }
  const ceremony = report?.ceremony;
  if (
    !exactKeys(ceremony, [
      'actionRefSha256',
      'authorityProjectIdSha256',
      'planStatus',
      'approvalStatus',
      'requesterSelfDecisionStatus',
      'requesterSelfDecisionCode',
      'reviewerDecisionStatus',
      'approvalState',
      'inspectionStale',
      'dispatchCreated',
      'approvalConsumed',
      'planDigest',
      'previewDigest',
      'requestIdSha256',
    ]) ||
    !['created', 'existing'].includes(ceremony.planStatus) ||
    !['created', 'existing'].includes(ceremony.approvalStatus) ||
    ceremony.requesterSelfDecisionStatus !== 403 ||
    ceremony.requesterSelfDecisionCode !== 'forbidden' ||
    !['decided', 'existing'].includes(ceremony.reviewerDecisionStatus) ||
    ceremony.approvalState !== 'approved' ||
    ceremony.inspectionStale !== false ||
    ceremony.dispatchCreated !== false ||
    ceremony.approvalConsumed !== false ||
    !SHA256_PATTERN.test(ceremony.actionRefSha256) ||
    !SHA256_PATTERN.test(ceremony.authorityProjectIdSha256) ||
    !/^[a-f0-9]{64}$/.test(ceremony.planDigest) ||
    !/^[a-f0-9]{64}$/.test(ceremony.previewDigest) ||
    !Array.isArray(ceremony.requestIdSha256) ||
    ceremony.requestIdSha256.length !== 5 ||
    ceremony.requestIdSha256.some((value) => !SHA256_PATTERN.test(value)) ||
    new Set(ceremony.requestIdSha256).size !== 5
  ) {
    add('QL3_WORKER_MANAGEMENT_LIVE_CEREMONY_FLOW');
  }
  const gates = report?.gates;
  if (
    !exactKeys(gates, [
      'externalIdentity',
      'workerPurposeBound',
      'requesterAndReviewerDistinct',
      'requesterSelfDecisionRejected',
      'reviewerDecisionAccepted',
      'inspectionAuthorized',
      'noExecutionOrConsumption',
      'passed',
    ]) ||
    Object.values(gates).some((value) => value !== true)
  ) {
    add('QL3_WORKER_MANAGEMENT_LIVE_CEREMONY_GATES');
  }
  if (containsSensitiveMaterial(report)) {
    add('QL3_WORKER_MANAGEMENT_LIVE_CEREMONY_SECRET_EXPOSURE');
  }
  return Object.freeze({
    compatible: findings.length === 0,
    findings: Object.freeze(findings),
  });
}

function unusedOutput(filePath) {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    fs.existsSync(filePath) ||
    fs.realpathSync(path.dirname(filePath)) !== path.dirname(filePath)
  ) {
    fail('output must be one unused canonical absolute path');
  }
  return filePath;
}

function writeNoReplace(filePath, report) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function withCommandFile(command, run) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-worker-ceremony-')),
  );
  fs.chmodSync(directory, 0o700);
  const commandFile = path.join(directory, 'command.json');
  try {
    fs.writeFileSync(commandFile, `${JSON.stringify(command)}\n`, {
      mode: 0o600,
    });
    return await run(commandFile);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function runWorkerCredentialManagementLiveCeremony(
  options,
  dependencies = {},
) {
  exactObject(
    options,
    [
      'configFile',
      'requesterAssertionFile',
      'reviewerAssertionFile',
      'ceremonyFile',
      'outputFile',
    ],
    'options',
  );
  unusedOutput(options.outputFile);
  canonicalFile(options.configFile, 'client config');
  const now = dependencies.now ?? Date.now;
  let requesterRaw = readPrivateText(
    options.requesterAssertionFile,
    'requester identity assertion',
    16 * 1024,
  );
  let reviewerRaw = readPrivateText(
    options.reviewerAssertionFile,
    'reviewer identity assertion',
    16 * 1024,
  );
  const requester = assertionIdentity(requesterRaw, now());
  const reviewer = assertionIdentity(reviewerRaw, now());
  if (
    requester.issuer !== reviewer.issuer ||
    requester.subject === reviewer.subject
  ) {
    fail('requester and reviewer must be distinct Users from one issuer');
  }
  const normalize =
    dependencies.normalize ??
    require('@qinglong/cluster-admin/worker-credential-management-transport')
      .normalizeClusterWorkerCredentialManagementCommand;
  const commands = ceremonyCommands(
    readPrivateJson(options.ceremonyFile, 'ceremony'),
    normalize,
  );
  const collectOidc =
    dependencies.collectOidc ??
    require('./ql3-plugin-package-management-live-evidence-collect.cjs')
      .collectOidcSnapshot;
  const oidc = await collectOidc({ issuer: requester.issuer });
  const execute =
    dependencies.execute ??
    require('@qinglong/cluster-admin/worker-credential-management-client')
      .executeClusterWorkerCredentialManagementClient;
  const invoke = (command, assertionFile) =>
    withCommandFile(command, (commandFile) =>
      execute({ configFile: options.configFile, commandFile, assertionFile }),
    );

  const plan = await invoke(commands.plan, options.requesterAssertionFile);
  const proposed = await invoke(
    commands.propose,
    options.requesterAssertionFile,
  );
  let selfDecision;
  try {
    await invoke(commands.requesterDecide, options.requesterAssertionFile);
    fail('requester self-decision was accepted');
  } catch (error) {
    if (
      error instanceof WorkerCredentialManagementLiveCeremonyError ||
      error?.statusCode !== 403 ||
      error?.responseCode !== 'forbidden' ||
      typeof error?.requestId !== 'string'
    ) {
      throw error;
    }
    selfDecision = error;
  }
  const decided = await invoke(
    commands.reviewerDecide,
    options.reviewerAssertionFile,
  );
  const inspected = await invoke(
    commands.inspect,
    options.reviewerAssertionFile,
  );

  const planValue = plan.result.plan;
  const proposedApproval = proposed.result.approval;
  const decidedApproval = decided.result.approval;
  const inspectedApproval = inspected.result.approval;
  if (
    planValue.requestedBy?.id !== requester.subject ||
    proposed.result.plan.planDigest !== planValue.planDigest ||
    proposedApproval.requestedBy?.id !== requester.subject ||
    proposedApproval.version !== 1 ||
    proposedApproval.state !== 'pending' ||
    proposedApproval.actionDigest !== planValue.planDigest ||
    proposedApproval.previewDigest !== planValue.previewDigest ||
    decidedApproval.requestedBy?.id !== requester.subject ||
    decidedApproval.decidedBy?.id !== reviewer.subject ||
    decidedApproval.state !== 'approved' ||
    inspected.result.stale !== false ||
    !inspectedApproval ||
    inspectedApproval.state !== 'approved' ||
    inspectedApproval.decidedBy?.id !== reviewer.subject ||
    inspectedApproval.dispatchId !== null ||
    inspectedApproval.consumedAtMs !== null
  ) {
    fail(
      'management results do not prove the reviewed separation-of-duty flow',
    );
  }
  const report = Object.freeze({
    schemaVersion: 1,
    fixture: FIXTURE,
    observedAt: new Date(now()).toISOString(),
    identity: Object.freeze({
      providerKind: 'external_oidc',
      issuer: requester.issuer,
      discoveryDocumentSha256: oidc.discoveryDocumentSha256,
      jwksSha256: oidc.jwksSha256,
      audience: AUDIENCE,
      type: TYPE,
      purpose: PURPOSE,
      requesterSubjectSha256: sha256(
        'qinglong3.worker-management.subject.v1',
        requester.subject,
      ),
      reviewerSubjectSha256: sha256(
        'qinglong3.worker-management.subject.v1',
        reviewer.subject,
      ),
      requesterKeyIdSha256: sha256(
        'qinglong3.worker-management.kid.v1',
        requester.kid,
      ),
      reviewerKeyIdSha256: sha256(
        'qinglong3.worker-management.kid.v1',
        reviewer.kid,
      ),
    }),
    ceremony: Object.freeze({
      actionRefSha256: sha256(
        'qinglong3.worker-management.action-ref.v1',
        planValue.actionRef,
      ),
      authorityProjectIdSha256: sha256(
        'qinglong3.worker-management.project.v1',
        planValue.authorityProjectId,
      ),
      planStatus: plan.result.status,
      approvalStatus: proposed.result.approvalStatus,
      requesterSelfDecisionStatus: 403,
      requesterSelfDecisionCode: 'forbidden',
      reviewerDecisionStatus: decided.result.status,
      approvalState: inspectedApproval.state,
      inspectionStale: inspected.result.stale,
      dispatchCreated: inspectedApproval.dispatchId !== null,
      approvalConsumed: inspectedApproval.consumedAtMs !== null,
      planDigest: planValue.planDigest,
      previewDigest: planValue.previewDigest,
      requestIdSha256: Object.freeze(
        [
          plan.requestId,
          proposed.requestId,
          selfDecision.requestId,
          decided.requestId,
          inspected.requestId,
        ].map((value) =>
          sha256('qinglong3.worker-management.request-id.v1', value),
        ),
      ),
    }),
    gates: Object.freeze({
      externalIdentity: true,
      workerPurposeBound: true,
      requesterAndReviewerDistinct: true,
      requesterSelfDecisionRejected: true,
      reviewerDecisionAccepted: true,
      inspectionAuthorized: true,
      noExecutionOrConsumption: true,
      passed: true,
    }),
  });
  const audit = validateWorkerCredentialManagementLiveCeremony(report);
  if (!audit.compatible) {
    fail(
      `assembled report failed audit: ${audit.findings
        .map(({ code }) => code)
        .join(',')}`,
    );
  }
  writeNoReplace(options.outputFile, report);
  requesterRaw = undefined;
  reviewerRaw = undefined;
  return report;
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
  const keys = [
    'config',
    'requester-assertion',
    'reviewer-assertion',
    'ceremony',
    'output',
  ];
  if (
    JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(keys.sort())
  ) {
    fail('arguments are invalid');
  }
  return Object.freeze({
    configFile: values.config,
    requesterAssertionFile: values['requester-assertion'],
    reviewerAssertionFile: values['reviewer-assertion'],
    ceremonyFile: values.ceremony,
    outputFile: values.output,
  });
}

async function runCli(argv) {
  if (process.env.QL3_WORKER_CREDENTIAL_MANAGEMENT_LIVE_CEREMONY !== '1') {
    fail('explicit live ceremony opt-in is required');
  }
  await runWorkerCredentialManagementLiveCeremony(parseArguments(argv));
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      fixture: FIXTURE,
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
          : 'Worker credential management live ceremony failed'
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  FIXTURE,
  WorkerCredentialManagementLiveCeremonyError,
  assertionIdentity,
  ceremonyCommands,
  parseArguments,
  runWorkerCredentialManagementLiveCeremony,
  validateWorkerCredentialManagementLiveCeremony,
};
