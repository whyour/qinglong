#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  canonicalDigest,
  collectObservedPlatform,
  mountForPath,
  parseMountTable,
} = require('./ql3-physical-edge-evidence.cjs');
const {
  writeSyntheticLocalReleaseSelection,
} = require('./lib/ql3-local-release-selection-test-fixture.cjs');

const MIB = 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_TREE_ENTRIES = 512;
const SECTOR_BYTES = 512;
const MANIFEST_KEYS = Object.freeze([
  'databasePayloadBytes',
  'deviceId',
  'evidenceClass',
  'expectedArchitecture',
  'expectedFilesystem',
  'maximumPrepareWriteAmplificationPermille',
  'maximumResumeWriteAmplificationPermille',
  'profile',
  'schemaVersion',
  'snapshotCount',
]);
const SESSION_KEYS = Object.freeze([
  'barrier',
  'collection',
  'dataPath',
  'deploymentRoot',
  'evidenceClass',
  'manifestDigest',
  'prepareMeasurement',
  'preparedAt',
  'schemaVersion',
  'sessionId',
  'sha256',
  'uid',
]);
const STORAGE_IDENTITY_KEYS = Object.freeze([
  'architecture',
  'blockDevice',
  'bootId',
  'filesystem',
  'mountOptions',
  'mountPath',
  'platform',
  'sectorsWritten',
]);
const TREE_KEYS = Object.freeze([
  'allocatedBytes',
  'directories',
  'entries',
  'logicalBytes',
  'regularFiles',
]);
const SNAPSHOT_KEYS = Object.freeze([
  'bytes',
  'contractVersion',
  'pageCount',
  'pageSize',
  'sha256',
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
  'targetRolloutId',
  'targetSnapshot',
]);
const REPORT_OBSERVED_KEYS = Object.freeze(['after', 'afterStart', 'before']);
const REPORT_MEASUREMENT_KEYS = Object.freeze([
  'barrierAllocatedBytes',
  'collectedSnapshotBytes',
  'finalAllocatedBytes',
  'logicalSnapshotBytes',
  'prepareDeviceBytesWritten',
  'prepareWriteAmplificationPermille',
  'reclaimedAllocatedBytes',
  'resumeDeviceBytesWritten',
  'resumeWriteAmplificationPermille',
]);
const REPORT_OUTCOME_KEYS = Object.freeze([
  'commitStatus',
  'replayStatus',
  'retainedSnapshots',
  'sqliteIntegrity',
  'stageRemoved',
  'tombstonePresent',
]);
const REPORT_QUALIFICATION_KEYS = Object.freeze([
  'doesNotProve',
  'measures',
  'passed',
  'violations',
]);
const MEASURES = Object.freeze([
  'production_collection_prepare',
  'durable_collection_rename_stage',
  'boot_identity_change',
  'production_collection_commit_recovery',
  'exact_collection_commit_replay',
  'sqlite_integrity_after_reboot',
  'per_boot_partition_write_sectors',
  'allocated_snapshot_space_reclamation',
]);
const EXCLUSIONS = Object.freeze([
  'abrupt_power_interruption_provenance',
  'main_deployment_filesystem',
  'whole_device_flash_translation_layer_write_amplification',
  'mtd_ubi_device_write_amplification',
  'long_term_flash_endurance',
  'compose_restore_replacement_power_loss',
  'standalone_or_cluster_profile',
]);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

class QingLong3PhysicalComposeStorageEvidenceError extends Error {
  constructor(message) {
    super(
      `QingLong 3.0 physical Edge Compose storage evidence failed: ${message}`,
    );
    this.name = 'QingLong3PhysicalComposeStorageEvidenceError';
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      `${label} must be an object`,
    );
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
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

function normalizeComposeStorageManifest(value) {
  exactKeys(value, MANIFEST_KEYS, 'manifest');
  if (
    value.schemaVersion !== 1 ||
    value.evidenceClass !== 'physical_edge_compose_storage_candidate' ||
    value.profile !== 'edge'
  ) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'manifest identity is invalid',
    );
  }
  if (
    typeof value.deviceId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.deviceId)
  ) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'manifest deviceId is invalid',
    );
  }
  if (!['x64', 'arm64', 'arm'].includes(value.expectedArchitecture)) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'manifest expectedArchitecture is invalid',
    );
  }
  if (
    typeof value.expectedFilesystem !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(value.expectedFilesystem)
  ) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'manifest expectedFilesystem is invalid',
    );
  }
  if (value.snapshotCount !== 3) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'manifest snapshotCount must be 3',
    );
  }
  if (
    !Number.isSafeInteger(value.databasePayloadBytes) ||
    value.databasePayloadBytes < MIB ||
    value.databasePayloadBytes > 64 * MIB
  ) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'manifest databasePayloadBytes must be between 1 and 64 MiB',
    );
  }
  for (const name of [
    'maximumPrepareWriteAmplificationPermille',
    'maximumResumeWriteAmplificationPermille',
  ]) {
    if (
      !Number.isSafeInteger(value[name]) ||
      value[name] < 1000 ||
      value[name] > 1_000_000
    ) {
      throw new QingLong3PhysicalComposeStorageEvidenceError(
        `manifest ${name} must be between 1000 and 1000000`,
      );
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_compose_storage_candidate',
    profile: 'edge',
    deviceId: value.deviceId,
    expectedArchitecture: value.expectedArchitecture,
    expectedFilesystem: value.expectedFilesystem,
    snapshotCount: 3,
    databasePayloadBytes: value.databasePayloadBytes,
    maximumPrepareWriteAmplificationPermille:
      value.maximumPrepareWriteAmplificationPermille,
    maximumResumeWriteAmplificationPermille:
      value.maximumResumeWriteAmplificationPermille,
  });
}

function parseArguments(argv) {
  const options = { json: false };
  let separatorSeen = false;
  let phase;
  for (const argument of argv) {
    if (argument === '--' && !separatorSeen) {
      separatorSeen = true;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (!phase && (argument === 'prepare' || argument === 'resume')) {
      phase = argument;
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator < 1) {
      throw new QingLong3PhysicalComposeStorageEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (name === '--manifest') options.manifestPath = value;
    else if (name === '--data-path') options.dataPath = value;
    else if (name === '--session') options.sessionPath = value;
    else if (name === '--output') options.outputPath = value;
    else {
      throw new QingLong3PhysicalComposeStorageEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
  }
  if (!phase) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'phase must be prepare or resume',
    );
  }
  for (const name of ['manifestPath', 'sessionPath']) {
    if (!path.isAbsolute(options[name] ?? '')) {
      throw new QingLong3PhysicalComposeStorageEvidenceError(
        `${name} must be absolute`,
      );
    }
  }
  if (
    (phase === 'prepare' && !path.isAbsolute(options.dataPath ?? '')) ||
    (phase === 'resume' && options.dataPath !== undefined)
  ) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'dataPath is required only for prepare and must be absolute',
    );
  }
  if (
    (phase === 'resume' && !path.isAbsolute(options.outputPath ?? '')) ||
    (phase === 'prepare' && options.outputPath !== undefined)
  ) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'outputPath is required only for resume and must be absolute',
    );
  }
  return Object.freeze({ phase, ...options });
}

function readBoundedJson(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
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
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      `${label} must be a bounded current-user 0600 single-link file`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      `${label} is invalid: ${error.message}`,
    );
  }
}

function readManifest(filePath) {
  return normalizeComposeStorageManifest(readBoundedJson(filePath, 'manifest'));
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
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      `${label} must be a canonical current-user 0700 directory`,
    );
  }
}

function assertChildPath(parent, candidate, label) {
  const normalized = path.normalize(candidate);
  if (
    normalized !== candidate ||
    candidate === parent ||
    !candidate.startsWith(`${parent}${path.sep}`)
  ) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      `${label} must remain inside dataPath`,
    );
  }
}

function writePrivateNoReplace(filePath, contents) {
  const parent = fs.realpathSync(path.dirname(filePath));
  assertPrivateDirectory(parent, 'output parent');
  const resolved = path.join(parent, path.basename(filePath));
  if (resolved !== filePath) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
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

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function collectTreeStorage(root) {
  let entries = 0;
  let regularFiles = 0;
  let directories = 0;
  let logicalBytes = 0;
  let allocatedBytes = 0;
  const visit = (target) => {
    entries += 1;
    if (entries > MAX_TREE_ENTRIES) {
      throw new QingLong3PhysicalComposeStorageEvidenceError(
        'deployment tree exceeded 512 entries',
      );
    }
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new QingLong3PhysicalComposeStorageEvidenceError(
        'deployment tree contains a symlink',
      );
    }
    if (stat.isDirectory()) {
      directories += 1;
      for (const entry of fs.readdirSync(target).sort()) {
        visit(path.join(target, entry));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new QingLong3PhysicalComposeStorageEvidenceError(
        'deployment tree contains a non-regular entry',
      );
    }
    regularFiles += 1;
    logicalBytes += stat.size;
    allocatedBytes += stat.blocks * SECTOR_BYTES;
  };
  visit(root);
  return Object.freeze({
    entries,
    regularFiles,
    directories,
    logicalBytes,
    allocatedBytes,
  });
}

function parseSectorsWritten(raw) {
  const fields = raw.trim().split(/\s+/);
  const value = Number(fields[6]);
  if (fields.length < 11 || !Number.isSafeInteger(value) || value < 0) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'block device statistics are invalid',
    );
  }
  return value;
}

function collectStorageIdentity(dataPath) {
  if (process.platform !== 'linux') {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'collector requires Linux',
    );
  }
  const observed = collectObservedPlatform(dataPath);
  const mounts = parseMountTable(fs.readFileSync('/proc/mounts', 'utf8'));
  const mount = mountForPath(mounts, dataPath);
  if (!mount || mount.path !== dataPath) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'dataPath must be a dedicated mount point',
    );
  }
  if (!mount.source.startsWith('/dev/')) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'dataPath must use a directly observable block device',
    );
  }
  const blockDevice = fs.realpathSync(mount.source);
  const blockName = path.basename(blockDevice);
  const statPath = path.join('/sys/class/block', blockName, 'stat');
  const sectorsWritten = parseSectorsWritten(fs.readFileSync(statPath, 'utf8'));
  return Object.freeze({
    platform: observed.platform,
    architecture: observed.architecture,
    bootId: observed.bootId,
    mountPath: mount.path,
    filesystem: mount.filesystem,
    mountOptions: mount.options,
    blockDevice,
    sectorsWritten,
  });
}

function validateStorageIdentity(manifest, identity, dataPath) {
  const violations = [];
  if (identity.platform !== 'linux') violations.push('platform must be Linux');
  if (identity.architecture !== manifest.expectedArchitecture) {
    violations.push('architecture did not match manifest');
  }
  if (identity.mountPath !== dataPath) {
    violations.push('dataPath was not the dedicated mount point');
  }
  if (identity.filesystem !== manifest.expectedFilesystem) {
    violations.push('filesystem did not match manifest');
  }
  if (!identity.mountOptions.includes('rw')) {
    violations.push('dataPath was not mounted read-write');
  }
  if (!identity.blockDevice.startsWith('/dev/')) {
    violations.push('block device identity was invalid');
  }
  return Object.freeze(violations);
}

function snapshotReceipt(evidence) {
  return Object.freeze({
    contractVersion: evidence.contractVersion,
    sha256: evidence.sha256,
    bytes: evidence.bytes,
    pageCount: evidence.pageCount,
    pageSize: evidence.pageSize,
  });
}

function isSnapshot(value) {
  return (
    hasExactKeys(value, SNAPSHOT_KEYS) &&
    value.contractVersion === 44 &&
    typeof value.sha256 === 'string' &&
    SHA256_PATTERN.test(value.sha256) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    Number.isSafeInteger(value.pageCount) &&
    value.pageCount > 0 &&
    Number.isSafeInteger(value.pageSize) &&
    value.pageSize >= 512 &&
    value.pageSize <= 65_536
  );
}

function rolloutReceipt(command, evidence, recordedAtMs) {
  const result = Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.compose.apply',
    status: 'active',
    attemptedGeneration: command.request.expectedGeneration,
    activeGeneration: command.request.expectedGeneration,
    profile: 'edge',
    health: Object.freeze({ event: 'active' }),
    service: Object.freeze({ kind: 'compose' }),
  });
  return Object.freeze({
    schema: 'qinglong/local-compose-rollout-receipt@v2',
    commandDigest: canonicalDigest(command),
    rolloutId: command.request.rolloutId,
    attemptedGeneration: command.request.expectedGeneration,
    recordedAtMs,
    healthEventDigest: canonicalDigest({
      generation: command.request.expectedGeneration,
      status: 'active',
    }),
    sqlite: Object.freeze({
      contractVersion: evidence.contractVersion,
      writeContractVersion: evidence.writeContractVersion,
      writeObservation: 'unchanged',
      backup: Object.freeze({
        sha256: evidence.sha256,
        bytes: evidence.bytes,
        pageCount: evidence.pageCount,
        pageSize: evidence.pageSize,
      }),
    }),
    result,
  });
}

function inflateDatabase(databasePath, payloadBytes) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      'PRAGMA journal_mode = DELETE; CREATE TABLE ql3_physical_storage_payload (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);',
    );
    const insert = database.prepare(
      'INSERT INTO ql3_physical_storage_payload(payload) VALUES (zeroblob(?))',
    );
    const chunkBytes = Math.min(MIB, payloadBytes);
    let remaining = payloadBytes;
    while (remaining > 0) {
      insert.run(Math.min(chunkBytes, remaining));
      remaining -= Math.min(chunkBytes, remaining);
    }
    database.exec('DROP TABLE ql3_physical_storage_payload;');
  } finally {
    database.close();
  }
}

function requireBuiltProducts() {
  const root = path.resolve(__dirname, '..');
  try {
    return Object.freeze({
      root,
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
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      `QingLong 3.0 packages must be built first: ${error.message}`,
    );
  }
}

function sessionContents(session) {
  return `${JSON.stringify(session, null, 2)}\n`;
}

function normalizeSession(value) {
  exactKeys(value, SESSION_KEYS, 'session');
  const { sha256, ...body } = value;
  const prepareCommand = value.collection?.prepareCommand;
  const commitCommand = value.collection?.commitCommand;
  const target = value.collection?.target;
  const expectedDeploymentRoot = path.join(
    value.dataPath ?? '',
    `.ql3-compose-storage-${value.sessionId ?? ''}`,
  );
  const expectedTargetPath = path.join(
    expectedDeploymentRoot,
    'service',
    'rollout-backups',
    `${target?.rolloutId ?? ''}.sqlite`,
  );
  const expectedStagePath = path.join(
    path.dirname(expectedTargetPath),
    `.${path.basename(expectedTargetPath)}.ql3-collection-stage`,
  );
  if (
    value.schemaVersion !== 1 ||
    value.evidenceClass !== 'physical_edge_compose_storage_session' ||
    !UUID_V4_PATTERN.test(value.sessionId ?? '') ||
    !SHA256_PATTERN.test(value.manifestDigest ?? '') ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    typeof value.preparedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.preparedAt)) ||
    !path.isAbsolute(value.dataPath ?? '') ||
    !path.isAbsolute(value.deploymentRoot ?? '') ||
    !hasExactKeys(value.barrier?.identity, STORAGE_IDENTITY_KEYS) ||
    !hasExactKeys(value.barrier?.tree, TREE_KEYS) ||
    !Number.isSafeInteger(value.barrier?.sectorsWritten) ||
    !hasExactKeys(value.prepareMeasurement, [
      'deviceBytesWritten',
      'logicalSnapshotBytes',
      'writeAmplificationPermille',
    ]) ||
    !hasExactKeys(value.collection, [
      'commitCommand',
      'prepareCommand',
      'snapshotCount',
      'stagePath',
      'target',
      'targetPath',
    ]) ||
    value.collection.snapshotCount !== 3 ||
    !hasExactKeys(value.collection.target, ['rolloutId', 'snapshot']) ||
    !UUID_V4_PATTERN.test(value.collection.target.rolloutId ?? '') ||
    !isSnapshot(value.collection.target.snapshot) ||
    value.dataPath !== path.normalize(value.dataPath) ||
    value.deploymentRoot !== expectedDeploymentRoot ||
    value.barrier.identity.mountPath !== value.dataPath ||
    value.barrier.sectorsWritten !== value.barrier.identity.sectorsWritten ||
    TREE_KEYS.some(
      (key) =>
        !Number.isSafeInteger(value.barrier.tree[key]) ||
        value.barrier.tree[key] < 0,
    ) ||
    !Number.isSafeInteger(value.prepareMeasurement.logicalSnapshotBytes) ||
    value.prepareMeasurement.logicalSnapshotBytes < 1 ||
    !Number.isSafeInteger(value.prepareMeasurement.deviceBytesWritten) ||
    value.prepareMeasurement.deviceBytesWritten < 0 ||
    amplificationPermille(
      value.prepareMeasurement.deviceBytesWritten,
      value.prepareMeasurement.logicalSnapshotBytes,
    ) !== value.prepareMeasurement.writeAmplificationPermille ||
    !hasExactKeys(prepareCommand, [
      'operation',
      'options',
      'request',
      'schemaVersion',
    ]) ||
    prepareCommand.schemaVersion !== 1 ||
    prepareCommand.operation !==
      'local.deployment.compose.evidence-collection.prepare' ||
    !hasExactKeys(prepareCommand.options, [
      'allowRootService',
      'deploymentRoot',
    ]) ||
    prepareCommand.options.deploymentRoot !== value.deploymentRoot ||
    prepareCommand.options.allowRootService !== (value.uid === 0) ||
    !hasExactKeys(prepareCommand.request, [
      'collectionId',
      'expectedGeneration',
      'preparedAtMs',
      'restoreIds',
      'rolloutIds',
    ]) ||
    !UUID_V4_PATTERN.test(prepareCommand.request.collectionId ?? '') ||
    prepareCommand.request.expectedGeneration !== 4 ||
    !Number.isSafeInteger(prepareCommand.request.preparedAtMs) ||
    JSON.stringify(prepareCommand.request.rolloutIds) !==
      JSON.stringify([target.rolloutId]) ||
    JSON.stringify(prepareCommand.request.restoreIds) !== '[]' ||
    !hasExactKeys(commitCommand, [
      'operation',
      'options',
      'request',
      'schemaVersion',
    ]) ||
    commitCommand.schemaVersion !== 1 ||
    commitCommand.operation !==
      'local.deployment.compose.evidence-collection.commit' ||
    JSON.stringify(commitCommand.options) !==
      JSON.stringify(prepareCommand.options) ||
    !hasExactKeys(commitCommand.request, [
      'collectionId',
      'committedAtMs',
      'expectedGeneration',
    ]) ||
    commitCommand.request.collectionId !==
      prepareCommand.request.collectionId ||
    commitCommand.request.expectedGeneration !==
      prepareCommand.request.expectedGeneration ||
    !Number.isSafeInteger(commitCommand.request.committedAtMs) ||
    commitCommand.request.committedAtMs < prepareCommand.request.preparedAtMs ||
    value.collection.targetPath !== expectedTargetPath ||
    value.collection.stagePath !== expectedStagePath ||
    value.sha256 !== canonicalDigest(body)
  ) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'session is invalid or drifted',
    );
  }
  return Object.freeze(value);
}

async function preparePhase(options, manifest) {
  const dataPath = fs.realpathSync(options.dataPath);
  assertPrivateDirectory(dataPath, 'dataPath');
  assertChildPath(dataPath, options.sessionPath, 'sessionPath');
  if (fs.existsSync(options.sessionPath)) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'sessionPath already exists',
    );
  }
  const initialIdentity = collectStorageIdentity(dataPath);
  const preflightViolations = validateStorageIdentity(
    manifest,
    initialIdentity,
    dataPath,
  );
  if (preflightViolations.length > 0) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      `device preflight rejected: ${preflightViolations.join('; ')}`,
    );
  }
  const products = requireBuiltProducts();
  const sessionId = crypto.randomUUID();
  const deploymentRoot = path.join(
    dataPath,
    `.ql3-compose-storage-${sessionId}`,
  );
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid)) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'a stable POSIX UID is required',
    );
  }
  const timestamp = Date.now();
  const image = `ghcr.io/example/qinglong3-local-application@sha256:${'a'.repeat(
    64,
  )}`;
  fs.mkdirSync(deploymentRoot, { mode: 0o700 });
  const releaseSelection = writeSyntheticLocalReleaseSelection({
    directory: deploymentRoot,
    image,
    allowRootService: uid === 0,
  });
  await products.deployment.prepareLocalDeployment({
    schemaVersion: 1,
    operation: 'local.deployment.prepare',
    options: {
      deploymentRoot,
      profile: 'edge',
      instanceId: `physical-compose-${sessionId.slice(0, 8)}`,
      busyTimeoutMs: 100,
      service: {
        kind: 'compose',
        releaseSelection,
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
  const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
  inflateDatabase(databasePath, manifest.databasePayloadBytes);
  const rolloutIds = [];
  const snapshots = [];
  for (let generation = 2; generation <= 4; generation += 1) {
    await products.deployment.switchLocalDeploymentComposeRevision({
      schemaVersion: 1,
      operation: 'local.deployment.compose.upgrade',
      options: {
        deploymentRoot,
        allowRootService: uid === 0,
      },
      request: {
        expectedGeneration: generation - 1,
        releaseSelection,
        mutationId: crypto.randomUUID(),
        changedAtMs: timestamp + generation,
      },
    });
    const rolloutId = crypto.randomUUID();
    const command = {
      schemaVersion: 1,
      operation: 'local.deployment.compose.apply',
      options: {
        deploymentRoot,
        dockerExecutable: process.execPath,
        dockerSocketPath: path.join(deploymentRoot, 'physical-docker.sock'),
        allowRootService: uid === 0,
      },
      request: {
        expectedGeneration: generation,
        rolloutId,
        startedAtMs: timestamp + generation * 10,
        failureRollbackMutationId: crypto.randomUUID(),
        failureRollbackChangedAtMs: timestamp + generation * 10 + 1,
      },
    };
    const backupPath = path.join(
      deploymentRoot,
      'service',
      'rollout-backups',
      `${rolloutId}.sqlite`,
    );
    const evidence =
      await products.rolloutSafety.createLocalSqliteRolloutBackup({
        databasePath,
        backupPath,
        profile: 'edge',
      });
    const receiptPath = path.join(
      deploymentRoot,
      'service',
      'rollouts',
      `${rolloutId}.json`,
    );
    writePrivateNoReplace(
      receiptPath,
      `${JSON.stringify(
        rolloutReceipt(
          command,
          evidence,
          command.request.failureRollbackChangedAtMs,
        ),
        null,
        2,
      )}\n`,
    );
    rolloutIds.push(rolloutId);
    snapshots.push(evidence);
  }
  const collectionId = crypto.randomUUID();
  const prepareCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.compose.evidence-collection.prepare',
    options: {
      deploymentRoot,
      allowRootService: uid === 0,
    },
    request: {
      expectedGeneration: 4,
      collectionId,
      rolloutIds: [rolloutIds[0]],
      restoreIds: [],
      preparedAtMs: timestamp + 100,
    },
  };
  const commitCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.compose.evidence-collection.commit',
    options: prepareCommand.options,
    request: {
      expectedGeneration: 4,
      collectionId,
      committedAtMs: timestamp + 101,
    },
  };
  const prepared =
    await products.deployment.collectLocalDeploymentComposeEvidence(
      prepareCommand,
    );
  if (
    prepared.status !== 'prepared' ||
    prepared.collected.rolloutBackups !== 1
  ) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'production collection prepare did not publish',
    );
  }
  const targetPath = path.join(
    deploymentRoot,
    'service',
    'rollout-backups',
    `${rolloutIds[0]}.sqlite`,
  );
  const stagePath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.ql3-collection-stage`,
  );
  fs.renameSync(targetPath, stagePath);
  syncDirectory(path.dirname(targetPath));
  const barrierIdentity = collectStorageIdentity(dataPath);
  if (
    barrierIdentity.bootId !== initialIdentity.bootId ||
    barrierIdentity.blockDevice !== initialIdentity.blockDevice ||
    barrierIdentity.sectorsWritten < initialIdentity.sectorsWritten
  ) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'prepare block device identity changed',
    );
  }
  const logicalSnapshotBytes = snapshots.reduce(
    (total, snapshot) => total + snapshot.bytes,
    0,
  );
  const deviceBytesWritten =
    (barrierIdentity.sectorsWritten - initialIdentity.sectorsWritten) *
    SECTOR_BYTES;
  const writeAmplificationPermille = Math.ceil(
    (deviceBytesWritten * 1000) / logicalSnapshotBytes,
  );
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_compose_storage_session',
    sessionId,
    manifestDigest: canonicalDigest(manifest),
    uid,
    preparedAt: new Date().toISOString(),
    dataPath,
    deploymentRoot,
    barrier: {
      identity: barrierIdentity,
      sectorsWritten: barrierIdentity.sectorsWritten,
      tree: collectTreeStorage(deploymentRoot),
    },
    prepareMeasurement: {
      logicalSnapshotBytes,
      deviceBytesWritten,
      writeAmplificationPermille,
    },
    collection: {
      snapshotCount: snapshots.length,
      prepareCommand,
      commitCommand,
      target: {
        rolloutId: rolloutIds[0],
        snapshot: snapshotReceipt(snapshots[0]),
      },
      targetPath,
      stagePath,
    },
  };
  const session = Object.freeze({ ...body, sha256: canonicalDigest(body) });
  writePrivateNoReplace(options.sessionPath, sessionContents(session));
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'awaiting_external_reboot',
      sessionId,
      preparedGeneration: 4,
      collectionStageDurable: true,
      supported: false,
    })}\n`,
  );
}

function amplificationPermille(deviceBytes, logicalBytes) {
  if (
    !Number.isSafeInteger(deviceBytes) ||
    deviceBytes < 0 ||
    !Number.isSafeInteger(logicalBytes) ||
    logicalBytes < 1
  ) {
    return null;
  }
  return Math.ceil((deviceBytes * 1000) / logicalBytes);
}

function evaluateComposeStorageEvidence({
  manifest,
  dataPath,
  targetSnapshot,
  observed,
  measurements,
  outcomes,
}) {
  const violations = [];
  if (
    !hasExactKeys(observed, REPORT_OBSERVED_KEYS) ||
    !hasExactKeys(observed.before, STORAGE_IDENTITY_KEYS) ||
    !hasExactKeys(observed.afterStart, STORAGE_IDENTITY_KEYS) ||
    !hasExactKeys(observed.after, STORAGE_IDENTITY_KEYS)
  ) {
    return Object.freeze(['observed storage identity shape is invalid']);
  }
  if (
    observed.before.bootId === observed.after.bootId ||
    observed.afterStart.bootId !== observed.after.bootId
  ) {
    violations.push('boot identity did not prove a restart boundary');
  }
  for (const identity of [
    observed.before,
    observed.afterStart,
    observed.after,
  ]) {
    violations.push(...validateStorageIdentity(manifest, identity, dataPath));
    if (
      typeof identity.bootId !== 'string' ||
      identity.bootId.length < 8 ||
      !Number.isSafeInteger(identity.sectorsWritten) ||
      identity.sectorsWritten < 0
    ) {
      violations.push('storage identity counters are invalid');
    }
  }
  if (
    observed.before.blockDevice !== observed.afterStart.blockDevice ||
    observed.afterStart.blockDevice !== observed.after.blockDevice ||
    observed.after.sectorsWritten < observed.afterStart.sectorsWritten
  ) {
    violations.push('block device identity or counter drifted');
  }
  if (
    !hasExactKeys(measurements, REPORT_MEASUREMENT_KEYS) ||
    REPORT_MEASUREMENT_KEYS.some(
      (key) =>
        !Number.isSafeInteger(measurements[key]) || measurements[key] < 0,
    )
  ) {
    violations.push('storage measurements are invalid');
  }
  if (
    !hasExactKeys(outcomes, REPORT_OUTCOME_KEYS) ||
    outcomes.commitStatus !== 'collected' ||
    outcomes.replayStatus !== 'existing' ||
    outcomes.sqliteIntegrity !== 'ok' ||
    outcomes.stageRemoved !== true ||
    outcomes.tombstonePresent !== true ||
    outcomes.retainedSnapshots !== 2
  ) {
    violations.push('production collection recovery outcome is invalid');
  }
  if (
    Number.isSafeInteger(measurements.prepareWriteAmplificationPermille) &&
    Number.isSafeInteger(measurements.resumeWriteAmplificationPermille) &&
    (measurements.prepareWriteAmplificationPermille >
      manifest.maximumPrepareWriteAmplificationPermille ||
      measurements.resumeWriteAmplificationPermille >
        manifest.maximumResumeWriteAmplificationPermille)
  ) {
    violations.push('device write amplification exceeded manifest budget');
  }
  if (
    !isSnapshot(targetSnapshot) ||
    measurements.reclaimedAllocatedBytes < 1 ||
    measurements.collectedSnapshotBytes !== targetSnapshot?.bytes ||
    measurements.barrierAllocatedBytes - measurements.finalAllocatedBytes !==
      measurements.reclaimedAllocatedBytes
  ) {
    violations.push('snapshot allocation was not reclaimed');
  }
  if (
    amplificationPermille(
      measurements.prepareDeviceBytesWritten,
      measurements.logicalSnapshotBytes,
    ) !== measurements.prepareWriteAmplificationPermille ||
    amplificationPermille(
      measurements.resumeDeviceBytesWritten,
      measurements.collectedSnapshotBytes,
    ) !== measurements.resumeWriteAmplificationPermille
  ) {
    violations.push('write amplification calculation drifted');
  }
  return Object.freeze(violations);
}

function buildComposeStorageReport({
  manifest,
  session,
  observed,
  measurements,
  outcomes,
  generatedAt,
}) {
  const violations = evaluateComposeStorageEvidence({
    manifest,
    dataPath: session.dataPath,
    targetSnapshot: session.collection.target.snapshot,
    observed,
    measurements,
    outcomes,
  });
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_compose_storage_candidate',
    supported: false,
    generatedAt,
    manifest,
    session: {
      sessionId: session.sessionId,
      sessionDigest: session.sha256,
      preparedAt: session.preparedAt,
      targetRolloutId: session.collection.target.rolloutId,
      targetSnapshot: session.collection.target.snapshot,
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

function validateComposeStorageReport(report, manifest, currentObserved) {
  const violations = [];
  if (!hasExactKeys(report, REPORT_KEYS)) {
    return Object.freeze(['Compose storage report shape is invalid']);
  }
  const { sha256, ...body } = report;
  if (!SHA256_PATTERN.test(sha256 ?? '') || canonicalDigest(body) !== sha256) {
    violations.push('Compose storage report SHA-256 is invalid');
  }
  if (
    report.schemaVersion !== 1 ||
    report.evidenceClass !== 'physical_edge_compose_storage_candidate' ||
    report.supported !== false ||
    !Number.isFinite(Date.parse(report.generatedAt ?? ''))
  ) {
    violations.push('Compose storage report identity is invalid');
  }
  if (
    !hasExactKeys(report.session, REPORT_SESSION_KEYS) ||
    !UUID_V4_PATTERN.test(report.session?.sessionId ?? '') ||
    !SHA256_PATTERN.test(report.session?.sessionDigest ?? '') ||
    !UUID_V4_PATTERN.test(report.session?.targetRolloutId ?? '') ||
    !isSnapshot(report.session?.targetSnapshot) ||
    !Number.isFinite(Date.parse(report.session?.preparedAt ?? '')) ||
    !hasExactKeys(report.qualification, REPORT_QUALIFICATION_KEYS)
  ) {
    violations.push('Compose storage report evidence shape is invalid');
  }
  if (
    canonicalDigest(report.manifest) !== canonicalDigest(manifest) ||
    report.manifest.deviceId !== manifest.deviceId
  ) {
    violations.push('Compose storage report manifest did not match');
  }
  if (
    report.observed?.after?.bootId !== currentObserved.bootId ||
    report.observed?.after?.architecture !== currentObserved.architecture ||
    report.observed?.after?.filesystem !== currentObserved.dataFilesystem ||
    report.observed?.after?.mountPath !== currentObserved.dataPath
  ) {
    violations.push('Compose storage report current device did not match');
  }
  const recomputed = evaluateComposeStorageEvidence({
    manifest,
    dataPath: currentObserved.dataPath,
    targetSnapshot: report.session?.targetSnapshot,
    observed: report.observed,
    measurements: report.measurements,
    outcomes: report.outcomes,
  });
  if (
    report.qualification?.passed !== (recomputed.length === 0) ||
    !Array.isArray(report.qualification?.violations) ||
    JSON.stringify(report.qualification.violations) !==
      JSON.stringify(recomputed) ||
    JSON.stringify(report.qualification?.measures) !==
      JSON.stringify(MEASURES) ||
    JSON.stringify(report.qualification?.doesNotProve) !==
      JSON.stringify(EXCLUSIONS) ||
    recomputed.length > 0
  ) {
    violations.push('Compose storage report qualification was widened');
  }
  return Object.freeze(violations);
}

async function resumePhase(options, manifest) {
  const session = normalizeSession(
    readBoundedJson(options.sessionPath, 'session'),
  );
  if (session.manifestDigest !== canonicalDigest(manifest)) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'session manifest digest did not match',
    );
  }
  if (session.uid !== process.getuid?.()) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'session POSIX identity changed',
    );
  }
  const dataPath = fs.realpathSync(session.dataPath);
  if (dataPath !== session.dataPath) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'session dataPath is no longer canonical',
    );
  }
  assertPrivateDirectory(dataPath, 'dataPath');
  assertChildPath(session.dataPath, options.sessionPath, 'sessionPath');
  assertChildPath(session.dataPath, options.outputPath, 'outputPath');
  const deploymentRoot = fs.realpathSync(session.deploymentRoot);
  if (deploymentRoot !== session.deploymentRoot) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'session deploymentRoot is no longer canonical',
    );
  }
  assertPrivateDirectory(deploymentRoot, 'deploymentRoot');
  const preparedIdentityViolations = validateStorageIdentity(
    manifest,
    session.barrier.identity,
    session.dataPath,
  );
  if (preparedIdentityViolations.length > 0) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      `prepared storage identity rejected: ${preparedIdentityViolations.join(
        '; ',
      )}`,
    );
  }
  const products = requireBuiltProducts();
  const afterStart = collectStorageIdentity(session.dataPath);
  const resumeIdentityViolations = validateStorageIdentity(
    manifest,
    afterStart,
    session.dataPath,
  );
  if (resumeIdentityViolations.length > 0) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      `resume storage identity rejected: ${resumeIdentityViolations.join(
        '; ',
      )}`,
    );
  }
  if (afterStart.bootId === session.barrier.identity.bootId) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'resume requires a different Linux boot identity',
    );
  }
  if (
    afterStart.blockDevice !== session.barrier.identity.blockDevice ||
    afterStart.filesystem !== session.barrier.identity.filesystem
  ) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'storage identity changed across reboot',
    );
  }
  const committed =
    await products.deployment.collectLocalDeploymentComposeEvidence(
      session.collection.commitCommand,
    );
  const replay =
    await products.deployment.collectLocalDeploymentComposeEvidence(
      session.collection.commitCommand,
    );
  const databaseEvidence =
    await products.rolloutSafety.inspectLocalSqliteSnapshot({
      databasePath: path.join(session.deploymentRoot, 'qinglong3.sqlite'),
      profile: 'edge',
    });
  const after = collectStorageIdentity(session.dataPath);
  const afterTree = collectTreeStorage(session.deploymentRoot);
  const retainedSnapshots = fs
    .readdirSync(
      path.join(session.deploymentRoot, 'service', 'rollout-backups'),
    )
    .filter((entry) => entry.endsWith('.sqlite')).length;
  const tombstonePath = path.join(
    session.deploymentRoot,
    'service',
    'collected-evidence',
    'rollout-backups',
    `${session.collection.target.rolloutId}.json`,
  );
  const resumeDeviceBytesWritten =
    (after.sectorsWritten - afterStart.sectorsWritten) * SECTOR_BYTES;
  const reclaimedAllocatedBytes =
    session.barrier.tree.allocatedBytes - afterTree.allocatedBytes;
  const measurements = Object.freeze({
    logicalSnapshotBytes: session.prepareMeasurement.logicalSnapshotBytes,
    collectedSnapshotBytes: session.collection.target.snapshot.bytes,
    prepareDeviceBytesWritten: session.prepareMeasurement.deviceBytesWritten,
    resumeDeviceBytesWritten,
    prepareWriteAmplificationPermille:
      session.prepareMeasurement.writeAmplificationPermille,
    resumeWriteAmplificationPermille: amplificationPermille(
      resumeDeviceBytesWritten,
      session.collection.target.snapshot.bytes,
    ),
    barrierAllocatedBytes: session.barrier.tree.allocatedBytes,
    finalAllocatedBytes: afterTree.allocatedBytes,
    reclaimedAllocatedBytes,
  });
  const outcomes = Object.freeze({
    commitStatus: committed.status,
    replayStatus: replay.status,
    sqliteIntegrity: databaseEvidence.contractVersion === 44 ? 'ok' : 'invalid',
    stageRemoved: !fs.existsSync(session.collection.stagePath),
    tombstonePresent: fs.existsSync(tombstonePath),
    retainedSnapshots,
  });
  const report = buildComposeStorageReport({
    manifest,
    session,
    observed: {
      before: session.barrier.identity,
      afterStart,
      after,
    },
    measurements,
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

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new QingLong3PhysicalComposeStorageEvidenceError(
      'Node.js 24 or newer is required',
    );
  }
  const options = parseArguments(process.argv.slice(2));
  const manifest = readManifest(options.manifestPath);
  if (options.phase === 'prepare') {
    await preparePhase(options, manifest);
  } else {
    await resumePhase(options, manifest);
  }
}

module.exports = {
  QingLong3PhysicalComposeStorageEvidenceError,
  amplificationPermille,
  buildComposeStorageReport,
  evaluateComposeStorageEvidence,
  normalizeComposeStorageManifest,
  normalizeSession,
  parseArguments,
  parseSectorsWritten,
  validateComposeStorageReport,
  validateStorageIdentity,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
