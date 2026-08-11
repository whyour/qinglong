#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  FIXTURE,
  validateWorkerCredentialManagementPkiRotationEvidence,
} = require('./ql3-worker-credential-management-pki-rotation-evidence.cjs');

function readReport(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error('report path must be absolute');
  }
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > 1024 * 1024 ||
    (stat.mode & 0o022) !== 0 ||
    fs.realpathSync(filePath) !== filePath
  ) {
    throw new Error('report must be one canonical bounded integrity file');
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runCli(argv) {
  if (argv.length !== 1 || !argv[0].startsWith('--report=')) {
    throw new Error(
      'usage: ql3-worker-credential-management-pki-rotation-evidence-audit --report=/absolute/report.json',
    );
  }
  const report = readReport(argv[0].slice('--report='.length));
  const audit = validateWorkerCredentialManagementPkiRotationEvidence(report);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, fixture: FIXTURE, ...audit })}\n`,
  );
  if (!audit.compatible) process.exitCode = 1;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'audit failed'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = { readReport, runCli };
