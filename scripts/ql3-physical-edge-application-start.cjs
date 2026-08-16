#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  canonicalDigest,
  collectObservedPlatform,
} = require('./ql3-physical-edge-evidence.cjs');
const {
  parseProcIo,
  parseProcStat,
  parseProcStatus,
} = require('./ql3-physical-edge-idle-sampler.cjs');
const { readReleaseIdentity } = require('./lib/ql3-release-identity.cjs');

const MIB = 1024 * 1024;
const QL3_VERSION = readReleaseIdentity(path.resolve(__dirname, '..')).version;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_ARTIFACT_FILES = 768;
const MAX_ARTIFACT_DIRECTORIES = 256;
const MAX_ARTIFACT_BYTES = 8 * MIB;
const MAX_EVENTS = 64;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REQUIRED_PACKAGES = Object.freeze([
  '@qinglong/local-admin',
  '@qinglong/local-application',
  '@qinglong/local-command-file',
  '@qinglong/local-execution',
  '@qinglong/local-process',
  '@qinglong/local-secret',
  '@qinglong/local-sqlite',
  '@qinglong/runtime-core',
  'croner',
  'semver',
]);
const MANIFEST_KEYS = Object.freeze([
  'deviceId',
  'evidenceClass',
  'expectedArchitecture',
  'expectedArtifactBytes',
  'expectedArtifactFiles',
  'expectedArtifactSha256',
  'expectedFilesystem',
  'expectedNodeSha256',
  'maximumBootAgeMs',
  'maximumFirstActiveMs',
  'maximumSampledRssBytes',
  'profile',
  'sampleIntervalMs',
  'schemaVersion',
]);
const ARTIFACT_KEYS = Object.freeze([
  'artifactBytes',
  'artifactFiles',
  'artifactMetadataSha256',
  'artifactSha256',
  'entrypointSha256',
  'packages',
]);
const ENVIRONMENT_KEYS = Object.freeze([
  'architecture',
  'bootAgeMs',
  'bootId',
  'dataFilesystem',
  'nodeExecutable',
  'nodeSha256',
  'nodeVersion',
  'platform',
]);
const PATH_KEYS = Object.freeze([
  'applicationConfig',
  'applicationEntrypoint',
  'artifactRoot',
  'dataPath',
  'deploymentRoot',
]);
const SESSION_KEYS = Object.freeze([
  'artifact',
  'environment',
  'evidenceClass',
  'manifestDigest',
  'paths',
  'preparedAt',
  'schemaVersion',
  'sessionId',
  'sha256',
  'uid',
]);
const REPORT_KEYS = Object.freeze([
  'evidenceClass',
  'generatedAt',
  'manifest',
  'measurements',
  'observed',
  'outcomes',
  'qualification',
  'schemaVersion',
  'session',
  'sha256',
  'supported',
]);
const REPORT_SESSION_KEYS = Object.freeze([
  'preparedAt',
  'sessionDigest',
  'sessionId',
]);
const REPORT_OBSERVED_KEYS = Object.freeze(['after', 'artifact', 'before']);
const OBSERVED_BOOT_KEYS = Object.freeze([
  'architecture',
  'bootAgeMs',
  'bootId',
  'dataFilesystem',
  'nodeExecutable',
  'nodeSha256',
  'nodeVersion',
  'platform',
]);
const MEASUREMENT_KEYS = Object.freeze([
  'eventCount',
  'firstActiveMs',
  'maximumSampledRssBytes',
  'processReadBytes',
  'processWriteBytes',
  'sampleCount',
]);
const OUTCOME_KEYS = Object.freeze([
  'activeEventCount',
  'aiStatus',
  'exitCode',
  'exitSignal',
  'gracefulStop',
  'sqliteContractVersion',
  'stderrBytes',
]);
const QUALIFICATION_KEYS = Object.freeze([
  'doesNotProve',
  'measures',
  'passed',
  'violations',
]);
const MEASURES = Object.freeze([
  'different_boot_identity',
  'bounded_post_reboot_boot_age',
  'exact_ai_excluded_native_release_closure',
  'production_application_process_to_active_event',
  'sampled_process_rss_until_active',
  'sampled_process_io_after_first_proc_sample',
  'graceful_sigterm_stop',
  'sqlite_v35_after_stop',
]);
const EXCLUSIONS = Object.freeze([
  'cold_node_runtime_or_dynamic_linker_cache',
  'cold_artifact_directory_or_inode_cache',
  'exclusive_application_page_cache_provenance',
  'process_metrics_before_first_proc_sample',
  'rss_peaks_between_samples',
  'firmware_power_on_to_service_manager_start',
  'systemd_or_openrc_supervisor_latency',
  'compose_or_container_runtime_start',
  'abrupt_power_loss_recovery',
  'whole_device_cpu_wakeups',
  'whole_device_flash_write_amplification',
  'release_archive_signature_or_attestation',
  'standalone_or_cluster_profile',
]);

class QingLong3PhysicalApplicationStartEvidenceError extends Error {
  constructor(message) {
    super(
      `QingLong 3.0 physical Edge application start evidence failed: ${message}`,
    );
    this.name = 'QingLong3PhysicalApplicationStartEvidenceError';
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      `${label} must be an object`,
    );
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      `${label} keys must be exactly ${expected.join(', ')}`,
    );
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

function normalizeApplicationStartManifest(value) {
  exactKeys(value, MANIFEST_KEYS, 'manifest');
  if (
    value.schemaVersion !== 1 ||
    value.evidenceClass !== 'physical_edge_application_start_candidate' ||
    value.profile !== 'edge'
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'manifest identity is invalid',
    );
  }
  if (
    typeof value.deviceId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.deviceId)
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'manifest deviceId is invalid',
    );
  }
  if (!['x64', 'arm64', 'arm'].includes(value.expectedArchitecture)) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'manifest expectedArchitecture is invalid',
    );
  }
  if (
    typeof value.expectedFilesystem !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(value.expectedFilesystem)
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'manifest expectedFilesystem is invalid',
    );
  }
  if (
    !SHA256_PATTERN.test(value.expectedArtifactSha256 ?? '') ||
    !Number.isSafeInteger(value.expectedArtifactFiles) ||
    value.expectedArtifactFiles < 1 ||
    value.expectedArtifactFiles > MAX_ARTIFACT_FILES ||
    !Number.isSafeInteger(value.expectedArtifactBytes) ||
    value.expectedArtifactBytes < 1 ||
    value.expectedArtifactBytes > MAX_ARTIFACT_BYTES ||
    !SHA256_PATTERN.test(value.expectedNodeSha256 ?? '')
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'manifest release artifact identity is invalid',
    );
  }
  if (
    !Number.isSafeInteger(value.maximumBootAgeMs) ||
    value.maximumBootAgeMs < 10_000 ||
    value.maximumBootAgeMs > 600_000 ||
    !Number.isSafeInteger(value.maximumFirstActiveMs) ||
    value.maximumFirstActiveMs < 100 ||
    value.maximumFirstActiveMs > 120_000 ||
    !Number.isSafeInteger(value.maximumSampledRssBytes) ||
    value.maximumSampledRssBytes < 16 * MIB ||
    value.maximumSampledRssBytes > 512 * MIB ||
    !Number.isSafeInteger(value.sampleIntervalMs) ||
    value.sampleIntervalMs < 10 ||
    value.sampleIntervalMs > 1_000
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'manifest measurement budget is invalid',
    );
  }
  return Object.freeze({ ...value });
}

function parseArguments(argv) {
  const options = { json: false };
  let phase;
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
    if (
      !phase &&
      (argument === 'inspect' ||
        argument === 'prepare' ||
        argument === 'resume')
    ) {
      phase = argument;
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator < 1) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (name === '--manifest') options.manifestPath = value;
    else if (name === '--data-path') options.dataPath = value;
    else if (name === '--artifact-root') options.artifactRoot = value;
    else if (name === '--session') options.sessionPath = value;
    else if (name === '--output') options.outputPath = value;
    else {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
  }
  if (!phase) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'phase must be inspect, prepare or resume',
    );
  }
  const required =
    phase === 'inspect'
      ? ['artifactRoot']
      : phase === 'prepare'
      ? ['manifestPath', 'dataPath', 'artifactRoot', 'sessionPath']
      : ['manifestPath', 'sessionPath', 'outputPath'];
  for (const name of required) {
    if (!path.isAbsolute(options[name] ?? '')) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        `${name} must be absolute`,
      );
    }
  }
  const allowed = new Set(['json', ...required]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        `${name} is not accepted for ${phase}`,
      );
    }
  }
  return Object.freeze({ phase, ...options });
}

function readBoundedPrivateJson(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      `${label} is unavailable: ${error.message}`,
    );
  }
  const uid = process.geteuid?.();
  if (
    !Number.isSafeInteger(uid) ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.size < 2 ||
    stat.size > MAX_INPUT_BYTES
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      `${label} must be a bounded current-user 0600 single-link file`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      `${label} is invalid: ${error.message}`,
    );
  }
}

function readManifest(filePath) {
  return normalizeApplicationStartManifest(
    readBoundedPrivateJson(filePath, 'manifest'),
  );
}

function assertPrivateDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  const uid = process.geteuid?.();
  if (
    !Number.isSafeInteger(uid) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(directory) !== directory
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      `${label} must be a canonical current-user 0700 directory`,
    );
  }
}

function assertChildPath(parent, candidate, label) {
  if (
    path.normalize(candidate) !== candidate ||
    candidate === parent ||
    !candidate.startsWith(`${parent}${path.sep}`)
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      `${label} must remain inside dataPath`,
    );
  }
}

function writePrivateNoReplace(filePath, contents) {
  const parent = fs.realpathSync(path.dirname(filePath));
  assertPrivateDirectory(parent, 'output parent');
  const resolved = path.join(parent, path.basename(filePath));
  if (resolved !== filePath) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'output path must be canonical',
    );
  }
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const directoryDescriptor = fs.openSync(parent, 'r');
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
}

function fileSha256(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function installedPackages(nodeModulesRoot) {
  const values = [];
  for (const entry of fs.readdirSync(nodeModulesRoot, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!entry.name.startsWith('@')) {
      values.push(entry.name);
      continue;
    }
    for (const scoped of fs.readdirSync(
      path.join(nodeModulesRoot, entry.name),
      { withFileTypes: true },
    )) {
      if (scoped.isDirectory()) values.push(`${entry.name}/${scoped.name}`);
    }
  }
  return values.sort();
}

function artifactMetadataEntry(artifactRoot, target, kind, stat) {
  return Object.freeze({
    path: path.relative(artifactRoot, target) || '.',
    kind,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    bytes: stat.size.toString(),
    mode: Number(stat.mode & 0o777n),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    links: stat.nlink.toString(),
    modifiedNs: stat.mtimeNs.toString(),
    changedNs: stat.ctimeNs.toString(),
  });
}

function collectArtifactIdentity(artifactRootInput) {
  const artifactRoot = fs.realpathSync(artifactRootInput);
  if (
    artifactRoot !== artifactRootInput ||
    !path.isAbsolute(artifactRoot) ||
    artifactRoot === path.parse(artifactRoot).root
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'artifactRoot must be a canonical non-root directory',
    );
  }
  const uid = process.geteuid?.();
  if (!Number.isSafeInteger(uid)) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'a stable POSIX identity is required',
    );
  }
  const files = [];
  const metadata = [];
  let directories = 0;
  let artifactBytes = 0;
  const visit = (target) => {
    const stat = fs.lstatSync(target, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (stat.uid !== 0n && stat.uid !== BigInt(uid)) ||
      (stat.mode & 0o022n) !== 0n
    ) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'release artifact contains an untrusted entry',
      );
    }
    if (stat.isDirectory()) {
      metadata.push(
        artifactMetadataEntry(artifactRoot, target, 'directory', stat),
      );
      directories += 1;
      if (directories > MAX_ARTIFACT_DIRECTORIES) {
        throw new QingLong3PhysicalApplicationStartEvidenceError(
          'release artifact directory count exceeded',
        );
      }
      for (const entry of fs.readdirSync(target).sort()) {
        visit(path.join(target, entry));
      }
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'release artifact contains a non-regular or linked entry',
      );
    }
    const fileBytes = Number(stat.size);
    if (!Number.isSafeInteger(fileBytes)) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'release artifact file size is invalid',
      );
    }
    artifactBytes += fileBytes;
    if (
      files.length >= MAX_ARTIFACT_FILES ||
      artifactBytes > MAX_ARTIFACT_BYTES
    ) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'release artifact budget exceeded',
      );
    }
    files.push(
      Object.freeze({
        path: path.relative(artifactRoot, target),
        mode: Number(stat.mode & 0o777n),
        bytes: fileBytes,
        sha256: fileSha256(target),
      }),
    );
    metadata.push(artifactMetadataEntry(artifactRoot, target, 'file', stat));
  };
  visit(artifactRoot);
  const nodeModulesRoot = path.join(artifactRoot, 'node_modules');
  const packages = installedPackages(nodeModulesRoot);
  if (JSON.stringify(packages) !== JSON.stringify(REQUIRED_PACKAGES)) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'release artifact package closure is invalid',
    );
  }
  const packageRoot = path.join(
    nodeModulesRoot,
    '@qinglong',
    'local-application',
  );
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  const applicationEntrypoint = path.join(packageRoot, 'dist', 'cli.js');
  if (
    packageManifest.name !== '@qinglong/local-application' ||
    packageManifest.version !== QL3_VERSION ||
    packageManifest.bin?.['ql3-local-application'] !== 'dist/cli.js' ||
    packageManifest.engines?.node !== '>=24.18.0 <25' ||
    fs.realpathSync(applicationEntrypoint) !== applicationEntrypoint
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'release application entrypoint contract is invalid',
    );
  }
  const artifactSha256 = canonicalDigest({ files });
  const artifactMetadataSha256 = canonicalDigest({ entries: metadata });
  return Object.freeze({
    artifactRoot,
    applicationEntrypoint,
    artifact: Object.freeze({
      artifactSha256,
      artifactMetadataSha256,
      artifactFiles: files.length,
      artifactBytes,
      entrypointSha256: fileSha256(applicationEntrypoint),
      packages: REQUIRED_PACKAGES,
    }),
  });
}

function preflightArtifactMetadata(artifactRootInput, expectedEntrypoint) {
  const artifactRoot = fs.realpathSync(artifactRootInput);
  const uid = process.geteuid?.();
  let files = 0;
  let directories = 0;
  let entrypointFound = false;
  const metadata = [];
  const visit = (target) => {
    const stat = fs.lstatSync(target, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (stat.uid !== 0n && stat.uid !== BigInt(uid)) ||
      (stat.mode & 0o022n) !== 0n
    ) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'release artifact metadata is untrusted',
      );
    }
    if (stat.isDirectory()) {
      metadata.push(
        artifactMetadataEntry(artifactRoot, target, 'directory', stat),
      );
      directories += 1;
      if (directories > MAX_ARTIFACT_DIRECTORIES) {
        throw new QingLong3PhysicalApplicationStartEvidenceError(
          'release artifact directory count exceeded',
        );
      }
      for (const entry of fs.readdirSync(target).sort()) {
        visit(path.join(target, entry));
      }
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'release artifact metadata contains an unsupported entry',
      );
    }
    files += 1;
    metadata.push(artifactMetadataEntry(artifactRoot, target, 'file', stat));
    if (files > MAX_ARTIFACT_FILES) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'release artifact file count exceeded',
      );
    }
    if (target === expectedEntrypoint) entrypointFound = true;
  };
  visit(artifactRoot);
  if (!entrypointFound) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'release application entrypoint is unavailable',
    );
  }
  return Object.freeze({
    files,
    directories,
    artifactMetadataSha256: canonicalDigest({ entries: metadata }),
  });
}

function validArtifactSummary(value) {
  return (
    hasExactKeys(value, ARTIFACT_KEYS) &&
    SHA256_PATTERN.test(value.artifactSha256 ?? '') &&
    SHA256_PATTERN.test(value.artifactMetadataSha256 ?? '') &&
    SHA256_PATTERN.test(value.entrypointSha256 ?? '') &&
    Number.isSafeInteger(value.artifactFiles) &&
    value.artifactFiles >= 1 &&
    value.artifactFiles <= MAX_ARTIFACT_FILES &&
    Number.isSafeInteger(value.artifactBytes) &&
    value.artifactBytes >= 1 &&
    value.artifactBytes <= MAX_ARTIFACT_BYTES &&
    JSON.stringify(value.packages) === JSON.stringify(REQUIRED_PACKAGES)
  );
}

function collectNodeIdentity() {
  const nodeExecutable = fs.realpathSync(process.execPath);
  const stat = fs.lstatSync(nodeExecutable);
  const uid = process.geteuid?.();
  if (
    !Number.isSafeInteger(uid) ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.uid !== 0 && stat.uid !== uid) ||
    (stat.mode & 0o022) !== 0 ||
    (stat.mode & 0o111) === 0
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'Node executable is not trusted',
    );
  }
  return Object.freeze({
    nodeExecutable,
    nodeSha256: fileSha256(nodeExecutable),
    nodeVersion: process.version,
  });
}

function validateArtifactAgainstManifest(manifest, artifact, node) {
  const violations = [];
  if (
    artifact.artifactSha256 !== manifest.expectedArtifactSha256 ||
    artifact.artifactFiles !== manifest.expectedArtifactFiles ||
    artifact.artifactBytes !== manifest.expectedArtifactBytes
  ) {
    violations.push('release artifact did not match manifest');
  }
  if (node.nodeSha256 !== manifest.expectedNodeSha256) {
    violations.push('Node executable did not match manifest');
  }
  return Object.freeze(violations);
}

function normalizeSession(value) {
  exactKeys(value, SESSION_KEYS, 'session');
  const { sha256, ...body } = value;
  const expectedDeploymentRoot = path.join(
    value.paths?.dataPath ?? '',
    `.ql3-application-start-${value.sessionId ?? ''}`,
  );
  const expectedConfig = path.join(
    expectedDeploymentRoot,
    'local-application.json',
  );
  const expectedEntrypoint = path.join(
    value.paths?.artifactRoot ?? '',
    'node_modules',
    '@qinglong',
    'local-application',
    'dist',
    'cli.js',
  );
  if (
    value.schemaVersion !== 1 ||
    value.evidenceClass !== 'physical_edge_application_start_session' ||
    !UUID_V4_PATTERN.test(value.sessionId ?? '') ||
    !SHA256_PATTERN.test(value.manifestDigest ?? '') ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    typeof value.preparedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.preparedAt)) ||
    !validArtifactSummary(value.artifact) ||
    !hasExactKeys(value.environment, ENVIRONMENT_KEYS) ||
    value.environment.platform !== 'linux' ||
    typeof value.environment.bootId !== 'string' ||
    value.environment.bootId.length < 8 ||
    !Number.isSafeInteger(value.environment.bootAgeMs) ||
    value.environment.bootAgeMs < 0 ||
    !path.isAbsolute(value.environment.nodeExecutable ?? '') ||
    !SHA256_PATTERN.test(value.environment.nodeSha256 ?? '') ||
    typeof value.environment.nodeVersion !== 'string' ||
    !hasExactKeys(value.paths, PATH_KEYS) ||
    !path.isAbsolute(value.paths.dataPath ?? '') ||
    !path.isAbsolute(value.paths.artifactRoot ?? '') ||
    value.paths.deploymentRoot !== expectedDeploymentRoot ||
    value.paths.applicationConfig !== expectedConfig ||
    value.paths.applicationEntrypoint !== expectedEntrypoint ||
    value.sha256 !== canonicalDigest(body)
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'session is invalid or drifted',
    );
  }
  return Object.freeze(value);
}

function readBootAgeMs() {
  const raw = fs.readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/)[0];
  const seconds = Number(raw);
  const milliseconds = Math.floor(seconds * 1000);
  if (
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    !Number.isSafeInteger(milliseconds)
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'Linux boot age is invalid',
    );
  }
  return milliseconds;
}

function bootObservation(dataPath, node, bootAgeMs) {
  const observed = collectObservedPlatform(dataPath);
  return Object.freeze({
    platform: observed.platform,
    architecture: observed.architecture,
    bootId: observed.bootId,
    dataFilesystem: observed.dataFilesystem,
    nodeExecutable: node.nodeExecutable,
    nodeSha256: node.nodeSha256,
    nodeVersion: node.nodeVersion,
    bootAgeMs,
  });
}

function validateBootObservation(manifest, observation, dataPath) {
  const violations = [];
  if (observation.platform !== 'linux')
    violations.push('platform is not Linux');
  if (observation.architecture !== manifest.expectedArchitecture) {
    violations.push('architecture did not match manifest');
  }
  if (observation.dataFilesystem !== manifest.expectedFilesystem) {
    violations.push('filesystem did not match manifest');
  }
  if (
    !path.isAbsolute(dataPath ?? '') ||
    typeof observation.bootId !== 'string' ||
    observation.bootId.length < 8 ||
    !path.isAbsolute(observation.nodeExecutable ?? '') ||
    !SHA256_PATTERN.test(observation.nodeSha256 ?? '') ||
    typeof observation.nodeVersion !== 'string' ||
    !/^v24\.\d+\.\d+$/.test(observation.nodeVersion) ||
    !Number.isSafeInteger(observation.bootAgeMs) ||
    observation.bootAgeMs < 0
  ) {
    violations.push('boot observation is invalid');
  }
  return Object.freeze(violations);
}

function requireBuiltProducts() {
  const root = path.resolve(__dirname, '..');
  try {
    return Object.freeze({
      deployment: require(path.join(
        root,
        'packages/ql3-local-owner-cli/dist/deployment/localDeployment.js',
      )),
      rolloutSafety: require(path.join(
        root,
        'packages/ql3-local-sqlite/dist/readiness/rolloutSafety.js',
      )),
    });
  } catch (error) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      `QingLong 3.0 packages must be built first: ${error.message}`,
    );
  }
}

async function preparePhase(options, manifest) {
  if (process.platform !== 'linux') {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'prepare requires Linux',
    );
  }
  const dataPath = fs.realpathSync(options.dataPath);
  assertPrivateDirectory(dataPath, 'dataPath');
  assertChildPath(dataPath, options.sessionPath, 'sessionPath');
  if (fs.existsSync(options.sessionPath)) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'sessionPath already exists',
    );
  }
  const identity = collectArtifactIdentity(options.artifactRoot);
  const node = collectNodeIdentity();
  const artifactViolations = validateArtifactAgainstManifest(
    manifest,
    identity.artifact,
    node,
  );
  if (artifactViolations.length > 0) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      artifactViolations.join('; '),
    );
  }
  const before = bootObservation(dataPath, node, readBootAgeMs());
  const bootViolations = validateBootObservation(manifest, before, dataPath);
  if (bootViolations.length > 0) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      `device preflight rejected: ${bootViolations.join('; ')}`,
    );
  }
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid)) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'a stable POSIX UID is required',
    );
  }
  const sessionId = crypto.randomUUID();
  const deploymentRoot = path.join(
    dataPath,
    `.ql3-application-start-${sessionId}`,
  );
  const timestamp = Date.now();
  const products = requireBuiltProducts();
  const prepared = await products.deployment.prepareLocalDeployment({
    schemaVersion: 1,
    operation: 'local.deployment.prepare',
    options: {
      deploymentRoot,
      profile: 'edge',
      instanceId: `physical-start-${sessionId.slice(0, 8)}`,
      busyTimeoutMs: 100,
      service: {
        kind: 'openrc',
        nodeExecutable: node.nodeExecutable,
        applicationEntrypoint: identity.applicationEntrypoint,
        allowRootService: uid === 0,
      },
    },
    request: {
      ownerPepperKeyId: 'owner-v1',
      registerMutationId: crypto.randomUUID(),
      activateMutationId: crypto.randomUUID(),
      registeredAtMs: timestamp,
      activatedAtMs: timestamp + 1,
    },
  });
  if (prepared.status !== 'prepared' || prepared.profile !== 'edge') {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'fresh native Edge deployment was not prepared',
    );
  }
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_application_start_session',
    sessionId,
    manifestDigest: canonicalDigest(manifest),
    uid,
    preparedAt: new Date().toISOString(),
    artifact: identity.artifact,
    environment: {
      platform: before.platform,
      architecture: before.architecture,
      bootId: before.bootId,
      bootAgeMs: before.bootAgeMs,
      dataFilesystem: before.dataFilesystem,
      nodeExecutable: node.nodeExecutable,
      nodeSha256: node.nodeSha256,
      nodeVersion: node.nodeVersion,
    },
    paths: {
      dataPath,
      deploymentRoot,
      artifactRoot: identity.artifactRoot,
      applicationEntrypoint: identity.applicationEntrypoint,
      applicationConfig: path.join(deploymentRoot, 'local-application.json'),
    },
  };
  const session = Object.freeze({ ...body, sha256: canonicalDigest(body) });
  writePrivateNoReplace(
    options.sessionPath,
    `${JSON.stringify(session, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'awaiting_external_reboot',
      sessionId,
      profile: 'edge',
      applicationClosureVerified: true,
      supported: false,
    })}\n`,
  );
}

function readProcessSample(processId, expectedExecutable) {
  const root = `/proc/${processId}`;
  const stat = parseProcStat(fs.readFileSync(`${root}/stat`, 'utf8'));
  const status = parseProcStatus(fs.readFileSync(`${root}/status`, 'utf8'));
  const io = parseProcIo(fs.readFileSync(`${root}/io`, 'utf8'));
  const executable = fs.realpathSync(`${root}/exe`);
  if (
    executable !== expectedExecutable ||
    status.uid !== process.getuid?.() ||
    stat.processId !== processId
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'application process identity drifted',
    );
  }
  return Object.freeze({
    startTicks: stat.startTicks,
    rssBytes: status.rssBytes,
    readBytes: io.readBytes,
    writeBytes: io.writeBytes,
  });
}

function parseEventLines(buffer, events) {
  let remaining = buffer;
  while (remaining.includes('\n')) {
    const index = remaining.indexOf('\n');
    const line = remaining.slice(0, index);
    remaining = remaining.slice(index + 1);
    if (!line) continue;
    if (Buffer.byteLength(line, 'utf8') > 4096) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'application event line exceeded',
      );
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'application emitted non-JSON stdout',
      );
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.schemaVersion !== 1 ||
      value.component !== 'qinglong3-local-application' ||
      typeof value.event !== 'string' ||
      value.profile !== 'edge'
    ) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'application event shape is invalid',
      );
    }
    events.push(Object.freeze(value));
    if (events.length > MAX_EVENTS) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'application event count exceeded',
      );
    }
  }
  return remaining;
}

function timeoutPromise(milliseconds, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new QingLong3PhysicalApplicationStartEvidenceError(message));
    }, milliseconds);
    timer.unref();
  });
}

async function measureApplicationStart(session, manifest) {
  const startNs = process.hrtime.bigint();
  const child = spawn(
    session.environment.nodeExecutable,
    [
      session.paths.applicationEntrypoint,
      '--config',
      session.paths.applicationConfig,
    ],
    {
      cwd: session.paths.artifactRoot,
      env: { NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const events = [];
  let stdout = '';
  let stderr = '';
  let firstActiveNs;
  let resolveActive;
  let rejectActive;
  const activePromise = new Promise((resolve, reject) => {
    resolveActive = resolve;
    rejectActive = reject;
  });
  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    try {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
        throw new QingLong3PhysicalApplicationStartEvidenceError(
          'application stdout exceeded',
        );
      }
      stdout = parseEventLines(stdout, events);
      const activeEvents = events.filter(({ event }) => event === 'active');
      if (activeEvents.length === 1 && firstActiveNs === undefined) {
        firstActiveNs = process.hrtime.bigint();
        resolveActive(activeEvents[0]);
      } else if (activeEvents.length > 1) {
        rejectActive(
          new QingLong3PhysicalApplicationStartEvidenceError(
            'application emitted multiple active events',
          ),
        );
      }
    } catch (error) {
      rejectActive(error);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr, 'utf8') > MAX_OUTPUT_BYTES) {
      rejectActive(
        new QingLong3PhysicalApplicationStartEvidenceError(
          'application stderr exceeded',
        ),
      );
    }
  });
  exitPromise.then(({ code, signal }) => {
    if (firstActiveNs === undefined) {
      rejectActive(
        new QingLong3PhysicalApplicationStartEvidenceError(
          `application exited before active: ${String(code)}/${String(signal)}`,
        ),
      );
    }
  }, rejectActive);

  let maximumSampledRssBytes = 0;
  let sampleCount = 0;
  let firstSample;
  let lastSample;
  let startTicks;
  const sample = () => {
    try {
      const value = readProcessSample(
        child.pid,
        session.environment.nodeExecutable,
      );
      if (startTicks !== undefined && value.startTicks !== startTicks) {
        throw new QingLong3PhysicalApplicationStartEvidenceError(
          'application process generation changed',
        );
      }
      startTicks ??= value.startTicks;
      firstSample ??= value;
      lastSample = value;
      maximumSampledRssBytes = Math.max(maximumSampledRssBytes, value.rssBytes);
      sampleCount += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT' && firstActiveNs === undefined) {
        rejectActive(error);
      }
    }
  };
  sample();
  const sampler = setInterval(sample, manifest.sampleIntervalMs);
  try {
    const activeEvent = await Promise.race([
      activePromise,
      timeoutPromise(
        manifest.maximumFirstActiveMs,
        'application did not become active within the manifest budget',
      ),
    ]);
    sample();
    if (
      activeEvent.level !== 'info' ||
      activeEvent.aiStatus !== 'deployment_excluded' ||
      activeEvent.instanceId !==
        `physical-start-${session.sessionId.slice(0, 8)}` ||
      !firstSample ||
      !lastSample ||
      sampleCount < 1
    ) {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'application active evidence is invalid',
      );
    }
    child.kill('SIGTERM');
    const outcome = await Promise.race([
      exitPromise,
      timeoutPromise(35_000, 'application did not stop after SIGTERM'),
    ]);
    if (stdout !== '' || stderr !== '') {
      throw new QingLong3PhysicalApplicationStartEvidenceError(
        'application left partial stdout or emitted stderr',
      );
    }
    const activeEventCount = events.filter(
      ({ event }) => event === 'active',
    ).length;
    const gracefulStop =
      events.some(
        ({ event, signal }) =>
          event === 'shutdown_requested' && signal === 'SIGTERM',
      ) &&
      events.some(
        ({ event, stopResult }) =>
          event === 'stopped' && stopResult === 'stopped',
      );
    return Object.freeze({
      measurements: Object.freeze({
        firstActiveMs: Math.ceil(Number(firstActiveNs - startNs) / 1_000_000),
        maximumSampledRssBytes,
        processReadBytes: Math.max(
          0,
          lastSample.readBytes - firstSample.readBytes,
        ),
        processWriteBytes: Math.max(
          0,
          lastSample.writeBytes - firstSample.writeBytes,
        ),
        sampleCount,
        eventCount: events.length,
      }),
      outcomes: Object.freeze({
        activeEventCount,
        aiStatus: activeEvent.aiStatus,
        gracefulStop,
        exitCode: outcome.code,
        exitSignal: outcome.signal,
        stderrBytes: Buffer.byteLength(stderr, 'utf8'),
        sqliteContractVersion: 0,
      }),
    });
  } finally {
    clearInterval(sampler);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
}

function evaluateApplicationStartEvidence({
  manifest,
  session,
  observed,
  measurements,
  outcomes,
}) {
  const violations = [];
  if (
    !hasExactKeys(observed, REPORT_OBSERVED_KEYS) ||
    !hasExactKeys(observed.before, OBSERVED_BOOT_KEYS) ||
    !hasExactKeys(observed.after, OBSERVED_BOOT_KEYS) ||
    !validArtifactSummary(observed.artifact)
  ) {
    return Object.freeze(['application start observation shape is invalid']);
  }
  if (
    observed.before.bootId === observed.after.bootId ||
    observed.after.bootAgeMs > manifest.maximumBootAgeMs
  ) {
    violations.push('reboot boundary or boot age budget is invalid');
  }
  for (const candidate of [observed.before, observed.after]) {
    violations.push(
      ...validateBootObservation(manifest, candidate, session.paths.dataPath),
    );
  }
  if (
    JSON.stringify(observed.artifact) !== JSON.stringify(session.artifact) ||
    observed.artifact.artifactSha256 !== manifest.expectedArtifactSha256 ||
    observed.before.nodeSha256 !== manifest.expectedNodeSha256 ||
    observed.after.nodeSha256 !== manifest.expectedNodeSha256 ||
    observed.before.nodeExecutable !== observed.after.nodeExecutable ||
    observed.before.nodeVersion !== observed.after.nodeVersion
  ) {
    violations.push('release artifact or Node identity drifted');
  }
  if (
    !hasExactKeys(measurements, MEASUREMENT_KEYS) ||
    MEASUREMENT_KEYS.some(
      (key) =>
        !Number.isSafeInteger(measurements[key]) || measurements[key] < 0,
    ) ||
    measurements.firstActiveMs < 1 ||
    measurements.firstActiveMs > manifest.maximumFirstActiveMs ||
    measurements.maximumSampledRssBytes > manifest.maximumSampledRssBytes ||
    measurements.sampleCount < 1 ||
    measurements.eventCount < 1 ||
    measurements.eventCount > MAX_EVENTS
  ) {
    violations.push('application start measurement budget is invalid');
  }
  if (
    !hasExactKeys(outcomes, OUTCOME_KEYS) ||
    outcomes.activeEventCount !== 1 ||
    outcomes.aiStatus !== 'deployment_excluded' ||
    outcomes.gracefulStop !== true ||
    outcomes.exitCode !== 0 ||
    outcomes.exitSignal !== null ||
    outcomes.stderrBytes !== 0 ||
    outcomes.sqliteContractVersion !== 41
  ) {
    violations.push('application lifecycle outcome is invalid');
  }
  return Object.freeze(violations);
}

function buildApplicationStartReport({
  manifest,
  session,
  observed,
  measurements,
  outcomes,
  generatedAt,
}) {
  const violations = evaluateApplicationStartEvidence({
    manifest,
    session,
    observed,
    measurements,
    outcomes,
  });
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_application_start_candidate',
    supported: false,
    generatedAt,
    manifest,
    session: {
      sessionId: session.sessionId,
      sessionDigest: session.sha256,
      preparedAt: session.preparedAt,
    },
    observed,
    measurements,
    outcomes,
    qualification: {
      passed: violations.length === 0,
      violations,
      measures: MEASURES,
      doesNotProve: EXCLUSIONS,
    },
  };
  return Object.freeze({ ...body, sha256: canonicalDigest(body) });
}

function validateApplicationStartReport(report, manifest, currentObserved) {
  const violations = [];
  if (!hasExactKeys(report, REPORT_KEYS)) {
    return Object.freeze(['application start report shape is invalid']);
  }
  const { sha256, ...body } = report;
  if (!SHA256_PATTERN.test(sha256 ?? '') || canonicalDigest(body) !== sha256) {
    violations.push('application start report SHA-256 is invalid');
  }
  if (
    report.schemaVersion !== 1 ||
    report.evidenceClass !== 'physical_edge_application_start_candidate' ||
    report.supported !== false ||
    !Number.isFinite(Date.parse(report.generatedAt ?? '')) ||
    canonicalDigest(report.manifest) !== canonicalDigest(manifest) ||
    !hasExactKeys(report.session, REPORT_SESSION_KEYS) ||
    !UUID_V4_PATTERN.test(report.session?.sessionId ?? '') ||
    !SHA256_PATTERN.test(report.session?.sessionDigest ?? '') ||
    !Number.isFinite(Date.parse(report.session?.preparedAt ?? '')) ||
    !hasExactKeys(report.qualification, QUALIFICATION_KEYS)
  ) {
    violations.push('application start report identity is invalid');
  }
  if (
    report.observed?.after?.bootId !== currentObserved.bootId ||
    report.observed?.after?.architecture !== currentObserved.architecture ||
    report.observed?.after?.dataFilesystem !== currentObserved.dataFilesystem
  ) {
    violations.push('application start report current device did not match');
  }
  const syntheticSession = {
    paths: { dataPath: currentObserved.dataPath },
    artifact: report.observed?.artifact,
  };
  const recomputed = evaluateApplicationStartEvidence({
    manifest,
    session: syntheticSession,
    observed: report.observed,
    measurements: report.measurements,
    outcomes: report.outcomes,
  });
  if (
    report.qualification?.passed !== (recomputed.length === 0) ||
    JSON.stringify(report.qualification?.violations) !==
      JSON.stringify(recomputed) ||
    JSON.stringify(report.qualification?.measures) !==
      JSON.stringify(MEASURES) ||
    JSON.stringify(report.qualification?.doesNotProve) !==
      JSON.stringify(EXCLUSIONS) ||
    recomputed.length > 0
  ) {
    violations.push('application start report qualification was widened');
  }
  return Object.freeze(violations);
}

async function resumePhase(options, manifest) {
  if (process.platform !== 'linux') {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'resume requires Linux',
    );
  }
  const session = normalizeSession(
    readBoundedPrivateJson(options.sessionPath, 'session'),
  );
  if (
    session.manifestDigest !== canonicalDigest(manifest) ||
    session.uid !== process.getuid?.()
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'session manifest or POSIX identity changed',
    );
  }
  const dataPath = fs.realpathSync(session.paths.dataPath);
  assertPrivateDirectory(dataPath, 'dataPath');
  assertChildPath(dataPath, options.sessionPath, 'sessionPath');
  assertChildPath(dataPath, options.outputPath, 'outputPath');
  if (
    fs.realpathSync(session.paths.deploymentRoot) !==
      session.paths.deploymentRoot ||
    fs.realpathSync(session.paths.artifactRoot) !== session.paths.artifactRoot
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'session path identity changed',
    );
  }
  assertPrivateDirectory(session.paths.deploymentRoot, 'deploymentRoot');
  const metadata = preflightArtifactMetadata(
    session.paths.artifactRoot,
    session.paths.applicationEntrypoint,
  );
  if (
    metadata.files !== session.artifact.artifactFiles ||
    metadata.artifactMetadataSha256 !== session.artifact.artifactMetadataSha256
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'release artifact metadata count changed',
    );
  }
  const nodeBefore = Object.freeze({
    nodeExecutable: fs.realpathSync(process.execPath),
    nodeSha256: session.environment.nodeSha256,
    nodeVersion: process.version,
  });
  if (
    nodeBefore.nodeExecutable !== session.environment.nodeExecutable ||
    process.version !== session.environment.nodeVersion
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'Node runtime path or version changed',
    );
  }
  const bootAgeMs = readBootAgeMs();
  const after = bootObservation(dataPath, nodeBefore, bootAgeMs);
  const preflightViolations = validateBootObservation(
    manifest,
    after,
    dataPath,
  );
  if (
    after.bootId === session.environment.bootId ||
    bootAgeMs > manifest.maximumBootAgeMs ||
    preflightViolations.length > 0
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      `resume preflight rejected: ${[
        ...(after.bootId === session.environment.bootId
          ? ['boot identity did not change']
          : []),
        ...(bootAgeMs > manifest.maximumBootAgeMs
          ? ['boot age exceeded manifest']
          : []),
        ...preflightViolations,
      ].join('; ')}`,
    );
  }
  const measurement = await measureApplicationStart(session, manifest);
  const identityAfter = collectArtifactIdentity(session.paths.artifactRoot);
  const nodeAfter = collectNodeIdentity();
  const artifactViolations = validateArtifactAgainstManifest(
    manifest,
    identityAfter.artifact,
    nodeAfter,
  );
  if (
    artifactViolations.length > 0 ||
    JSON.stringify(identityAfter.artifact) !==
      JSON.stringify(session.artifact) ||
    nodeAfter.nodeExecutable !== session.environment.nodeExecutable
  ) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      `post-run release identity rejected: ${artifactViolations.join('; ')}`,
    );
  }
  const products = requireBuiltProducts();
  const sqlite = await products.rolloutSafety.inspectLocalSqliteSnapshot({
    databasePath: path.join(session.paths.deploymentRoot, 'qinglong3.sqlite'),
    profile: 'edge',
  });
  const outcomes = Object.freeze({
    ...measurement.outcomes,
    sqliteContractVersion: sqlite.contractVersion,
  });
  const before = Object.freeze({
    platform: session.environment.platform,
    architecture: session.environment.architecture,
    bootId: session.environment.bootId,
    bootAgeMs: session.environment.bootAgeMs,
    dataFilesystem: session.environment.dataFilesystem,
    nodeExecutable: session.environment.nodeExecutable,
    nodeSha256: session.environment.nodeSha256,
    nodeVersion: session.environment.nodeVersion,
  });
  const report = buildApplicationStartReport({
    manifest,
    session,
    observed: {
      before,
      after: Object.freeze({
        ...after,
        nodeSha256: nodeAfter.nodeSha256,
      }),
      artifact: identityAfter.artifact,
    },
    measurements: measurement.measurements,
    outcomes,
    generatedAt: new Date().toISOString(),
  });
  writePrivateNoReplace(
    options.outputPath,
    `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`,
  );
  if (!report.qualification.passed) process.exitCode = 1;
}

function inspectPhase(options) {
  const identity = collectArtifactIdentity(options.artifactRoot);
  const node = collectNodeIdentity();
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        evidenceClass: 'physical_edge_application_start_inspection',
        profile: 'edge',
        artifact: identity.artifact,
        node: {
          executable: node.nodeExecutable,
          sha256: node.nodeSha256,
          version: node.nodeVersion,
        },
        supported: false,
      },
      null,
      options.json ? 0 : 2,
    )}\n`,
  );
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new QingLong3PhysicalApplicationStartEvidenceError(
      'Node.js 24 or newer is required',
    );
  }
  const options = parseArguments(process.argv.slice(2));
  if (options.phase === 'inspect') {
    inspectPhase(options);
    return;
  }
  const manifest = readManifest(options.manifestPath);
  if (options.phase === 'prepare') {
    await preparePhase(options, manifest);
  } else {
    await resumePhase(options, manifest);
  }
}

module.exports = {
  QingLong3PhysicalApplicationStartEvidenceError,
  buildApplicationStartReport,
  collectArtifactIdentity,
  evaluateApplicationStartEvidence,
  normalizeApplicationStartManifest,
  normalizeSession,
  parseArguments,
  parseEventLines,
  preflightArtifactMetadata,
  readBootAgeMs,
  validateApplicationStartReport,
  validateArtifactAgainstManifest,
  validateBootObservation,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
