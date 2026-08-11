#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const CONTRACT = 'qinglong/postgresql-ca-overlap@v1';
const MAX_CERTIFICATES = 16;
const FINGERPRINT_PATTERN = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function normalizeFingerprints(name, values) {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > MAX_CERTIFICATES
  ) {
    throw new Error(
      `${name} CA set must contain 1-${MAX_CERTIFICATES} anchors`,
    );
  }
  const normalized = values.map((value) => {
    if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
      throw new Error(`${name} CA set contains a non-canonical fingerprint`);
    }
    return value.replaceAll(':', '').toLowerCase();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${name} CA set contains a duplicate anchor`);
  }
  return new Set(normalized);
}

function setDigest(values) {
  return crypto
    .createHash('sha256')
    .update([...values].sort().join('\n'))
    .digest('hex');
}

function difference(left, right) {
  return new Set([...left].filter((value) => !right.has(value)));
}

function intersection(left, right) {
  return new Set([...left].filter((value) => right.has(value)));
}

function equalSets(left, right) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function auditPostgresCaOverlapFingerprints({
  oldFingerprints,
  overlapFingerprints,
  newFingerprints,
}) {
  const oldAnchors = normalizeFingerprints('old', oldFingerprints);
  const overlapAnchors = normalizeFingerprints('overlap', overlapFingerprints);
  const newAnchors = normalizeFingerprints('new', newFingerprints);
  const union = new Set([...oldAnchors, ...newAnchors]);
  if (!equalSets(overlapAnchors, union)) {
    throw new Error(
      'overlap CA set must be the exact union of old and new anchors',
    );
  }

  const introduced = difference(newAnchors, oldAnchors);
  const retired = difference(oldAnchors, newAnchors);
  if (introduced.size < 1 || retired.size < 1) {
    throw new Error(
      'CA rotation must introduce and retire at least one trust anchor',
    );
  }
  const retained = intersection(oldAnchors, newAnchors);

  return Object.freeze({
    contract: CONTRACT,
    old: Object.freeze({
      count: oldAnchors.size,
      digest: setDigest(oldAnchors),
    }),
    overlap: Object.freeze({
      count: overlapAnchors.size,
      digest: setDigest(overlapAnchors),
    }),
    new: Object.freeze({
      count: newAnchors.size,
      digest: setDigest(newAnchors),
    }),
    retainedCount: retained.size,
    introducedCount: introduced.size,
    retiredCount: retired.size,
  });
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument === '--') {
      continue;
    } else if (argument.startsWith('--old=')) {
      options.oldFile = argument.slice('--old='.length);
    } else if (argument.startsWith('--overlap=')) {
      options.overlapFile = argument.slice('--overlap='.length);
    } else if (argument.startsWith('--new=')) {
      options.newFile = argument.slice('--new='.length);
    } else {
      throw new Error(`unsupported CA overlap audit argument: ${argument}`);
    }
  }
  if (!options.oldFile || !options.overlapFile || !options.newFile) {
    throw new Error(
      'CA overlap audit requires --old, --overlap and --new bundle paths',
    );
  }
  return options;
}

function auditPostgresCaOverlapFiles(options) {
  const runtime = require(path.resolve(
    __dirname,
    '../packages/ql3-cluster-postgres/dist/entrypoints/runtime.js',
  ));
  if (typeof runtime.inspectPostgresCertificateAuthorityFile !== 'function') {
    throw new Error(
      'cluster-postgres must be built before auditing CA overlap',
    );
  }
  const inspect = runtime.inspectPostgresCertificateAuthorityFile;
  return auditPostgresCaOverlapFingerprints({
    oldFingerprints: inspect(options.oldFile).fingerprints256,
    overlapFingerprints: inspect(options.overlapFile).fingerprints256,
    newFingerprints: inspect(options.newFile).fingerprints256,
  });
}

function main() {
  const report = auditPostgresCaOverlapFiles(
    parseArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify({ ok: true, ...report })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  auditPostgresCaOverlapFiles,
  auditPostgresCaOverlapFingerprints,
};
