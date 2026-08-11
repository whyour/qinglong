#!/usr/bin/env node

'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const {
  FIXTURE: CEREMONY_FIXTURE,
  validateWorkerCredentialManagementLiveCeremony,
} = require('./ql3-worker-credential-management-live-ceremony.cjs');
const {
  FIXTURE: DURABLE_FIXTURE,
  validateWorkerCredentialManagementDurableAuditEvidence,
} = require('./ql3-worker-credential-management-durable-audit-evidence.cjs');
const {
  FIXTURE: PKI_FIXTURE,
  validateWorkerCredentialManagementPkiRotationEvidence,
} = require('./ql3-worker-credential-management-pki-rotation-evidence.cjs');
const {
  FIXTURE: CA_ROLLOVER_FIXTURE,
  validateWorkerCredentialManagementCaRolloverEvidence,
} = require('./ql3-worker-credential-management-ca-rollover-evidence.cjs');

const FIXTURE = 'qinglong/worker-credential-management-release-evidence@v1';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_FILE_BYTES = 1024 * 1024;
const BANNED_KEYS = new Set([
  'assertion',
  'authorization',
  'bearer',
  'certificate',
  'connectionstring',
  'crl',
  'dsn',
  'kubeconfig',
  'password',
  'privatekey',
  'secret',
  'tlskey',
  'token',
]);

class WorkerCredentialManagementReleaseEvidenceError extends Error {
  constructor(message) {
    super(`Worker management release evidence failed: ${message}`);
    this.name = 'WorkerCredentialManagementReleaseEvidenceError';
  }
}

function fail(message) {
  throw new WorkerCredentialManagementReleaseEvidenceError(message);
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

function exactObject(value, keys, label) {
  if (!exactKeys(value, keys)) fail(`${label} shape is invalid`);
  return value;
}

function rawDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isIsoTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function externalIssuer(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      net.isIP(parsed.hostname) === 0 &&
      parsed.hostname !== 'localhost' &&
      !parsed.hostname.endsWith('.localhost') &&
      !parsed.hostname.endsWith('.local') &&
      !parsed.hostname.endsWith('.test') &&
      !parsed.hostname.endsWith('.invalid') &&
      !parsed.hostname.endsWith('.example')
    );
  } catch {
    return false;
  }
}

function containsSensitiveMaterial(value) {
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveMaterial(entry));
  }
  if (!value || typeof value !== 'object') return false;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
    if (BANNED_KEYS.has(normalized)) return true;
    if (containsSensitiveMaterial(entry)) return true;
  }
  return false;
}

function canonicalFile(filePath, label) {
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
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > MAX_FILE_BYTES ||
    uid === null ||
    stat.uid !== uid ||
    (stat.mode & 0o077) !== 0 ||
    fs.realpathSync(filePath) !== filePath
  ) {
    fail(`${label} must be one canonical owner-private bounded file`);
  }
  return stat;
}

function readDocument(filePath, label) {
  const before = canonicalFile(filePath, label);
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
    let value;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      fail(`${label} must contain UTF-8 JSON`);
    }
    return Object.freeze({ bytes, value });
  } catch (error) {
    if (error instanceof WorkerCredentialManagementReleaseEvidenceError) {
      throw error;
    }
    fail(`${label} could not be read safely`);
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function unusedOutput(filePath) {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    filePath.length > 4096 ||
    CONTROL_PATTERN.test(filePath) ||
    fs.existsSync(filePath) ||
    fs.realpathSync(path.dirname(filePath)) !== path.dirname(filePath)
  ) {
    fail('output path must be unused in one canonical directory');
  }
}

function writeNoReplace(filePath, value) {
  unusedOutput(filePath);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  let descriptor = -1;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_CLOEXEC ?? 0) |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) fail('release evidence could not be written completely');
      offset += count;
    }
    fs.fsyncSync(descriptor);
  } finally {
    bytes.fill(0);
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function readSourceDocuments(options) {
  const documents = {};
  try {
    documents.ceremony = readDocument(
      options.ceremonyReportFile,
      'ceremony report',
    );
    documents.durable = readDocument(
      options.durableAuditReportFile,
      'durable audit report',
    );
    documents.pki = readDocument(
      options.pkiRotationReportFile,
      'PKI rotation report',
    );
    documents.caRollover = readDocument(
      options.caRolloverReportFile,
      'CA rollover report',
    );
    return Object.freeze(documents);
  } catch (error) {
    for (const document of Object.values(documents)) document.bytes.fill(0);
    throw error;
  }
}

function clearSourceDocuments(documents) {
  for (const document of Object.values(documents)) document.bytes.fill(0);
}

function sourceAudits(documents) {
  return [
    validateWorkerCredentialManagementLiveCeremony(
      documents.ceremony.value,
    ),
    validateWorkerCredentialManagementDurableAuditEvidence(
      documents.durable.value,
    ),
    validateWorkerCredentialManagementPkiRotationEvidence(
      documents.pki.value,
    ),
    validateWorkerCredentialManagementCaRolloverEvidence(
      documents.caRollover.value,
    ),
  ];
}

function verifySourceDocuments(documents) {
  if (sourceAudits(documents).some(({ compatible }) => !compatible)) {
    fail('one or more source reports are incompatible');
  }
  const ceremony = documents.ceremony.value;
  const durable = documents.durable.value;
  const pki = documents.pki.value;
  const caRollover = documents.caRollover.value;
  const observed = [ceremony, durable, pki, caRollover].map(({ observedAt }) =>
    Date.parse(observedAt),
  );
  if (
    observed[1] < observed[0] ||
    observed[2] < observed[1] ||
    observed[3] < observed[1]
  ) {
    fail('source report observation order is invalid');
  }
  const ceremonySha256 = rawDigest(documents.ceremony.bytes);
  const durableSha256 = rawDigest(documents.durable.bytes);
  if (
    durable.source.ceremonyReportSha256 !== ceremonySha256 ||
    pki.source.ceremonyReportSha256 !== ceremonySha256 ||
    caRollover.source.ceremonyReportSha256 !== ceremonySha256 ||
    pki.source.durableAuditReportSha256 !== durableSha256 ||
    caRollover.source.durableAuditReportSha256 !== durableSha256
  ) {
    fail('source report digest chain is not exact');
  }
  if (
    durable.durableState.actionRefSha256 !==
      ceremony.ceremony.actionRefSha256 ||
    durable.durableState.authorityProjectIdSha256 !==
      ceremony.ceremony.authorityProjectIdSha256 ||
    durable.durableState.planDigest !== ceremony.ceremony.planDigest ||
    durable.durableState.previewDigest !== ceremony.ceremony.previewDigest ||
    durable.durableState.requesterSubjectSha256 !==
      ceremony.identity.requesterSubjectSha256 ||
    durable.durableState.reviewerSubjectSha256 !==
      ceremony.identity.reviewerSubjectSha256
  ) {
    fail('durable review state is not bound to the ceremony');
  }
  const operatorSubjects = [
    ceremony.identity.requesterSubjectSha256,
    ceremony.identity.reviewerSubjectSha256,
  ];
  for (const identity of [pki.identity, caRollover.identity]) {
    if (
      identity.providerKind !== ceremony.identity.providerKind ||
      identity.issuer !== ceremony.identity.issuer ||
      identity.audience !== ceremony.identity.audience ||
      identity.type !== ceremony.identity.type ||
      identity.purpose !== ceremony.identity.purpose ||
      !operatorSubjects.includes(identity.subjectSha256)
    ) {
      fail('source report identity does not match the reviewed ceremony');
    }
  }
  if (pki.identity.subjectSha256 !== caRollover.identity.subjectSha256) {
    fail('source reports were not collected by one reviewed operator');
  }
  if (
    pki.transport.endpointSha256 !==
      caRollover.transport.endpointSha256 ||
    pki.transport.servernameSha256 !==
      caRollover.transport.servernameSha256 ||
    pki.transport.serverTrustBundleSha256 !==
      caRollover.transport.serverTrustBundleSha256 ||
    pki.transport.commandSha256 !== caRollover.transport.commandSha256
  ) {
    fail('source report management transport is not identical');
  }
  if (
    pki.kubernetes.clusterServerSha256 !==
      caRollover.kubernetes.clusterServerSha256 ||
    pki.kubernetes.collectorSubjectSha256 !==
      caRollover.kubernetes.collectorSubjectSha256 ||
    pki.kubernetes.deploymentUidSha256 !==
      caRollover.kubernetes.deploymentUidSha256
  ) {
    fail('source report Kubernetes authority is not identical');
  }
  return Object.freeze({
    ceremony,
    durable,
    pki,
    caRollover,
    digests: Object.freeze({
      ceremony: ceremonySha256,
      durable: durableSha256,
      pki: rawDigest(documents.pki.bytes),
      caRollover: rawDigest(documents.caRollover.bytes),
    }),
  });
}

function buildReleaseEvidence(facts, observedAt) {
  const { ceremony, durable, pki, caRollover, digests } = facts;
  return Object.freeze({
    schemaVersion: 1,
    fixture: FIXTURE,
    observedAt,
    source: Object.freeze({
      ceremonyReportSha256: digests.ceremony,
      durableAuditReportSha256: digests.durable,
      pkiRotationReportSha256: digests.pki,
      caRolloverReportSha256: digests.caRollover,
      ceremonyFixture: CEREMONY_FIXTURE,
      durableAuditFixture: DURABLE_FIXTURE,
      pkiRotationFixture: PKI_FIXTURE,
      caRolloverFixture: CA_ROLLOVER_FIXTURE,
    }),
    authority: Object.freeze({
      providerKind: ceremony.identity.providerKind,
      issuer: ceremony.identity.issuer,
      audience: ceremony.identity.audience,
      type: ceremony.identity.type,
      purpose: ceremony.identity.purpose,
      requesterSubjectSha256: ceremony.identity.requesterSubjectSha256,
      reviewerSubjectSha256: ceremony.identity.reviewerSubjectSha256,
      operatorSubjectSha256: pki.identity.subjectSha256,
      actionRefSha256: ceremony.ceremony.actionRefSha256,
      authorityProjectIdSha256:
        ceremony.ceremony.authorityProjectIdSha256,
      planDigest: ceremony.ceremony.planDigest,
      previewDigest: ceremony.ceremony.previewDigest,
    }),
    transport: Object.freeze({
      endpointSha256: pki.transport.endpointSha256,
      servernameSha256: pki.transport.servernameSha256,
      serverTrustBundleSha256: pki.transport.serverTrustBundleSha256,
      commandSha256: pki.transport.commandSha256,
    }),
    deployment: Object.freeze({
      clusterServerSha256: pki.kubernetes.clusterServerSha256,
      collectorSubjectSha256: pki.kubernetes.collectorSubjectSha256,
      deploymentUidSha256: pki.kubernetes.deploymentUidSha256,
      pkiGenerations: Object.freeze([
        pki.kubernetes.beforeGeneration,
        pki.kubernetes.afterGeneration,
      ]),
      caRolloverGenerations: caRollover.kubernetes.generations,
      pkiPodsFullyReplaced: pki.kubernetes.oldPodsFullyReplaced,
      caRolloverPodsFullyReplaced:
        caRollover.kubernetes.allGenerationsFullyReplaced,
      twoReadyReplicasOnDistinctNodes: true,
    }),
    controls: Object.freeze({
      externalCeremonyObserved: ceremony.gates.passed,
      durableAuditObserved: durable.gates.passed,
      sameIssuerRevocationObserved: pki.gates.passed,
      caRolloverObserved: caRollover.gates.passed,
      serverAndClientTrustSeparated:
        pki.gates.serverTrustSeparatedFromClientIssuer &&
        caRollover.gates.serverTrustSeparatedFromClientIssuer,
      noExecutionOrConsumption:
        ceremony.gates.noExecutionOrConsumption &&
        durable.gates.noExecutionOrConsumption,
      exactReadOnlyCollectorAuthority:
        pki.gates.readOnlyCollectorAuthority &&
        caRollover.gates.readOnlyCollectorAuthority,
    }),
    gates: Object.freeze({
      sourceReportsCompatible: true,
      sourceDigestChainBound: true,
      externalIdentityBound: true,
      reviewedDurableStateBound: true,
      managementTransportBound: true,
      deploymentAuthorityBound: true,
      sameIssuerRevocationObserved: true,
      clientCaRolloverObserved: true,
      serverAndClientTrustSeparated: true,
      noExecutionOrConsumption: true,
      readOnlyEvidenceAuthority: true,
      passed: true,
    }),
  });
}

function validIncreasingIntegers(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => Number.isSafeInteger(entry) && entry >= 1) &&
    value.every((entry, index) => index === 0 || value[index - 1] < entry)
  );
}

function validateWorkerCredentialManagementReleaseEvidence(report) {
  const findings = [];
  const add = (code) => findings.push(Object.freeze({ code }));
  if (
    !exactKeys(report, [
      'schemaVersion',
      'fixture',
      'observedAt',
      'source',
      'authority',
      'transport',
      'deployment',
      'controls',
      'gates',
    ]) ||
    report?.schemaVersion !== 1 ||
    report?.fixture !== FIXTURE ||
    !isIsoTime(report?.observedAt)
  ) {
    add('QL3_WORKER_MANAGEMENT_RELEASE_EVIDENCE_SHAPE');
  }
  const source = report?.source;
  if (
    !exactKeys(source, [
      'ceremonyReportSha256',
      'durableAuditReportSha256',
      'pkiRotationReportSha256',
      'caRolloverReportSha256',
      'ceremonyFixture',
      'durableAuditFixture',
      'pkiRotationFixture',
      'caRolloverFixture',
    ]) ||
    ![
      source?.ceremonyReportSha256,
      source?.durableAuditReportSha256,
      source?.pkiRotationReportSha256,
      source?.caRolloverReportSha256,
    ].every((entry) => SHA256_PATTERN.test(entry)) ||
    source?.ceremonyFixture !== CEREMONY_FIXTURE ||
    source?.durableAuditFixture !== DURABLE_FIXTURE ||
    source?.pkiRotationFixture !== PKI_FIXTURE ||
    source?.caRolloverFixture !== CA_ROLLOVER_FIXTURE
  ) {
    add('QL3_WORKER_MANAGEMENT_RELEASE_EVIDENCE_SOURCE');
  }
  const authority = report?.authority;
  if (
    !exactKeys(authority, [
      'providerKind',
      'issuer',
      'audience',
      'type',
      'purpose',
      'requesterSubjectSha256',
      'reviewerSubjectSha256',
      'operatorSubjectSha256',
      'actionRefSha256',
      'authorityProjectIdSha256',
      'planDigest',
      'previewDigest',
    ]) ||
    authority?.providerKind !== 'external_oidc' ||
    !externalIssuer(authority?.issuer) ||
    authority?.audience !== 'qinglong3-worker-credential-management' ||
    authority?.type !== 'ql3-worker-credential-management+jwt' ||
    authority?.purpose !== 'worker-credential-management' ||
    ![
      authority?.requesterSubjectSha256,
      authority?.reviewerSubjectSha256,
      authority?.operatorSubjectSha256,
      authority?.actionRefSha256,
      authority?.authorityProjectIdSha256,
    ].every((entry) => SHA256_PATTERN.test(entry)) ||
    authority?.requesterSubjectSha256 ===
      authority?.reviewerSubjectSha256 ||
    ![
      authority?.requesterSubjectSha256,
      authority?.reviewerSubjectSha256,
    ].includes(authority?.operatorSubjectSha256) ||
    !HEX_DIGEST_PATTERN.test(authority?.planDigest) ||
    !HEX_DIGEST_PATTERN.test(authority?.previewDigest)
  ) {
    add('QL3_WORKER_MANAGEMENT_RELEASE_EVIDENCE_AUTHORITY');
  }
  if (
    !exactKeys(report?.transport, [
      'endpointSha256',
      'servernameSha256',
      'serverTrustBundleSha256',
      'commandSha256',
    ]) ||
    Object.values(report?.transport ?? {}).some(
      (entry) => !SHA256_PATTERN.test(entry),
    )
  ) {
    add('QL3_WORKER_MANAGEMENT_RELEASE_EVIDENCE_TRANSPORT');
  }
  const deployment = report?.deployment;
  if (
    !exactKeys(deployment, [
      'clusterServerSha256',
      'collectorSubjectSha256',
      'deploymentUidSha256',
      'pkiGenerations',
      'caRolloverGenerations',
      'pkiPodsFullyReplaced',
      'caRolloverPodsFullyReplaced',
      'twoReadyReplicasOnDistinctNodes',
    ]) ||
    ![
      deployment?.clusterServerSha256,
      deployment?.collectorSubjectSha256,
      deployment?.deploymentUidSha256,
    ].every((entry) => SHA256_PATTERN.test(entry)) ||
    !validIncreasingIntegers(deployment?.pkiGenerations, 2) ||
    !validIncreasingIntegers(deployment?.caRolloverGenerations, 3) ||
    deployment?.pkiPodsFullyReplaced !== true ||
    deployment?.caRolloverPodsFullyReplaced !== true ||
    deployment?.twoReadyReplicasOnDistinctNodes !== true
  ) {
    add('QL3_WORKER_MANAGEMENT_RELEASE_EVIDENCE_DEPLOYMENT');
  }
  if (
    !exactKeys(report?.controls, [
      'externalCeremonyObserved',
      'durableAuditObserved',
      'sameIssuerRevocationObserved',
      'caRolloverObserved',
      'serverAndClientTrustSeparated',
      'noExecutionOrConsumption',
      'exactReadOnlyCollectorAuthority',
    ]) ||
    Object.values(report?.controls ?? {}).some((entry) => entry !== true)
  ) {
    add('QL3_WORKER_MANAGEMENT_RELEASE_EVIDENCE_CONTROLS');
  }
  if (
    !exactKeys(report?.gates, [
      'sourceReportsCompatible',
      'sourceDigestChainBound',
      'externalIdentityBound',
      'reviewedDurableStateBound',
      'managementTransportBound',
      'deploymentAuthorityBound',
      'sameIssuerRevocationObserved',
      'clientCaRolloverObserved',
      'serverAndClientTrustSeparated',
      'noExecutionOrConsumption',
      'readOnlyEvidenceAuthority',
      'passed',
    ]) ||
    Object.values(report?.gates ?? {}).some((entry) => entry !== true)
  ) {
    add('QL3_WORKER_MANAGEMENT_RELEASE_EVIDENCE_GATES');
  }
  if (containsSensitiveMaterial(report)) {
    add('QL3_WORKER_MANAGEMENT_RELEASE_EVIDENCE_SECRET_EXPOSURE');
  }
  return Object.freeze({
    compatible: findings.length === 0,
    findings: Object.freeze(findings),
  });
}

function auditWorkerCredentialManagementReleaseEvidence(report, documents) {
  const structural = validateWorkerCredentialManagementReleaseEvidence(report);
  if (!structural.compatible) return structural;
  try {
    const facts = verifySourceDocuments(documents);
    const newestSourceMs = Math.max(
      Date.parse(facts.ceremony.observedAt),
      Date.parse(facts.durable.observedAt),
      Date.parse(facts.pki.observedAt),
      Date.parse(facts.caRollover.observedAt),
    );
    if (Date.parse(report.observedAt) < newestSourceMs) {
      fail('release evidence predates one or more source reports');
    }
    const expected = buildReleaseEvidence(facts, report.observedAt);
    if (JSON.stringify(report) !== JSON.stringify(expected)) {
      return Object.freeze({
        compatible: false,
        findings: Object.freeze([
          Object.freeze({
            code: 'QL3_WORKER_MANAGEMENT_RELEASE_EVIDENCE_SOURCE_MISMATCH',
          }),
        ]),
      });
    }
    return Object.freeze({ compatible: true, findings: Object.freeze([]) });
  } catch (error) {
    if (!(error instanceof WorkerCredentialManagementReleaseEvidenceError)) {
      throw error;
    }
    return Object.freeze({
      compatible: false,
      findings: Object.freeze([
        Object.freeze({
          code: 'QL3_WORKER_MANAGEMENT_RELEASE_EVIDENCE_SOURCE_INCOMPATIBLE',
        }),
      ]),
    });
  }
}

function optionKeys() {
  return [
    'ceremonyReportFile',
    'durableAuditReportFile',
    'pkiRotationReportFile',
    'caRolloverReportFile',
    'outputFile',
  ];
}

function runWorkerCredentialManagementReleaseEvidence(
  options,
  dependencies = { now: Date.now },
) {
  exactObject(options, optionKeys(), 'release evidence options');
  exactObject(dependencies, ['now'], 'release evidence dependencies');
  if (typeof dependencies.now !== 'function') {
    fail('release evidence clock is invalid');
  }
  unusedOutput(options.outputFile);
  const nowMs = dependencies.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail('release evidence clock is invalid');
  }
  const documents = readSourceDocuments(options);
  try {
    const facts = verifySourceDocuments(documents);
    const report = buildReleaseEvidence(
      facts,
      new Date(nowMs).toISOString(),
    );
    const audit = auditWorkerCredentialManagementReleaseEvidence(
      report,
      documents,
    );
    if (!audit.compatible) fail('assembled release evidence failed audit');
    writeNoReplace(options.outputFile, report);
    return report;
  } finally {
    clearSourceDocuments(documents);
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
  const expected = [
    'ceremony-report',
    'durable-audit-report',
    'pki-rotation-report',
    'ca-rollover-report',
    'output',
  ];
  if (
    JSON.stringify(Object.keys(values).sort()) !==
    JSON.stringify(expected.sort())
  ) {
    fail('arguments are invalid');
  }
  return Object.freeze({
    ceremonyReportFile: values['ceremony-report'],
    durableAuditReportFile: values['durable-audit-report'],
    pkiRotationReportFile: values['pki-rotation-report'],
    caRolloverReportFile: values['ca-rollover-report'],
    outputFile: values.output,
  });
}

function runCli(argv) {
  const options = parseArguments(argv);
  runWorkerCredentialManagementReleaseEvidence(options, { now: Date.now });
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, fixture: FIXTURE, compatible: true })}\n`,
  );
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'Worker management release evidence failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  CA_ROLLOVER_FIXTURE,
  CEREMONY_FIXTURE,
  DURABLE_FIXTURE,
  FIXTURE,
  PKI_FIXTURE,
  WorkerCredentialManagementReleaseEvidenceError,
  auditWorkerCredentialManagementReleaseEvidence,
  buildReleaseEvidence,
  clearSourceDocuments,
  parseArguments,
  readDocument,
  readSourceDocuments,
  runWorkerCredentialManagementReleaseEvidence,
  validateWorkerCredentialManagementReleaseEvidence,
  verifySourceDocuments,
};
