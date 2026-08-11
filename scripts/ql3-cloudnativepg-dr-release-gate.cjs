#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  readEvidenceFile,
  validateCloudNativePgDrReleaseEvidence,
} = require('./ql3-cloudnativepg-dr-evidence-audit.cjs');

function parseArguments(argv) {
  const values = new Map();
  for (const argument of argv) {
    const match = /^--(report|source-commit|release-version)=(.+)$/.exec(
      argument,
    );
    if (!match || values.has(match[1])) {
      throw new Error(
        'usage: ql3-cloudnativepg-dr-release-gate --report=/absolute/report.json --source-commit=<sha> --release-version=<3.x.y>',
      );
    }
    values.set(match[1], match[2]);
  }
  if (values.size !== 3) {
    throw new Error(
      'usage: ql3-cloudnativepg-dr-release-gate --report=/absolute/report.json --source-commit=<sha> --release-version=<3.x.y>',
    );
  }
  if (!path.isAbsolute(values.get('report'))) {
    throw new Error('release disaster-recovery report path must be absolute');
  }
  return Object.freeze({
    reportPath: values.get('report'),
    sourceCommit: values.get('source-commit'),
    releaseVersion: values.get('release-version'),
  });
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const stat = fs.lstatSync(options.reportPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      'release disaster-recovery evidence must be a mode-0600 regular file',
    );
  }
  const report = readEvidenceFile(options.reportPath);
  const result = validateCloudNativePgDrReleaseEvidence(report, {
    sourceCommit: options.sourceCommit,
    releaseVersion: options.releaseVersion,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.compatible) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArguments,
};
