#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalDigest,
  mountForPath,
  parseMountTable,
  writeNoReplace,
} = require('./ql3-physical-edge-evidence.cjs');

const MIB = 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const MANIFEST_KEYS = Object.freeze([
  'deviceId',
  'evidenceClass',
  'expectedFilesystem',
  'fault',
  'maximumFilesystemBytes',
  'probePath',
  'profile',
  'schemaVersion',
]);
const FAULTS = Object.freeze(['enospc_filesystem', 'read_only_filesystem']);

class QingLong3PhysicalFaultEvidenceError extends Error {
  constructor(message) {
    super(`QingLong 3.0 physical Edge fault evidence failed: ${message}`);
    this.name = 'QingLong3PhysicalFaultEvidenceError';
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QingLong3PhysicalFaultEvidenceError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new QingLong3PhysicalFaultEvidenceError(
      `${label} keys must be exactly ${expected.join(', ')}`,
    );
  }
}

function normalizeFaultManifest(value) {
  exactKeys(value, MANIFEST_KEYS, 'manifest');
  if (value.schemaVersion !== 1) {
    throw new QingLong3PhysicalFaultEvidenceError(
      'manifest schemaVersion must be 1',
    );
  }
  if (value.evidenceClass !== 'physical_edge_fault_candidate') {
    throw new QingLong3PhysicalFaultEvidenceError(
      'manifest evidenceClass must be physical_edge_fault_candidate',
    );
  }
  if (value.profile !== 'edge') {
    throw new QingLong3PhysicalFaultEvidenceError(
      'manifest profile must be edge',
    );
  }
  if (
    typeof value.deviceId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.deviceId)
  ) {
    throw new QingLong3PhysicalFaultEvidenceError(
      'manifest deviceId is invalid',
    );
  }
  if (!FAULTS.includes(value.fault)) {
    throw new QingLong3PhysicalFaultEvidenceError(
      `manifest fault must be one of ${FAULTS.join(', ')}`,
    );
  }
  if (
    typeof value.probePath !== 'string' ||
    !path.isAbsolute(value.probePath) ||
    value.probePath === '/' ||
    value.probePath.length > 4096
  ) {
    throw new QingLong3PhysicalFaultEvidenceError(
      'manifest probePath must be a bounded absolute non-root path',
    );
  }
  if (
    typeof value.expectedFilesystem !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(value.expectedFilesystem)
  ) {
    throw new QingLong3PhysicalFaultEvidenceError(
      'manifest expectedFilesystem is invalid',
    );
  }
  if (
    !Number.isSafeInteger(value.maximumFilesystemBytes) ||
    value.maximumFilesystemBytes < MIB ||
    value.maximumFilesystemBytes > 256 * MIB
  ) {
    throw new QingLong3PhysicalFaultEvidenceError(
      'manifest maximumFilesystemBytes must be between 1 and 256 MiB',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_fault_candidate',
    profile: 'edge',
    deviceId: value.deviceId,
    fault: value.fault,
    probePath: value.probePath,
    expectedFilesystem: value.expectedFilesystem,
    maximumFilesystemBytes: value.maximumFilesystemBytes,
  });
}

function parseArguments(argv) {
  const options = { json: false };
  let separatorSeen = false;
  for (const argument of argv) {
    if (argument === '--' && !separatorSeen) {
      separatorSeen = true;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator < 1) {
      throw new QingLong3PhysicalFaultEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (name === '--manifest') options.manifestPath = value;
    else if (name === '--output') options.outputPath = value;
    else {
      throw new QingLong3PhysicalFaultEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
  }
  for (const name of ['manifestPath', 'outputPath']) {
    if (!path.isAbsolute(options[name] ?? '')) {
      throw new QingLong3PhysicalFaultEvidenceError(`${name} must be absolute`);
    }
  }
  return Object.freeze(options);
}

function readManifest(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_INPUT_BYTES
    ) {
      throw new QingLong3PhysicalFaultEvidenceError(
        'manifest must be a bounded regular file without symlinks',
      );
    }
    const contents = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(contents) > MAX_INPUT_BYTES) {
      throw new QingLong3PhysicalFaultEvidenceError('manifest is oversized');
    }
    return normalizeFaultManifest(JSON.parse(contents));
  } catch (error) {
    if (error instanceof QingLong3PhysicalFaultEvidenceError) throw error;
    throw new QingLong3PhysicalFaultEvidenceError(
      `manifest could not be read: ${error.message}`,
    );
  }
}

function validateFaultEnvelope(manifest, observed) {
  const violations = [];
  if (observed.platform !== 'linux') violations.push('platform must be Linux');
  if (observed.probePath !== manifest.probePath) {
    violations.push('probe path was not canonical');
  }
  if (observed.mountPath !== manifest.probePath) {
    violations.push('probe path must be a dedicated mount point');
  }
  if (observed.filesystem !== manifest.expectedFilesystem) {
    violations.push(
      `filesystem ${observed.filesystem} did not equal ${manifest.expectedFilesystem}`,
    );
  }
  if (observed.totalBytes > manifest.maximumFilesystemBytes) {
    violations.push('fault filesystem exceeded its declared capacity');
  }
  if (manifest.fault === 'read_only_filesystem') {
    if (!observed.mountOptions.includes('ro')) {
      violations.push('fault filesystem was not mounted read-only');
    }
    if (observed.expectedErrorCode !== 'EROFS') {
      violations.push('write probe did not return EROFS');
    }
  } else {
    if (!observed.mountOptions.includes('rw')) {
      violations.push('fault filesystem was not mounted read-write');
    }
    if (observed.availableBytes !== 0) {
      violations.push('fault filesystem still had available blocks');
    }
    if (observed.processUid === 0) {
      violations.push('ENOSPC probe must run as non-root');
    }
    if (observed.expectedErrorCode !== 'ENOSPC') {
      violations.push('write probe did not return ENOSPC');
    }
  }
  if (observed.probeEntryRemained) {
    violations.push('fault probe entry was not cleaned up');
  }
  return Object.freeze(violations);
}

function collectFaultEnvelope(manifest) {
  if (process.platform !== 'linux') {
    throw new QingLong3PhysicalFaultEvidenceError('probe requires Linux');
  }
  const lstat = fs.lstatSync(manifest.probePath);
  const probePath = fs.realpathSync(manifest.probePath);
  if (
    !lstat.isDirectory() ||
    lstat.isSymbolicLink() ||
    probePath !== manifest.probePath
  ) {
    throw new QingLong3PhysicalFaultEvidenceError(
      'probePath must be a canonical directory without symlinks',
    );
  }
  const mounts = parseMountTable(fs.readFileSync('/proc/mounts', 'utf8'));
  const mount = mountForPath(mounts, probePath);
  if (!mount) {
    throw new QingLong3PhysicalFaultEvidenceError(
      'probe filesystem mount was not found',
    );
  }
  const statfs = fs.statfsSync(probePath, { bigint: true });
  const probeName = `.ql3-fault-${crypto.randomBytes(16).toString('hex')}`;
  const probeFile = path.join(probePath, probeName);
  let descriptor;
  let expectedErrorCode = null;
  let probeEntryCreated = false;
  try {
    descriptor = fs.openSync(probeFile, 'wx', 0o600);
    probeEntryCreated = true;
    fs.writeSync(descriptor, Buffer.from([0x51]), 0, 1, null);
    fs.fsyncSync(descriptor);
  } catch (error) {
    expectedErrorCode = error?.code ?? null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (probeEntryCreated) {
      try {
        fs.unlinkSync(probeFile);
      } catch {
        // The remaining entry is detected below and fails the evidence gate.
      }
    }
  }
  return Object.freeze({
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    processUid: process.getuid?.() ?? null,
    probePath,
    mountPath: mount.path,
    filesystem: mount.filesystem,
    mountOptions: mount.options,
    totalBytes: Number(statfs.blocks * statfs.bsize),
    availableBytes: Number(statfs.bavail * statfs.bsize),
    expectedErrorCode,
    probeEntryCreated,
    probeEntryRemained: fs.existsSync(probeFile),
  });
}

function buildFaultEvidenceReport({ manifest, observed, generatedAt }) {
  const violations = validateFaultEnvelope(manifest, observed);
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_fault_candidate',
    supported: false,
    generatedAt,
    manifest,
    observed,
    qualification: {
      passed: violations.length === 0,
      violations,
      scope: manifest.fault,
      doesNotProve: [
        'main_data_filesystem_fault',
        'application_level_recovery',
        'power_loss_survival',
      ],
    },
  };
  return Object.freeze({ ...body, sha256: canonicalDigest(body) });
}

function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new QingLong3PhysicalFaultEvidenceError(
      'Node.js 24 or newer is required',
    );
  }
  const options = parseArguments(process.argv.slice(2));
  const manifest = readManifest(options.manifestPath);
  const observed = collectFaultEnvelope(manifest);
  const report = buildFaultEvidenceReport({
    manifest,
    observed,
    generatedAt: new Date().toISOString(),
  });
  const serialized = `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`;
  writeNoReplace(options.outputPath, serialized);
  process.stdout.write(serialized);
  if (!report.qualification.passed) process.exitCode = 1;
}

module.exports = {
  QingLong3PhysicalFaultEvidenceError,
  buildFaultEvidenceReport,
  normalizeFaultManifest,
  parseArguments,
  validateFaultEnvelope,
};

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
