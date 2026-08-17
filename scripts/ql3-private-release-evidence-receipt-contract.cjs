#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  auditWorkerCredentialManagementReleaseGate,
} = require('./ql3-worker-credential-management-release-gate.cjs');
const {
  validateCloudNativePgDrReleaseEvidence,
} = require('./ql3-cloudnativepg-dr-evidence-audit.cjs');
const {
  auditCloudNativePgBackup,
} = require('./ql3-cloudnativepg-backup-audit.cjs');
const {
  auditBarmanCloudSupplyChain,
} = require('./ql3-barman-cloud-supply-chain-audit.cjs');
const {
  auditCertManagerSelection,
} = require('./ql3-cert-manager-selection-audit.cjs');

const RECEIPT_SCHEMA = 'qinglong/private-release-evidence-receipt@v2';
const EVIDENCE_KINDS = Object.freeze([
  'worker-management',
  'cloudnativepg-disaster-recovery',
]);
const EVIDENCE_FIXTURES = Object.freeze({
  'worker-management': 'qinglong/worker-credential-management-release-gate@v1',
  'cloudnativepg-disaster-recovery':
    'qinglong/cloudnativepg-disaster-recovery@v1',
});
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_EVIDENCE_AGE_SECONDS = 24 * 60 * 60;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const VERSION_PATTERN =
  /^3\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const STATIC_AUDIT_NAMES = Object.freeze([
  'cloudnativepg-backup',
  'barman-cloud-supply-chain',
  'cert-manager-selection',
]);

class QingLong3PrivateReleaseEvidenceReceiptError extends Error {
  constructor(message) {
    super(`QingLong 3 private release evidence receipt failed: ${message}`);
    this.name = 'QingLong3PrivateReleaseEvidenceReceiptError';
  }
}

function fail(message) {
  throw new QingLong3PrivateReleaseEvidenceReceiptError(message);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

function canonicalAbsolute(filePath, label) {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    path.resolve(filePath) !== filePath
  ) {
    fail(`${label} path must be canonical and absolute`);
  }
  if (fs.realpathSync(path.dirname(filePath)) !== path.dirname(filePath)) {
    fail(`${label} parent must be canonical`);
  }
  return filePath;
}

function readJsonFile(filePath, label, privateInput = false) {
  const resolved = canonicalAbsolute(filePath, label);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(resolved, flags);
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 2 ||
      before.size > MAX_JSON_BYTES ||
      fs.realpathSync(resolved) !== resolved ||
      (privateInput &&
        (before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600))
    ) {
      fail(`${label} must be one bounded canonical regular file`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== before.size
    ) {
      bytes.fill(0);
      fail(`${label} changed while being read`);
    }
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      bytes.fill(0);
      fail(`${label} must contain valid JSON`);
    }
    if (canonicalJson(value) !== bytes.toString('utf8')) {
      bytes.fill(0);
      fail(`${label} must use exact canonical JSON encoding`);
    }
    return Object.freeze({ value, bytes });
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeNoReplace(filePath, value) {
  const resolved = canonicalAbsolute(filePath, 'output');
  if (fs.existsSync(resolved)) fail('output must not already exist');
  fs.writeFileSync(resolved, canonicalJson(value), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

function validateIdentity(options) {
  if (
    !VERSION_PATTERN.test(options.version || '') ||
    !REVISION_PATTERN.test(options.sourceRevision || '') ||
    options.sourceRef !== `refs/tags/v${options.version}` ||
    !['cluster', 'all'].includes(options.releaseScope)
  ) {
    fail('release identity must be one exact Cluster-capable QingLong 3 tag');
  }
  if (!EVIDENCE_KINDS.includes(options.evidenceKind)) {
    fail('evidence kind is invalid');
  }
}

function staticAuditReceipts(root) {
  const reports = [
    ['cloudnativepg-backup', auditCloudNativePgBackup({ root })],
    ['barman-cloud-supply-chain', auditBarmanCloudSupplyChain({ root })],
    ['cert-manager-selection', auditCertManagerSelection({ root })],
  ];
  if (reports.some(([, report]) => report.compatible !== true)) {
    fail('one or more static disaster-recovery locks are incompatible');
  }
  return Object.freeze(
    reports.map(([name, report]) =>
      Object.freeze({
        name,
        auditDigest: sha256(JSON.stringify(report)),
        compatible: true,
      }),
    ),
  );
}

function assembleReceipt(options) {
  validateIdentity(options);
  if (!DIGEST_PATTERN.test(options.reportDigest || '')) {
    fail('private evidence report digest is invalid');
  }
  const observedAtMs = Date.parse(options.observedAt);
  const validationClockMs = options.nowMs;
  if (
    !Number.isSafeInteger(validationClockMs) ||
    !Number.isFinite(observedAtMs) ||
    observedAtMs > validationClockMs + MAX_FUTURE_SKEW_MS ||
    validationClockMs - observedAtMs > MAX_EVIDENCE_AGE_SECONDS * 1000
  ) {
    fail('private evidence is outside the release freshness window');
  }
  const staticAudits =
    options.evidenceKind === 'cloudnativepg-disaster-recovery'
      ? staticAuditReceipts(options.root)
      : Object.freeze([]);
  const unsigned = {
    schemaVersion: 2,
    schema: RECEIPT_SCHEMA,
    release: {
      version: options.version,
      sourceRevision: options.sourceRevision,
      sourceRef: options.sourceRef,
      scope: options.releaseScope,
    },
    evidenceKind: options.evidenceKind,
    evidence: {
      fixture: options.fixture,
      observedAt: options.observedAt,
      maximumAgeSeconds: MAX_EVIDENCE_AGE_SECONDS,
      reportDigest: options.reportDigest,
      sourceReportsUploaded: false,
    },
    staticAudits,
    verification: {
      sourceAwareAudit: true,
      privateEvidenceReplayed: true,
      freshnessValidatedAtCreation: true,
      durableValidationClockPublished: false,
      publicConsumerReplay: 'not_possible_without_private_reports',
      privateReportContentPublished: false,
      compatible: true,
    },
  };
  return Object.freeze({
    ...unsigned,
    receiptDigest: sha256(JSON.stringify(unsigned)),
  });
}

function createWorkerReceipt(
  options,
  dependencies = {
    now: Date.now,
    auditGate: auditWorkerCredentialManagementReleaseGate,
  },
) {
  const nowMs = dependencies.now();
  const gate = dependencies.auditGate(
    {
      reportFile: options.reportFile,
      ceremonyReportFile: options.ceremonyReportFile,
      durableAuditReportFile: options.durableAuditReportFile,
      pkiRotationReportFile: options.pkiRotationReportFile,
      caRolloverReportFile: options.caRolloverReportFile,
      sourceCommit: options.sourceRevision,
      releaseVersion: options.version,
    },
    { now: () => nowMs },
  );
  const report = readJsonFile(
    options.reportFile,
    'Worker management evidence',
    true,
  );
  try {
    const receipt = assembleReceipt({
      ...options,
      evidenceKind: 'worker-management',
      fixture: gate.fixture,
      observedAt: report.value.observedAt,
      reportDigest: gate.evidenceReportSha256,
      nowMs,
    });
    writeNoReplace(options.outputFile, receipt);
    return receipt;
  } finally {
    report.bytes.fill(0);
  }
}

function createCloudNativePgReceipt(
  options,
  dependencies = {
    now: Date.now,
    validateEvidence: validateCloudNativePgDrReleaseEvidence,
  },
) {
  const nowMs = dependencies.now();
  const report = readJsonFile(
    options.reportFile,
    'CloudNativePG disaster-recovery evidence',
    true,
  );
  try {
    const audit = dependencies.validateEvidence(report.value, {
      sourceCommit: options.sourceRevision,
      releaseVersion: options.version,
      nowMs,
    });
    if (!audit.compatible) {
      fail('CloudNativePG disaster-recovery evidence is incompatible');
    }
    const receipt = assembleReceipt({
      ...options,
      evidenceKind: 'cloudnativepg-disaster-recovery',
      fixture: audit.fixture,
      observedAt: report.value.observedAt,
      reportDigest: sha256(report.bytes),
      nowMs,
    });
    writeNoReplace(options.outputFile, receipt);
    return receipt;
  } finally {
    report.bytes.fill(0);
  }
}

function inspectPrivateReleaseEvidenceReceipt(actual, options) {
  validateIdentity(options);
  const expectedStaticNames =
    options.evidenceKind === 'cloudnativepg-disaster-recovery'
      ? STATIC_AUDIT_NAMES
      : [];
  if (
    !exactKeys(actual, [
      'schemaVersion',
      'schema',
      'release',
      'evidenceKind',
      'evidence',
      'staticAudits',
      'verification',
      'receiptDigest',
    ]) ||
    actual.schemaVersion !== 2 ||
    actual.schema !== RECEIPT_SCHEMA ||
    !exactKeys(actual.release, [
      'version',
      'sourceRevision',
      'sourceRef',
      'scope',
    ]) ||
    JSON.stringify(actual.release) !==
      JSON.stringify({
        version: options.version,
        sourceRevision: options.sourceRevision,
        sourceRef: options.sourceRef,
        scope: options.releaseScope,
      }) ||
    actual.evidenceKind !== options.evidenceKind ||
    !exactKeys(actual.evidence, [
      'fixture',
      'observedAt',
      'maximumAgeSeconds',
      'reportDigest',
      'sourceReportsUploaded',
    ]) ||
    actual.evidence.fixture !== EVIDENCE_FIXTURES[options.evidenceKind] ||
    actual.evidence.maximumAgeSeconds !== MAX_EVIDENCE_AGE_SECONDS ||
    !DIGEST_PATTERN.test(actual.evidence.reportDigest || '') ||
    actual.evidence.sourceReportsUploaded !== false ||
    !Array.isArray(actual.staticAudits) ||
    JSON.stringify(actual.staticAudits.map((entry) => entry?.name)) !==
      JSON.stringify(expectedStaticNames) ||
    actual.staticAudits.some(
      (entry) =>
        !exactKeys(entry, ['name', 'auditDigest', 'compatible']) ||
        !DIGEST_PATTERN.test(entry.auditDigest || '') ||
        entry.compatible !== true,
    ) ||
    !exactKeys(actual.verification, [
      'sourceAwareAudit',
      'privateEvidenceReplayed',
      'freshnessValidatedAtCreation',
      'durableValidationClockPublished',
      'publicConsumerReplay',
      'privateReportContentPublished',
      'compatible',
    ]) ||
    JSON.stringify(actual.verification) !==
      JSON.stringify({
        sourceAwareAudit: true,
        privateEvidenceReplayed: true,
        freshnessValidatedAtCreation: true,
        durableValidationClockPublished: false,
        publicConsumerReplay: 'not_possible_without_private_reports',
        privateReportContentPublished: false,
        compatible: true,
      })
  ) {
    fail('receipt shape or release binding is invalid');
  }
  const observedAtMs = Date.parse(actual.evidence.observedAt);
  if (!Number.isFinite(observedAtMs)) {
    fail('receipt freshness binding is invalid');
  }
  if (options.validationClockMs !== undefined) {
    const validationClockMs = options.validationClockMs;
    if (
      !Number.isSafeInteger(validationClockMs) ||
      observedAtMs > validationClockMs + MAX_FUTURE_SKEW_MS ||
      validationClockMs - observedAtMs > MAX_EVIDENCE_AGE_SECONDS * 1000
    ) {
      fail('receipt is outside the release freshness window');
    }
  }
  const { receiptDigest, ...unsigned } = actual;
  if (
    !DIGEST_PATTERN.test(receiptDigest || '') ||
    receiptDigest !== sha256(JSON.stringify(unsigned))
  ) {
    fail('receipt digest is invalid');
  }
  return Object.freeze({
    compatible: true,
    evidenceKind: actual.evidenceKind,
    receiptDigest,
    reportDigest: actual.evidence.reportDigest,
    publicConsumerReplay: actual.verification.publicConsumerReplay,
  });
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(values, match[1]))
      fail('arguments are invalid');
    values[match[1]] = match[2];
  }
  const identity = [
    'release-scope',
    'source-ref',
    'source-revision',
    'version',
  ];
  const expected =
    values.mode === 'worker-create'
      ? [
          'mode',
          ...identity,
          'report',
          'ceremony-report',
          'durable-audit-report',
          'pki-rotation-report',
          'ca-rollover-report',
          'output',
        ]
      : values.mode === 'dr-create'
      ? ['mode', ...identity, 'report', 'output']
      : values.mode === 'audit'
      ? ['mode', ...identity, 'evidence-kind', 'receipt']
      : [];
  if (
    expected.length === 0 ||
    JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify(expected.sort())
  ) {
    fail('arguments are invalid');
  }
  return Object.freeze({
    mode: values.mode,
    version: values.version,
    sourceRevision: values['source-revision'],
    sourceRef: values['source-ref'],
    releaseScope: values['release-scope'],
    ...(values['evidence-kind']
      ? { evidenceKind: values['evidence-kind'] }
      : {}),
    ...(values.report ? { reportFile: values.report } : {}),
    ...(values['ceremony-report']
      ? { ceremonyReportFile: values['ceremony-report'] }
      : {}),
    ...(values['durable-audit-report']
      ? { durableAuditReportFile: values['durable-audit-report'] }
      : {}),
    ...(values['pki-rotation-report']
      ? { pkiRotationReportFile: values['pki-rotation-report'] }
      : {}),
    ...(values['ca-rollover-report']
      ? { caRolloverReportFile: values['ca-rollover-report'] }
      : {}),
    ...(values.output ? { outputFile: values.output } : {}),
    ...(values.receipt ? { receiptFile: values.receipt } : {}),
  });
}

function runCli(
  argv,
  root = path.resolve(__dirname, '..'),
  output = process.stdout,
) {
  const options = parseArguments(argv);
  if (options.mode === 'audit') {
    const receipt = readJsonFile(options.receiptFile, 'receipt').value;
    const result = inspectPrivateReleaseEvidenceReceipt(receipt, options);
    output.write(canonicalJson(result));
    return result;
  }
  const createOptions = { ...options, root };
  const receipt =
    options.mode === 'worker-create'
      ? createWorkerReceipt(createOptions)
      : createCloudNativePgReceipt(createOptions);
  output.write(canonicalJson(receipt));
  return receipt;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'receipt contract failed'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  EVIDENCE_KINDS,
  RECEIPT_SCHEMA,
  QingLong3PrivateReleaseEvidenceReceiptError,
  createCloudNativePgReceipt,
  createWorkerReceipt,
  inspectPrivateReleaseEvidenceReceipt,
  parseArguments,
  runCli,
});
