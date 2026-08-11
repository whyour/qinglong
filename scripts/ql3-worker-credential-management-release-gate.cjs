#!/usr/bin/env node

'use strict';

const { createHash } = require('node:crypto');

const {
  auditWorkerCredentialManagementReleaseEvidence,
  clearSourceDocuments,
  readDocument,
  readSourceDocuments,
} = require('./ql3-worker-credential-management-release-evidence.cjs');

const FIXTURE = 'qinglong/worker-credential-management-release-gate@v1';
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const VERSION_PATTERN =
  /^3\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

class WorkerCredentialManagementReleaseGateError extends Error {
  constructor(message) {
    super(`Worker management release gate failed: ${message}`);
    this.name = 'WorkerCredentialManagementReleaseGateError';
  }
}

function fail(message) {
  throw new WorkerCredentialManagementReleaseGateError(message);
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

function reportDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function optionKeys() {
  return [
    'reportFile',
    'ceremonyReportFile',
    'durableAuditReportFile',
    'pkiRotationReportFile',
    'caRolloverReportFile',
    'sourceCommit',
    'releaseVersion',
  ];
}

function auditWorkerCredentialManagementReleaseGate(
  options,
  dependencies = { now: Date.now },
) {
  if (!exactKeys(options, optionKeys())) fail('options are invalid');
  if (!exactKeys(dependencies, ['now']) || typeof dependencies.now !== 'function') {
    fail('clock is invalid');
  }
  if (!COMMIT_PATTERN.test(options.sourceCommit)) {
    fail('source commit must be one immutable Git object ID');
  }
  if (!VERSION_PATTERN.test(options.releaseVersion)) {
    fail('release version must be one QingLong 3 SemVer image tag');
  }
  const nowMs = dependencies.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('clock is invalid');

  const report = readDocument(options.reportFile, 'release evidence report');
  let documents;
  try {
    documents = readSourceDocuments(options);
    const audit = auditWorkerCredentialManagementReleaseEvidence(
      report.value,
      documents,
    );
    if (!audit.compatible) fail('source-aware evidence audit is incompatible');

    const observedAtMs = Date.parse(report.value.observedAt);
    if (!Number.isFinite(observedAtMs)) fail('evidence timestamp is invalid');
    if (observedAtMs > nowMs + MAX_FUTURE_SKEW_MS) {
      fail('evidence timestamp is too far in the future');
    }
    if (nowMs - observedAtMs > MAX_EVIDENCE_AGE_MS) {
      fail('evidence is older than the 24 hour release window');
    }

    return Object.freeze({
      schemaVersion: 1,
      fixture: FIXTURE,
      compatible: true,
      sourceCommit: options.sourceCommit,
      releaseVersion: options.releaseVersion,
      evidenceReportSha256: reportDigest(report.bytes),
      maximumEvidenceAgeSeconds: MAX_EVIDENCE_AGE_MS / 1000,
    });
  } finally {
    report.bytes.fill(0);
    if (documents) clearSourceDocuments(documents);
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
    'report',
    'ceremony-report',
    'durable-audit-report',
    'pki-rotation-report',
    'ca-rollover-report',
    'source-commit',
    'release-version',
  ];
  if (
    JSON.stringify(Object.keys(values).sort()) !==
    JSON.stringify(expected.sort())
  ) {
    fail('arguments are invalid');
  }
  return Object.freeze({
    reportFile: values.report,
    ceremonyReportFile: values['ceremony-report'],
    durableAuditReportFile: values['durable-audit-report'],
    pkiRotationReportFile: values['pki-rotation-report'],
    caRolloverReportFile: values['ca-rollover-report'],
    sourceCommit: values['source-commit'],
    releaseVersion: values['release-version'],
  });
}

function runCli(argv) {
  const result = auditWorkerCredentialManagementReleaseGate(
    parseArguments(argv),
    { now: Date.now },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'release gate failed'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  FIXTURE,
  MAX_EVIDENCE_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  WorkerCredentialManagementReleaseGateError,
  auditWorkerCredentialManagementReleaseGate,
  parseArguments,
  runCli,
};
