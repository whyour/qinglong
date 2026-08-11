#!/usr/bin/env node

'use strict';

const {
  FIXTURE,
  auditWorkerCredentialManagementReleaseEvidence,
  clearSourceDocuments,
  readDocument,
  readSourceDocuments,
} = require('./ql3-worker-credential-management-release-evidence.cjs');

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    if (argument === '--') continue;
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) {
      throw new Error('arguments are invalid');
    }
    values[match[1]] = match[2];
  }
  const expected = [
    'report',
    'ceremony-report',
    'durable-audit-report',
    'pki-rotation-report',
    'ca-rollover-report',
  ];
  if (
    JSON.stringify(Object.keys(values).sort()) !==
    JSON.stringify(expected.sort())
  ) {
    throw new Error(
      'usage: ql3-worker-credential-management-release-evidence-audit --report=/absolute/release.json --ceremony-report=/absolute/ceremony.json --durable-audit-report=/absolute/durable.json --pki-rotation-report=/absolute/pki.json --ca-rollover-report=/absolute/ca-rollover.json',
    );
  }
  return Object.freeze({
    reportFile: values.report,
    ceremonyReportFile: values['ceremony-report'],
    durableAuditReportFile: values['durable-audit-report'],
    pkiRotationReportFile: values['pki-rotation-report'],
    caRolloverReportFile: values['ca-rollover-report'],
  });
}

function runCli(argv) {
  const options = parseArguments(argv);
  const report = readDocument(options.reportFile, 'release evidence report');
  const documents = readSourceDocuments(options);
  try {
    const audit = auditWorkerCredentialManagementReleaseEvidence(
      report.value,
      documents,
    );
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, fixture: FIXTURE, ...audit })}\n`,
    );
    if (!audit.compatible) process.exitCode = 1;
  } finally {
    report.bytes.fill(0);
    clearSourceDocuments(documents);
  }
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'release audit failed'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = { parseArguments, runCli };
