#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  QingLong3PhysicalEvidenceError,
  buildEvidenceReport,
  canonicalDigest,
  normalizeManifest,
  validateAdoptionScaleEvidenceReport,
  validateApplicationStartEvidenceReport,
  validateComposeStorageEvidenceReport,
  validateDirectServiceStartEvidenceReport,
  validateDirectServiceStopEvidenceReport,
  validateEvidenceWorkloads,
  validateFaultEvidenceReport,
  validateIdleEvidenceReport,
  validateObservedPlatform,
  validateServiceStartEvidenceReport,
  validateTaskScaleEvidenceReport,
  writeNoReplace,
} = require('./ql3-physical-edge-evidence.cjs');

const MAX_PHYSICAL_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_PUBLIC_KEY_BYTES = 8 * 1024;
const ED25519_SIGNATURE_BYTES = 64;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const RELEASE_SCOPE =
  'operator_attests_archive_source_and_runtime_artifact_identity';
const PHYSICAL_REPORT_KEYS = Object.freeze([
  'evidenceClass',
  'generatedAt',
  'manifest',
  'observed',
  'qualification',
  'schemaVersion',
  'sha256',
  'supplementalEvidence',
  'supported',
  'workloads',
]);
const QUALIFICATION_KEYS = Object.freeze([
  'collectedEvidence',
  'physicalCandidate',
  'remainingRequiredEvidence',
  'violations',
]);
const OBSERVED_KEYS = Object.freeze([
  'architecture',
  'bootId',
  'cpuCount',
  'cpuModel',
  'dataAvailableBytes',
  'dataBytes',
  'dataFilesystem',
  'dataMountOptions',
  'dataPath',
  'distribution',
  'kernel',
  'libc',
  'node',
  'observedModel',
  'platform',
  'totalMemoryBytes',
  'virtualizationIndicators',
]);
const EDGE_REPORT_KEYS = Object.freeze([
  'cancellation',
  'cases',
  'gates',
  'generatedAt',
  'host',
  'moduleLoad',
  'profile',
  'schemaVersion',
]);
const EDGE_CASE_KEYS = Object.freeze([
  'baselineRssBytes',
  'durationMs',
  'exitCode',
  'name',
  'outcome',
  'peakRssBytes',
  'peakRssDeltaBytes',
]);
const SQLITE_REPORT_KEYS = Object.freeze([
  'arch',
  'batchSize',
  'databaseBytes',
  'integrityCheck',
  'iterations',
  'journalMode',
  'maxBatchStallMs',
  'node',
  'platform',
  'rssDeltaMb',
  'synchronous',
  'transactionMs',
]);
const SUPPLEMENTAL_CLASSES = Object.freeze([
  'physical_edge_idle_candidate',
  'physical_edge_fault_candidate',
  'physical_edge_task_scale_candidate',
  'physical_edge_adoption_scale_candidate',
  'physical_edge_compose_storage_candidate',
  'physical_edge_application_start_candidate',
  'physical_edge_service_start_candidate',
  'physical_edge_direct_service_start_candidate',
  'physical_edge_direct_service_stop_candidate',
]);
const LIMITATIONS = Object.freeze([
  'the trusted operator attests the archive, source revision and runtime artifact relationship; this verifier does not unpack or independently reproduce the archive',
  'public-key distribution, rotation, revocation and transparency remain release-operator responsibilities',
  'the signature does not prove firmware or bootloader time, whole-device flash behavior, physical power loss, migration capacity or cluster capacity',
  'the final report remains a physical Edge candidate and never changes supported status',
]);

class QingLong3PhysicalEdgeReleaseEvidenceError extends Error {
  constructor(message) {
    super(`QingLong 3.0 physical Edge release evidence failed: ${message}`);
    this.name = 'QingLong3PhysicalEdgeReleaseEvidenceError';
  }
}

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
  );
}

function parseArguments(argv) {
  const options = { json: false };
  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (!options.phase && ['prepare', 'finalize'].includes(argument)) {
      options.phase = argument;
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator < 1) {
      throw new QingLong3PhysicalEdgeReleaseEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (name === '--physical-report') options.physicalReportPath = value;
    else if (name === '--release-archive') options.releaseArchivePath = value;
    else if (name === '--repository') options.repository = value;
    else if (name === '--revision') options.revision = value;
    else if (name === '--payload') options.payloadPath = value;
    else if (name === '--signature') options.signaturePath = value;
    else if (name === '--trusted-public-key') options.publicKeyPath = value;
    else if (name === '--expected-repository')
      options.expectedRepository = value;
    else if (name === '--expected-revision') options.expectedRevision = value;
    else if (name === '--output') options.outputPath = value;
    else {
      throw new QingLong3PhysicalEdgeReleaseEvidenceError(
        `unsupported argument ${name}`,
      );
    }
  }
  if (!['prepare', 'finalize'].includes(options.phase)) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      'phase must be prepare or finalize',
    );
  }
  const commonPaths = [
    ['physicalReportPath', options.physicalReportPath],
    ['releaseArchivePath', options.releaseArchivePath],
    ['payloadPath', options.payloadPath],
  ];
  const phasePaths =
    options.phase === 'finalize'
      ? [
          ['signaturePath', options.signaturePath],
          ['publicKeyPath', options.publicKeyPath],
          ['outputPath', options.outputPath],
        ]
      : [];
  for (const [label, value] of [...commonPaths, ...phasePaths]) {
    if (!path.isAbsolute(value ?? '')) {
      throw new QingLong3PhysicalEdgeReleaseEvidenceError(
        `${label} must be absolute`,
      );
    }
  }
  if (options.phase === 'prepare') {
    validateRepository(options.repository, 'repository');
    validateRevision(options.revision, 'revision');
    const invalid = [
      options.signaturePath,
      options.publicKeyPath,
      options.expectedRepository,
      options.expectedRevision,
      options.outputPath,
    ].some((value) => value !== undefined);
    if (invalid) {
      throw new QingLong3PhysicalEdgeReleaseEvidenceError(
        'prepare received a finalize-only option',
      );
    }
  } else {
    validateRepository(options.expectedRepository, 'expectedRepository');
    validateRevision(options.expectedRevision, 'expectedRevision');
    if (options.repository !== undefined || options.revision !== undefined) {
      throw new QingLong3PhysicalEdgeReleaseEvidenceError(
        'finalize received a prepare-only option',
      );
    }
  }
  return Object.freeze(options);
}

function validateRepository(value, label) {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@+~-]+$/.test(value)
  ) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(`${label} is invalid`);
  }
  return value;
}

function validateRevision(value, label) {
  if (!REVISION_PATTERN.test(value ?? '')) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      `${label} must be a 40-character lowercase Git revision`,
    );
  }
  return value;
}

function stableStatIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function openStableInput(filePath, label, maximumBytes, privateInput) {
  if (!path.isAbsolute(filePath) || fs.realpathSync(filePath) !== filePath) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      `${label} must use a canonical absolute path`,
    );
  }
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      `${label} must be a regular file without symlinks`,
    );
  }
  const mode = Number(before.mode & 0o777n);
  const effectiveUserId = process.geteuid?.();
  if (
    privateInput &&
    (!Number.isSafeInteger(effectiveUserId) ||
      before.uid !== BigInt(effectiveUserId) ||
      mode !== 0o600)
  ) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      `${label} must be a current-user-owned 0600 file`,
    );
  }
  if (!privateInput && (mode & 0o022) !== 0) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      `${label} must not be group- or other-writable`,
    );
  }
  if (before.size < 1n || before.size > BigInt(maximumBytes)) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      `${label} exceeds its bounded size`,
    );
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (stableStatIdentity(before) !== stableStatIdentity(opened)) {
    fs.closeSync(descriptor);
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      `${label} changed while it was opened`,
    );
  }
  return Object.freeze({ descriptor, before });
}

function finishStableInput(filePath, label, descriptor, before) {
  const afterDescriptor = fs.fstatSync(descriptor, { bigint: true });
  const afterPath = fs.lstatSync(filePath, { bigint: true });
  if (
    stableStatIdentity(before) !== stableStatIdentity(afterDescriptor) ||
    stableStatIdentity(before) !== stableStatIdentity(afterPath)
  ) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      `${label} changed while it was read`,
    );
  }
}

function readStableBuffer(filePath, label, maximumBytes, privateInput) {
  const { descriptor, before } = openStableInput(
    filePath,
    label,
    maximumBytes,
    privateInput,
  );
  try {
    const contents = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < contents.length) {
      const count = fs.readSync(
        descriptor,
        contents,
        offset,
        contents.length - offset,
        offset,
      );
      if (count === 0) {
        throw new QingLong3PhysicalEdgeReleaseEvidenceError(
          `${label} ended before its declared size`,
        );
      }
      offset += count;
    }
    finishStableInput(filePath, label, descriptor, before);
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

function hashStableFile(filePath, label, maximumBytes) {
  const { descriptor, before } = openStableInput(
    filePath,
    label,
    maximumBytes,
    false,
  );
  try {
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < Number(before.size)) {
      const count = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - offset),
        offset,
      );
      if (count === 0) {
        throw new QingLong3PhysicalEdgeReleaseEvidenceError(
          `${label} ended before its declared size`,
        );
      }
      digest.update(buffer.subarray(0, count));
      offset += count;
    }
    finishStableInput(filePath, label, descriptor, before);
    return Object.freeze({
      sha256: digest.digest('hex'),
      bytes: Number(before.size),
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function parsePrivateJson(filePath, label, maximumBytes) {
  const contents = readStableBuffer(filePath, label, maximumBytes, true);
  try {
    return JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      `${label} is not valid JSON: ${error.message}`,
    );
  }
}

function validateExactObserved(observed) {
  if (
    !hasExactKeys(observed, OBSERVED_KEYS) ||
    !hasExactKeys(observed?.distribution, ['id', 'versionId']) ||
    observed.platform !== 'linux' ||
    !['arm64', 'x64', 'arm'].includes(observed.architecture) ||
    !/^v24\.[0-9]+\.[0-9]+$/.test(observed.node ?? '') ||
    !/^[a-f0-9-]{36}$/.test(observed.bootId ?? '') ||
    !path.isAbsolute(observed.dataPath ?? '') ||
    !Number.isSafeInteger(observed.cpuCount) ||
    observed.cpuCount < 1 ||
    !Number.isSafeInteger(observed.totalMemoryBytes) ||
    observed.totalMemoryBytes < 1 ||
    !Number.isSafeInteger(observed.dataBytes) ||
    observed.dataBytes < 1 ||
    !Number.isSafeInteger(observed.dataAvailableBytes) ||
    observed.dataAvailableBytes < 0 ||
    observed.dataAvailableBytes > observed.dataBytes ||
    !Array.isArray(observed.dataMountOptions) ||
    observed.dataMountOptions.length < 1 ||
    observed.dataMountOptions.some(
      (option) => typeof option !== 'string' || option.length > 128,
    ) ||
    !Array.isArray(observed.virtualizationIndicators) ||
    ![
      observed.cpuModel,
      observed.observedModel,
      observed.kernel,
      observed.libc,
      observed.dataFilesystem,
      observed.distribution.id,
      observed.distribution.versionId,
    ].every(
      (value) =>
        typeof value === 'string' && value.length >= 1 && value.length <= 384,
    )
  ) {
    return Object.freeze(['physical observed platform shape is invalid']);
  }
  return Object.freeze([]);
}

function validRssMeasurement(value) {
  return (
    hasExactKeys(value, ['rssAfterBytes', 'rssBeforeBytes', 'rssDeltaBytes']) &&
    Number.isSafeInteger(value.rssBeforeBytes) &&
    value.rssBeforeBytes > 0 &&
    Number.isSafeInteger(value.rssAfterBytes) &&
    value.rssAfterBytes > 0 &&
    Number.isSafeInteger(value.rssDeltaBytes) &&
    value.rssDeltaBytes ===
      Math.max(0, value.rssAfterBytes - value.rssBeforeBytes)
  );
}

function validEdgeCase(value, expectedName, outputRequired) {
  const expectedKeys = outputRequired
    ? [...EDGE_CASE_KEYS, 'output'].sort()
    : EDGE_CASE_KEYS;
  if (
    !hasExactKeys(value, expectedKeys) ||
    value.name !== expectedName ||
    value.outcome !== 'succeeded' ||
    value.exitCode !== 0 ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    !Number.isSafeInteger(value.baselineRssBytes) ||
    value.baselineRssBytes < 1 ||
    !Number.isSafeInteger(value.peakRssBytes) ||
    value.peakRssBytes < value.baselineRssBytes ||
    value.peakRssDeltaBytes !==
      Math.max(0, value.peakRssBytes - value.baselineRssBytes)
  ) {
    return false;
  }
  return (
    !outputRequired ||
    (hasExactKeys(value.output, ['bytes', 'lines', 'writes']) &&
      Number.isSafeInteger(value.output.bytes) &&
      value.output.bytes > 0 &&
      value.output.lines === 10_000 &&
      Number.isSafeInteger(value.output.writes) &&
      value.output.writes > 0)
  );
}

function validateExactBaseWorkloads(workloads, observed) {
  const violations = [];
  if (!Array.isArray(workloads) || workloads.length !== 3) {
    return Object.freeze(['physical evidence workloads are incomplete']);
  }
  const edge = workloads[0]?.report;
  if (
    !hasExactKeys(edge, EDGE_REPORT_KEYS) ||
    !hasExactKeys(edge?.host, [
      'architecture',
      'cpuCount',
      'node',
      'platform',
      'totalMemoryBytes',
    ]) ||
    edge.host.platform !== observed.platform ||
    edge.host.architecture !== observed.architecture ||
    edge.host.node !== observed.node ||
    !Number.isSafeInteger(edge.host.cpuCount) ||
    edge.host.cpuCount < 1 ||
    !Number.isSafeInteger(edge.host.totalMemoryBytes) ||
    edge.host.totalMemoryBytes < 1 ||
    !Number.isFinite(Date.parse(edge.generatedAt ?? '')) ||
    !validRssMeasurement(edge.moduleLoad) ||
    !Array.isArray(edge.cases) ||
    edge.cases.length !== 2 ||
    !validEdgeCase(edge.cases[0], 'single_noop', false) ||
    !validEdgeCase(edge.cases[1], 'stdout_10000_lines', true) ||
    !hasExactKeys(edge.cancellation, [
      'durationMs',
      'killSignalSent',
      'outcome',
      'termSignalSent',
    ]) ||
    !Number.isFinite(edge.cancellation.durationMs) ||
    edge.cancellation.durationMs < 0 ||
    edge.cancellation.outcome !== 'cancelled' ||
    typeof edge.cancellation.termSignalSent !== 'boolean' ||
    typeof edge.cancellation.killSignalSent !== 'boolean' ||
    !hasExactKeys(edge.gates, [
      'maxCancelMs',
      'maxRssDeltaMb',
      'passed',
      'violations',
    ]) ||
    edge.gates.maxCancelMs !== 5000 ||
    edge.gates.maxRssDeltaMb !== 96 ||
    edge.gates.passed !== true ||
    !Array.isArray(edge.gates.violations) ||
    edge.gates.violations.length !== 0
  ) {
    violations.push('Edge executor report is not an exact recorder result');
  }
  const sqlite = workloads[1]?.report;
  if (
    !hasExactKeys(sqlite, SQLITE_REPORT_KEYS) ||
    sqlite.platform !== observed.platform ||
    sqlite.arch !== observed.architecture ||
    sqlite.node !== observed.node ||
    sqlite.iterations !== 250 ||
    sqlite.batchSize !== 10 ||
    sqlite.journalMode !== 'delete' ||
    sqlite.synchronous !== 'full' ||
    sqlite.integrityCheck !== 'ok' ||
    !Number.isSafeInteger(sqlite.databaseBytes) ||
    sqlite.databaseBytes < 1 ||
    !Number.isFinite(sqlite.maxBatchStallMs) ||
    sqlite.maxBatchStallMs < 0 ||
    !Number.isFinite(sqlite.rssDeltaMb) ||
    sqlite.rssDeltaMb < 0 ||
    !hasExactKeys(sqlite.transactionMs, ['max', 'p50', 'p95', 'p99']) ||
    ![
      sqlite.transactionMs.p50,
      sqlite.transactionMs.p95,
      sqlite.transactionMs.p99,
      sqlite.transactionMs.max,
    ].every((value) => Number.isFinite(value) && value >= 0) ||
    sqlite.transactionMs.p50 > sqlite.transactionMs.p95 ||
    sqlite.transactionMs.p95 > sqlite.transactionMs.p99 ||
    sqlite.transactionMs.p99 > sqlite.transactionMs.max
  ) {
    violations.push('Node SQLite report is not an exact recorder result');
  }
  if (workloads[2]?.report?.identity?.node !== observed.node) {
    violations.push('Plugin Package recovery Node identity did not match');
  }
  return Object.freeze(violations);
}

function validateSupplementalEvidence(report, manifest, observed) {
  const violations = [];
  const counts = new Map();
  const directStart = report.supplementalEvidence.find(
    ({ evidenceClass }) =>
      evidenceClass === 'physical_edge_direct_service_start_candidate',
  );
  for (const evidence of report.supplementalEvidence) {
    const evidenceClass = evidence?.evidenceClass;
    if (!SUPPLEMENTAL_CLASSES.includes(evidenceClass)) {
      violations.push(`unknown supplemental evidence class ${evidenceClass}`);
      continue;
    }
    const discriminator =
      evidenceClass === 'physical_edge_fault_candidate'
        ? `${evidenceClass}:${evidence.manifest?.fault}`
        : evidenceClass;
    counts.set(discriminator, (counts.get(discriminator) ?? 0) + 1);
    if (counts.get(discriminator) > 1) {
      violations.push(`duplicate supplemental evidence ${discriminator}`);
      continue;
    }
    let evidenceViolations;
    if (evidenceClass === 'physical_edge_idle_candidate') {
      evidenceViolations = validateIdleEvidenceReport(
        evidence,
        manifest,
        observed,
      );
    } else if (evidenceClass === 'physical_edge_fault_candidate') {
      evidenceViolations = validateFaultEvidenceReport(
        evidence,
        manifest,
        observed,
      );
    } else if (evidenceClass === 'physical_edge_task_scale_candidate') {
      evidenceViolations = validateTaskScaleEvidenceReport(
        evidence,
        manifest,
        observed,
      );
    } else if (evidenceClass === 'physical_edge_adoption_scale_candidate') {
      evidenceViolations = validateAdoptionScaleEvidenceReport(
        evidence,
        manifest,
        observed,
      );
    } else if (evidenceClass === 'physical_edge_compose_storage_candidate') {
      evidenceViolations = validateComposeStorageEvidenceReport(
        evidence,
        manifest,
        observed,
      );
    } else if (evidenceClass === 'physical_edge_application_start_candidate') {
      evidenceViolations = validateApplicationStartEvidenceReport(
        evidence,
        manifest,
        observed,
      );
    } else if (evidenceClass === 'physical_edge_service_start_candidate') {
      evidenceViolations = validateServiceStartEvidenceReport(
        evidence,
        manifest,
        observed,
      );
    } else if (
      evidenceClass === 'physical_edge_direct_service_start_candidate'
    ) {
      evidenceViolations = validateDirectServiceStartEvidenceReport(
        evidence,
        manifest,
        observed,
      );
    } else {
      evidenceViolations = validateDirectServiceStopEvidenceReport(
        evidence,
        manifest,
        observed,
        directStart,
      );
    }
    violations.push(
      ...evidenceViolations.map(
        (violation) => `${evidenceClass}: ${violation}`,
      ),
    );
  }
  return Object.freeze(violations);
}

function validatePhysicalEvidenceReport(report) {
  const violations = [];
  if (!hasExactKeys(report, PHYSICAL_REPORT_KEYS)) {
    return Object.freeze(['physical evidence report shape is invalid']);
  }
  if (!hasExactKeys(report.qualification, QUALIFICATION_KEYS)) {
    return Object.freeze(['physical evidence qualification shape is invalid']);
  }
  let manifest;
  try {
    manifest = normalizeManifest(report.manifest);
  } catch (error) {
    return Object.freeze([
      `physical evidence manifest is invalid: ${error.message}`,
    ]);
  }
  if (
    report.schemaVersion !== 1 ||
    report.evidenceClass !== 'physical_edge_candidate' ||
    report.supported !== false ||
    !Number.isFinite(Date.parse(report.generatedAt ?? '')) ||
    !Array.isArray(report.workloads) ||
    !Array.isArray(report.supplementalEvidence)
  ) {
    violations.push('physical evidence identity is invalid');
  }
  violations.push(
    ...validateExactObserved(report.observed),
    ...validateObservedPlatform(manifest, report.observed),
    ...validateEvidenceWorkloads(report.workloads, report.observed),
    ...validateExactBaseWorkloads(report.workloads, report.observed),
  );
  if (Array.isArray(report.supplementalEvidence)) {
    violations.push(
      ...validateSupplementalEvidence(report, manifest, report.observed),
    );
  }
  let rebuilt;
  try {
    rebuilt = buildEvidenceReport({
      manifest,
      observed: report.observed,
      workloads: report.workloads,
      supplementalEvidence: report.supplementalEvidence,
      generatedAt: report.generatedAt,
    });
  } catch (error) {
    violations.push(`physical evidence could not be rebuilt: ${error.message}`);
  }
  if (rebuilt && JSON.stringify(rebuilt) !== JSON.stringify(report)) {
    violations.push('physical evidence report was not an exact reconstruction');
  }
  if (
    report.qualification.physicalCandidate !== true ||
    report.qualification.violations.length !== 0
  ) {
    violations.push('physical evidence candidate did not pass');
  }
  const directStart = report.supplementalEvidence.find?.(
    ({ evidenceClass }) =>
      evidenceClass === 'physical_edge_direct_service_start_candidate',
  );
  if (!directStart) {
    violations.push('direct release service start evidence is required');
  }
  const releaseRequirementCount =
    report.qualification.remainingRequiredEvidence.filter?.(
      (item) => item === 'release_archive_signature',
    ).length ?? 0;
  if (releaseRequirementCount !== 1) {
    violations.push('release archive signature requirement is not exact');
  }
  return Object.freeze(violations);
}

function requirePhysicalEvidenceReport(report) {
  const violations = validatePhysicalEvidenceReport(report);
  if (violations.length > 0) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      `physical evidence rejected: ${violations.join('; ')}`,
    );
  }
  return Object.freeze(report);
}

function buildSigningPayload({
  physicalReport,
  releaseArchive,
  repository,
  revision,
  signedAt,
}) {
  validateRepository(repository, 'repository');
  validateRevision(revision, 'revision');
  if (!Number.isFinite(Date.parse(signedAt ?? ''))) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      'signedAt must be an ISO timestamp',
    );
  }
  if (
    !SHA256_PATTERN.test(releaseArchive?.sha256 ?? '') ||
    !Number.isSafeInteger(releaseArchive?.bytes) ||
    releaseArchive.bytes < 1 ||
    releaseArchive.bytes > MAX_RELEASE_ARCHIVE_BYTES
  ) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      'release archive identity is invalid',
    );
  }
  const directStart = physicalReport.supplementalEvidence.find(
    ({ evidenceClass }) =>
      evidenceClass === 'physical_edge_direct_service_start_candidate',
  );
  const artifact = directStart.observed.artifact;
  const after = directStart.observed.after;
  return Object.freeze({
    schemaVersion: 1,
    attestationClass: 'physical_edge_release_archive_binding',
    algorithm: 'Ed25519',
    repository,
    revision,
    signedAt,
    scope: RELEASE_SCOPE,
    device: Object.freeze({
      deviceId: physicalReport.manifest.deviceId,
      deviceModel: physicalReport.manifest.deviceModel,
      soc: physicalReport.manifest.soc,
      architecture: physicalReport.observed.architecture,
      filesystem: physicalReport.observed.dataFilesystem,
      storageMedium: physicalReport.manifest.storageMedium,
      bootId: physicalReport.observed.bootId,
    }),
    physicalEvidence: Object.freeze({
      sha256: physicalReport.sha256,
      generatedAt: physicalReport.generatedAt,
    }),
    release: Object.freeze({
      archiveSha256: releaseArchive.sha256,
      archiveBytes: releaseArchive.bytes,
      profile: 'edge',
      artifactSha256: artifact.artifactSha256,
      artifactMetadataSha256: artifact.artifactMetadataSha256,
      artifactFiles: artifact.artifactFiles,
      artifactBytes: artifact.artifactBytes,
      entrypointSha256: artifact.entrypointSha256,
      nodeSha256: after.nodeSha256,
      nodeVersion: after.nodeVersion,
    }),
  });
}

function readExactPayload(filePath) {
  const contents = readStableBuffer(
    filePath,
    'signing payload',
    MAX_PAYLOAD_BYTES,
    true,
  );
  let payload;
  try {
    payload = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      `signing payload is not valid JSON: ${error.message}`,
    );
  }
  const canonical = Buffer.from(JSON.stringify(payload), 'utf8');
  if (
    contents.length !== canonical.length ||
    !crypto.timingSafeEqual(contents, canonical)
  ) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      'signing payload must contain exact canonical JSON without a newline',
    );
  }
  return Object.freeze({ payload, contents });
}

function readTrustedPublicKey(filePath) {
  const pem = readStableBuffer(
    filePath,
    'trusted public key',
    MAX_PUBLIC_KEY_BYTES,
    false,
  );
  let key;
  try {
    key = crypto.createPublicKey(pem);
  } catch (error) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      `trusted public key is invalid: ${error.message}`,
    );
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      'trusted public key must be Ed25519',
    );
  }
  const der = key.export({ type: 'spki', format: 'der' });
  return Object.freeze({
    key,
    fingerprintSha256: crypto.createHash('sha256').update(der).digest('hex'),
  });
}

function buildFinalReport({ physicalReport, payload, signature, fingerprint }) {
  const remainingRequiredEvidence =
    physicalReport.qualification.remainingRequiredEvidence.filter(
      (item) => item !== 'release_archive_signature',
    );
  const collectedEvidence = [
    ...physicalReport.qualification.collectedEvidence,
    'release_archive_signature_or_attestation',
  ];
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_release_candidate',
    supported: false,
    generatedAt: new Date().toISOString(),
    payload,
    trust: {
      algorithm: 'Ed25519',
      publicKeyFingerprintSha256: fingerprint,
    },
    signature: {
      encoding: 'base64',
      value: signature.toString('base64'),
    },
    qualification: {
      passed: true,
      violations: [],
      collectedEvidence,
      remainingRequiredEvidence,
    },
    limitations: LIMITATIONS,
  };
  return Object.freeze({ ...body, sha256: canonicalDigest(body) });
}

function preparePhase(options) {
  const physicalReport = requirePhysicalEvidenceReport(
    parsePrivateJson(
      options.physicalReportPath,
      'physical evidence report',
      MAX_PHYSICAL_REPORT_BYTES,
    ),
  );
  const releaseArchive = hashStableFile(
    options.releaseArchivePath,
    'release archive',
    MAX_RELEASE_ARCHIVE_BYTES,
  );
  const payload = buildSigningPayload({
    physicalReport,
    releaseArchive,
    repository: options.repository,
    revision: options.revision,
    signedAt: new Date().toISOString(),
  });
  const serialized = JSON.stringify(payload);
  writeNoReplace(options.payloadPath, serialized);
  process.stdout.write(
    `${JSON.stringify(payload, null, options.json ? 0 : 2)}\n`,
  );
}

function finalizePhase(options) {
  const physicalReport = requirePhysicalEvidenceReport(
    parsePrivateJson(
      options.physicalReportPath,
      'physical evidence report',
      MAX_PHYSICAL_REPORT_BYTES,
    ),
  );
  const releaseArchive = hashStableFile(
    options.releaseArchivePath,
    'release archive',
    MAX_RELEASE_ARCHIVE_BYTES,
  );
  const { payload, contents } = readExactPayload(options.payloadPath);
  const expectedPayload = buildSigningPayload({
    physicalReport,
    releaseArchive,
    repository: options.expectedRepository,
    revision: options.expectedRevision,
    signedAt: payload.signedAt,
  });
  if (JSON.stringify(payload) !== JSON.stringify(expectedPayload)) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      'signing payload did not match the expected source, archive and evidence',
    );
  }
  const signature = readStableBuffer(
    options.signaturePath,
    'detached signature',
    ED25519_SIGNATURE_BYTES,
    true,
  );
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      'detached Ed25519 signature must be exactly 64 bytes',
    );
  }
  const trustedKey = readTrustedPublicKey(options.publicKeyPath);
  if (!crypto.verify(null, contents, trustedKey.key, signature)) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      'detached signature verification failed',
    );
  }
  const report = buildFinalReport({
    physicalReport,
    payload,
    signature,
    fingerprint: trustedKey.fingerprintSha256,
  });
  const serialized = `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`;
  writeNoReplace(options.outputPath, serialized);
  process.stdout.write(serialized);
}

function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new QingLong3PhysicalEdgeReleaseEvidenceError(
      'Node.js 24 or newer is required',
    );
  }
  const options = parseArguments(process.argv.slice(2));
  if (options.phase === 'prepare') preparePhase(options);
  else finalizePhase(options);
}

module.exports = {
  ED25519_SIGNATURE_BYTES,
  LIMITATIONS,
  MAX_RELEASE_ARCHIVE_BYTES,
  QingLong3PhysicalEdgeReleaseEvidenceError,
  buildFinalReport,
  buildSigningPayload,
  hashStableFile,
  parseArguments,
  readExactPayload,
  readTrustedPublicKey,
  validatePhysicalEvidenceReport,
  validateExactBaseWorkloads,
  validateExactObserved,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message =
      error instanceof QingLong3PhysicalEvidenceError || error instanceof Error
        ? error.message
        : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
