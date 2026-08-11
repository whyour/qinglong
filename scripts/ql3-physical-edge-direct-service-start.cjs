#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  collectArtifactIdentity,
  preflightArtifactMetadata,
  readBootAgeMs,
  validateArtifactAgainstManifest,
} = require('./ql3-physical-edge-application-start.cjs');
const {
  canonicalDigest,
  collectObservedPlatform,
} = require('./ql3-physical-edge-evidence.cjs');
const { installContract } = require('./ql3-physical-edge-service-start.cjs');
const {
  parseProcStat,
  parseProcStatus,
} = require('./ql3-physical-edge-idle-sampler.cjs');

const MIB = 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_RECEIPT_BYTES = 4096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_SERVICE_NAME_PATTERN = /^qinglong3$/;
const SERVICE_BRIDGE_CONTROLLER_ROOT = '/var/lib/qinglong3-service-bridge';
const RECEIPT_SCHEMA = 'qinglong/local-application-startup-receipt@v1';
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
  'maximumBootToActiveMs',
  'maximumServiceStartBootAgeMs',
  'maximumServiceStartToActiveMs',
  'profile',
  'schemaVersion',
  'serviceManager',
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
  'virtualizationIndicators',
]);
const PATH_KEYS = Object.freeze([
  'applicationConfig',
  'applicationEntrypoint',
  'artifactRoot',
  'dataPath',
  'deploymentRoot',
  'startupReceipt',
]);
const SERVICE_KEYS = Object.freeze([
  'applicationConfigSha256',
  'descriptorDestination',
  'descriptorMode',
  'descriptorSha256',
  'descriptorSource',
  'enableArguments',
  'enableExecutable',
  'enableSha256',
  'installArguments',
  'kind',
  'managerExecutable',
  'managerSha256',
  'serviceName',
  'supervisorExecutable',
  'supervisorSha256',
]);
const SESSION_KEYS = Object.freeze([
  'artifact',
  'bridge',
  'environment',
  'evidenceClass',
  'manifestDigest',
  'paths',
  'preparedAt',
  'schemaVersion',
  'service',
  'sessionId',
  'sha256',
  'uid',
]);
const BRIDGE_KEYS = Object.freeze([
  'actionId',
  'controllerRoot',
  'intentDigest',
  'intentPath',
  'outcomePath',
]);
const RECEIPT_KEYS = Object.freeze([
  'activeBootAgeMs',
  'aiStatus',
  'bootId',
  'instanceId',
  'nodeExecutable',
  'nodeVersion',
  'processId',
  'processStartTicks',
  'profile',
  'schema',
  'schemaVersion',
  'sha256',
]);
const PROCESS_KEYS = Object.freeze([
  'bootId',
  'clockTicksPerSecond',
  'nodeParentPid',
  'nodePid',
  'nodeStartTicks',
]);
const OBSERVED_SERVICE_KEYS = Object.freeze([
  'descriptorSha256',
  'kind',
  'mainPid',
  'mainStartMonotonicUs',
  'managerExecutable',
  'managerSha256',
  'serviceName',
]);
const OBSERVED_KEYS = Object.freeze([
  'after',
  'artifact',
  'bridge',
  'process',
  'receipt',
  'service',
]);
const OBSERVED_BRIDGE_KEYS = Object.freeze([
  'actionId',
  'intentDigest',
  'observationDigest',
  'outcomeDigest',
  'state',
]);
const MEASUREMENT_KEYS = Object.freeze([
  'activeBootAgeMs',
  'bootToActiveMs',
  'serviceStartBootAgeMs',
  'serviceStartToActiveMs',
]);
const OUTCOME_KEYS = Object.freeze([
  'aiStatus',
  'descriptorInstalled',
  'initSupervisionMatched',
  'managerStartMonotonicMatched',
  'nodeProcessIdentityMatched',
  'ownerBridgeOutcomeVerified',
  'serviceActive',
  'serviceEnabled',
  'startupReceiptValidated',
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
  'bridgeActionId',
  'bridgeIntentDigest',
  'prepareBootId',
  'preparedAt',
  'sessionDigest',
  'sessionId',
]);
const QUALIFICATION_KEYS = Object.freeze([
  'doesNotProve',
  'measures',
  'passed',
  'violations',
]);
const MEASURES = Object.freeze([
  'different_boot_identity',
  'owner_intent_root_service_bridge_owner_outcome',
  'kernel_boot_to_direct_init_managed_node_process_start',
  'kernel_boot_to_production_application_active_receipt',
  'direct_production_release_descriptor_and_invocation',
  'exact_ai_excluded_native_release_closure',
  'live_node_process_and_init_supervision_identity',
  'init_managed_service_active_and_enabled',
  'single_current_bounded_startup_receipt',
]);
const EXCLUSIONS = Object.freeze([
  'firmware_or_bootloader_power_on_to_linux_kernel_clock',
  'exclusive_cold_page_cache_or_dynamic_linker_provenance',
  'application_rss_or_io_before_active',
  'stdout_active_event_delivery_after_receipt_publication',
  'graceful_service_manager_stop_or_disable',
  'unexpected_power_loss_recovery',
  'compose_or_container_runtime_start',
  'standalone_or_cluster_profile',
  'release_archive_signature_or_attestation',
]);

class QingLong3PhysicalDirectServiceStartEvidenceError extends Error {
  constructor(message) {
    super(
      `QingLong 3.0 physical Edge direct service start evidence failed: ${message}`,
    );
    this.name = 'QingLong3PhysicalDirectServiceStartEvidenceError';
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

function exactKeys(value, expected, label) {
  if (!hasExactKeys(value, expected)) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      `${label} keys must be exactly ${expected.join(', ')}`,
    );
  }
}

function normalizeDirectServiceStartManifest(value) {
  exactKeys(value, MANIFEST_KEYS, 'manifest');
  if (
    value.schemaVersion !== 1 ||
    value.evidenceClass !== 'physical_edge_direct_service_start_candidate' ||
    value.profile !== 'edge' ||
    !['systemd', 'openrc'].includes(value.serviceManager) ||
    typeof value.deviceId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.deviceId) ||
    !['x64', 'arm64', 'arm'].includes(value.expectedArchitecture) ||
    typeof value.expectedFilesystem !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(value.expectedFilesystem) ||
    !SHA256_PATTERN.test(value.expectedArtifactSha256 ?? '') ||
    !Number.isSafeInteger(value.expectedArtifactFiles) ||
    value.expectedArtifactFiles < 1 ||
    value.expectedArtifactFiles > 768 ||
    !Number.isSafeInteger(value.expectedArtifactBytes) ||
    value.expectedArtifactBytes < 1 ||
    value.expectedArtifactBytes > 8 * MIB ||
    !SHA256_PATTERN.test(value.expectedNodeSha256 ?? '') ||
    !Number.isSafeInteger(value.maximumBootToActiveMs) ||
    value.maximumBootToActiveMs < 10_000 ||
    value.maximumBootToActiveMs > 600_000 ||
    !Number.isSafeInteger(value.maximumServiceStartBootAgeMs) ||
    value.maximumServiceStartBootAgeMs < 1_000 ||
    value.maximumServiceStartBootAgeMs > 300_000 ||
    !Number.isSafeInteger(value.maximumServiceStartToActiveMs) ||
    value.maximumServiceStartToActiveMs < 100 ||
    value.maximumServiceStartToActiveMs > 120_000 ||
    value.maximumServiceStartBootAgeMs > value.maximumBootToActiveMs ||
    value.maximumServiceStartToActiveMs > value.maximumBootToActiveMs
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'manifest identity or measurement budget is invalid',
    );
  }
  return Object.freeze({ ...value });
}

function parseArguments(argv) {
  const options = { json: false };
  let phase;
  for (const argument of argv) {
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (!phase && ['inspect', 'prepare', 'resume'].includes(argument)) {
      phase = argument;
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator < 1) {
      throw new QingLong3PhysicalDirectServiceStartEvidenceError(
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
    else if (name === '--root-command-output')
      options.rootCommandOutputPath = value;
    else {
      throw new QingLong3PhysicalDirectServiceStartEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
  }
  if (!phase) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'phase must be inspect, prepare or resume',
    );
  }
  const required =
    phase === 'inspect'
      ? ['artifactRoot']
      : phase === 'prepare'
      ? ['artifactRoot', 'dataPath', 'manifestPath', 'sessionPath']
      : ['manifestPath', 'outputPath', 'sessionPath'];
  for (const name of required) {
    if (
      !path.isAbsolute(options[name] ?? '') ||
      path.normalize(options[name]) !== options[name]
    ) {
      throw new QingLong3PhysicalDirectServiceStartEvidenceError(
        `${name} must be absolute and normalized`,
      );
    }
  }
  if (
    options.rootCommandOutputPath !== undefined &&
    (!path.isAbsolute(options.rootCommandOutputPath) ||
      path.normalize(options.rootCommandOutputPath) !==
        options.rootCommandOutputPath)
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'rootCommandOutputPath must be absolute and normalized',
    );
  }
  const allowed = new Set([
    'json',
    ...required,
    ...(phase === 'prepare' ? ['rootCommandOutputPath'] : []),
  ]);
  if (Object.keys(options).some((name) => !allowed.has(name))) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      `phase ${phase} received an invalid option`,
    );
  }
  return Object.freeze({ phase, ...options });
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
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
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
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      `${label} must remain inside dataPath`,
    );
  }
}

function readPrivateFile(filePath, label, maximumBytes = MAX_INPUT_BYTES) {
  const stat = fs.lstatSync(filePath);
  const uid = process.geteuid?.();
  if (
    !Number.isSafeInteger(uid) ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > maximumBytes
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      `${label} must be a bounded current-user 0600 single-link file`,
    );
  }
  return fs.readFileSync(filePath, 'utf8');
}

function readPrivateJson(filePath, label) {
  try {
    return JSON.parse(readPrivateFile(filePath, label));
  } catch (error) {
    if (error instanceof QingLong3PhysicalDirectServiceStartEvidenceError) {
      throw error;
    }
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      `${label} is invalid`,
    );
  }
}

function writeNoReplace(filePath, contents, mode = 0o600) {
  const parent = fs.realpathSync(path.dirname(filePath));
  assertPrivateDirectory(parent, 'output parent');
  if (path.join(parent, path.basename(filePath)) !== filePath) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'output path must be canonical',
    );
  }
  const descriptor = fs.openSync(filePath, 'wx', mode);
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

function findExecutable(candidates, label) {
  const uid = process.geteuid?.();
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      const stat = fs.lstatSync(resolved);
      if (
        resolved === candidate &&
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        (stat.uid === 0 || stat.uid === uid) &&
        (stat.mode & 0o022) === 0 &&
        (stat.mode & 0o111) !== 0
      ) {
        return candidate;
      }
    } catch {}
  }
  throw new QingLong3PhysicalDirectServiceStartEvidenceError(
    `${label} executable is unavailable`,
  );
}

function managerExecutable(kind) {
  return kind === 'systemd'
    ? findExecutable(['/usr/bin/systemctl', '/bin/systemctl'], 'systemd')
    : findExecutable(['/sbin/rc-service', '/usr/sbin/rc-service'], 'OpenRC');
}

function enableExecutable(kind, manager) {
  return kind === 'systemd'
    ? manager
    : findExecutable(
        ['/sbin/rc-update', '/usr/sbin/rc-update'],
        'OpenRC update',
      );
}

function supervisorExecutable(kind) {
  if (kind === 'systemd') return null;
  return findExecutable(
    ['/sbin/supervise-daemon', '/usr/sbin/supervise-daemon'],
    'OpenRC supervise-daemon',
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
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'Node executable is not trusted',
    );
  }
  return Object.freeze({
    nodeExecutable,
    nodeSha256: fileSha256(nodeExecutable),
    nodeVersion: process.version,
  });
}

function currentBoot(dataPath, node) {
  const observed = collectObservedPlatform(dataPath);
  return Object.freeze({
    platform: observed.platform,
    architecture: observed.architecture,
    bootId: observed.bootId,
    bootAgeMs: readBootAgeMs(),
    dataFilesystem: observed.dataFilesystem,
    nodeExecutable: node.nodeExecutable,
    nodeSha256: node.nodeSha256,
    nodeVersion: node.nodeVersion,
    virtualizationIndicators: observed.virtualizationIndicators,
  });
}

function validateEnvironment(manifest, environment) {
  const violations = [];
  if (
    environment.platform !== 'linux' ||
    environment.architecture !== manifest.expectedArchitecture ||
    environment.dataFilesystem !== manifest.expectedFilesystem ||
    environment.nodeSha256 !== manifest.expectedNodeSha256 ||
    !/^v24\.\d+\.\d+$/.test(environment.nodeVersion ?? '') ||
    !path.isAbsolute(environment.nodeExecutable ?? '') ||
    !BOOT_ID_PATTERN.test(environment.bootId ?? '') ||
    !Array.isArray(environment.virtualizationIndicators) ||
    environment.virtualizationIndicators.length > 0
  ) {
    violations.push('device, Node or boot environment did not match manifest');
  }
  return Object.freeze(violations);
}

function validArtifact(value) {
  return (
    hasExactKeys(value, ARTIFACT_KEYS) &&
    SHA256_PATTERN.test(value.artifactSha256 ?? '') &&
    SHA256_PATTERN.test(value.artifactMetadataSha256 ?? '') &&
    SHA256_PATTERN.test(value.entrypointSha256 ?? '') &&
    Number.isSafeInteger(value.artifactFiles) &&
    value.artifactFiles >= 1 &&
    Number.isSafeInteger(value.artifactBytes) &&
    value.artifactBytes >= 1 &&
    JSON.stringify(value.packages) === JSON.stringify(REQUIRED_PACKAGES)
  );
}

function requireDeploymentProduct() {
  try {
    return require(path.join(
      __dirname,
      '..',
      'packages/ql3-local-owner-cli/dist/deployment/localDeployment.js',
    ));
  } catch (error) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      `QingLong 3.0 local deployment package must be built first: ${error.message}`,
    );
  }
}

function normalizeSession(value) {
  exactKeys(value, SESSION_KEYS, 'session');
  const { sha256, ...body } = value;
  const sessionId = value.sessionId ?? '';
  const dataPath = value.paths?.dataPath ?? '';
  const deploymentRoot = path.join(
    dataPath,
    `.ql3-direct-service-start-deployment-${sessionId}`,
  );
  const serviceName = 'qinglong3';
  const descriptorSource = path.join(
    deploymentRoot,
    'service',
    value.service?.kind === 'systemd'
      ? 'qinglong3.service'
      : 'qinglong3.openrc',
  );
  const install = installContract(
    value.service?.kind,
    serviceName,
    descriptorSource,
  );
  const expectedEntrypoint = path.join(
    value.paths?.artifactRoot ?? '',
    'node_modules',
    '@qinglong',
    'local-application',
    'dist',
    'cli.js',
  );
  const managerPattern =
    value.service?.kind === 'systemd'
      ? /^\/(?:usr\/)?bin\/systemctl$/
      : /^\/(?:usr\/)?sbin\/rc-service$/;
  const enablePattern =
    value.service?.kind === 'systemd'
      ? /^\/(?:usr\/)?bin\/systemctl$/
      : /^\/(?:usr\/)?sbin\/rc-update$/;
  const supervisorPattern = /^\/(?:usr\/)?sbin\/supervise-daemon$/;
  if (
    value.schemaVersion !== 1 ||
    value.evidenceClass !== 'physical_edge_direct_service_start_session' ||
    !UUID_V4_PATTERN.test(sessionId) ||
    !SHA256_PATTERN.test(value.manifestDigest ?? '') ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    !Number.isFinite(Date.parse(value.preparedAt ?? '')) ||
    !validArtifact(value.artifact) ||
    !hasExactKeys(value.environment, ENVIRONMENT_KEYS) ||
    !hasExactKeys(value.bridge, BRIDGE_KEYS) ||
    value.environment.platform !== 'linux' ||
    !hasExactKeys(value.paths, PATH_KEYS) ||
    !hasExactKeys(value.service, SERVICE_KEYS) ||
    !['systemd', 'openrc'].includes(value.service.kind) ||
    value.paths.deploymentRoot !== deploymentRoot ||
    value.paths.applicationEntrypoint !== expectedEntrypoint ||
    value.paths.applicationConfig !==
      path.join(deploymentRoot, 'local-application.json') ||
    value.paths.startupReceipt !==
      `${value.paths.applicationConfig}.active.json` ||
    value.service.serviceName !== serviceName ||
    !SAFE_SERVICE_NAME_PATTERN.test(value.service.serviceName) ||
    value.bridge.actionId !== sessionId ||
    value.bridge.controllerRoot !== SERVICE_BRIDGE_CONTROLLER_ROOT ||
    !SHA256_PATTERN.test(value.bridge.intentDigest ?? '') ||
    value.bridge.intentPath !==
      path.join(
        deploymentRoot,
        'service',
        'service-manager-intents',
        `${sessionId}.json`,
      ) ||
    value.bridge.outcomePath !==
      path.join(
        deploymentRoot,
        'service',
        'service-manager-outcomes',
        `${sessionId}.json`,
      ) ||
    value.service.descriptorSource !== descriptorSource ||
    value.service.descriptorDestination !== install.descriptorDestination ||
    value.service.descriptorMode !== install.descriptorMode ||
    JSON.stringify(value.service.installArguments) !==
      JSON.stringify(install.installArguments) ||
    JSON.stringify(value.service.enableArguments) !==
      JSON.stringify(install.enableArguments) ||
    !SHA256_PATTERN.test(value.service.applicationConfigSha256 ?? '') ||
    !SHA256_PATTERN.test(value.service.descriptorSha256 ?? '') ||
    !SHA256_PATTERN.test(value.service.managerSha256 ?? '') ||
    !SHA256_PATTERN.test(value.service.enableSha256 ?? '') ||
    (value.service.kind === 'systemd'
      ? value.service.supervisorExecutable !== null ||
        value.service.supervisorSha256 !== null
      : !path.isAbsolute(value.service.supervisorExecutable ?? '') ||
        !SHA256_PATTERN.test(value.service.supervisorSha256 ?? '')) ||
    !managerPattern.test(value.service.managerExecutable ?? '') ||
    !enablePattern.test(value.service.enableExecutable ?? '') ||
    (value.service.kind === 'systemd' &&
      (value.service.enableExecutable !== value.service.managerExecutable ||
        value.service.enableSha256 !== value.service.managerSha256)) ||
    (value.service.kind === 'openrc' &&
      !supervisorPattern.test(value.service.supervisorExecutable ?? '')) ||
    value.sha256 !== canonicalDigest(body)
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'session is invalid or drifted',
    );
  }
  for (const name of ['deploymentRoot', 'startupReceipt']) {
    assertChildPath(dataPath, value.paths[name], `paths.${name}`);
  }
  for (const name of ['intentPath', 'outcomePath']) {
    assertChildPath(deploymentRoot, value.bridge[name], `bridge.${name}`);
  }
  return Object.freeze(value);
}

function parseStartupReceipt(contents) {
  if (
    typeof contents !== 'string' ||
    Buffer.byteLength(contents, 'utf8') < 1 ||
    Buffer.byteLength(contents, 'utf8') > MAX_RECEIPT_BYTES
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'startup receipt is outside its byte limit',
    );
  }
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'startup receipt is not JSON',
    );
  }
  exactKeys(value, RECEIPT_KEYS, 'startup receipt');
  const { sha256, ...body } = value;
  const expectedDigest = crypto
    .createHash('sha256')
    .update('qinglong.local-application-startup-receipt.v1\0', 'utf8')
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
  if (
    value.schemaVersion !== 1 ||
    value.schema !== RECEIPT_SCHEMA ||
    typeof value.instanceId !== 'string' ||
    value.instanceId.length < 1 ||
    value.instanceId.length > 128 ||
    !['edge', 'standalone'].includes(value.profile) ||
    !['deployment_excluded', 'schema_absent', 'inactive', 'active'].includes(
      value.aiStatus,
    ) ||
    !BOOT_ID_PATTERN.test(value.bootId ?? '') ||
    !Number.isSafeInteger(value.activeBootAgeMs) ||
    value.activeBootAgeMs < 0 ||
    value.activeBootAgeMs > 31_536_000_000 ||
    !Number.isSafeInteger(value.processId) ||
    value.processId < 1 ||
    value.processId > 4_194_304 ||
    !/^[1-9][0-9]{0,19}$/.test(value.processStartTicks ?? '') ||
    !path.isAbsolute(value.nodeExecutable ?? '') ||
    !/^v24\.\d+\.\d+$/.test(value.nodeVersion ?? '') ||
    !SHA256_PATTERN.test(sha256 ?? '') ||
    sha256 !== expectedDigest
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'startup receipt values or digest are invalid',
    );
  }
  return Object.freeze({ ...value });
}

function runBounded(executable, arguments_, label) {
  const result = spawnSync(executable, arguments_, {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
  });
  if (result.error || result.signal !== null) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      `${label} probe failed`,
    );
  }
  return result;
}

function parseAuxiliaryVectorClockTicks(material, wordBytes, endianness) {
  if (
    !Buffer.isBuffer(material) ||
    ![4, 8].includes(wordBytes) ||
    !['BE', 'LE'].includes(endianness) ||
    material.byteLength < wordBytes * 2 ||
    material.byteLength > 4096 ||
    material.byteLength % (wordBytes * 2) !== 0
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'Linux auxiliary vector shape is invalid',
    );
  }
  const readWord = (offset) => {
    if (wordBytes === 4) {
      return endianness === 'LE'
        ? material.readUInt32LE(offset)
        : material.readUInt32BE(offset);
    }
    const value =
      endianness === 'LE'
        ? material.readBigUInt64LE(offset)
        : material.readBigUInt64BE(offset);
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new QingLong3PhysicalDirectServiceStartEvidenceError(
        'Linux auxiliary vector value is outside the safe range',
      );
    }
    return number;
  };
  for (
    let offset = 0;
    offset + wordBytes * 2 <= material.byteLength;
    offset += wordBytes * 2
  ) {
    const type = readWord(offset);
    const value = readWord(offset + wordBytes);
    if (type === 0) break;
    if (type === 17) {
      if (!Number.isSafeInteger(value) || value < 10 || value > 10_000) {
        throw new QingLong3PhysicalDirectServiceStartEvidenceError(
          'kernel clock tick rate is invalid',
        );
      }
      return value;
    }
  }
  throw new QingLong3PhysicalDirectServiceStartEvidenceError(
    'AT_CLKTCK is absent from the Linux auxiliary vector',
  );
}

function readLinuxClockTicksPerSecond(filePath = '/proc/self/auxv') {
  if (!['x64', 'arm64', 'arm'].includes(process.arch)) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'Linux auxiliary vector architecture is unsupported',
    );
  }
  const wordBytes = process.arch === 'arm' ? 4 : 8;
  const descriptor = fs.openSync(filePath, 'r');
  const material = Buffer.allocUnsafe(4097);
  try {
    const bytesRead = fs.readSync(
      descriptor,
      material,
      0,
      material.byteLength,
      0,
    );
    if (bytesRead < wordBytes * 2 || bytesRead > 4096) {
      throw new QingLong3PhysicalDirectServiceStartEvidenceError(
        'Linux auxiliary vector is outside its byte limit',
      );
    }
    return parseAuxiliaryVectorClockTicks(
      material.subarray(0, bytesRead),
      wordBytes,
      os.endianness(),
    );
  } finally {
    material.fill(0);
    fs.closeSync(descriptor);
  }
}

function processStartBootAgeMs(startTicks, clockTicksPerSecond) {
  if (
    !/^[1-9][0-9]{0,19}$/.test(String(startTicks)) ||
    !Number.isSafeInteger(clockTicksPerSecond) ||
    clockTicksPerSecond < 10 ||
    clockTicksPerSecond > 10_000
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'process monotonic clock values are invalid',
    );
  }
  const ticks = BigInt(startTicks);
  const frequency = BigInt(clockTicksPerSecond);
  const milliseconds = (ticks * 1000n + frequency / 2n) / frequency;
  const value = Number(milliseconds);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'process monotonic start is outside the supported range',
    );
  }
  return value;
}

function readCmdline(processId) {
  return fs
    .readFileSync(`/proc/${processId}/cmdline`)
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function directProcessIdentity(session, receipt, clockTicksPerSecond) {
  const nodeStat = parseProcStat(
    fs.readFileSync(`/proc/${receipt.processId}/stat`, 'utf8'),
  );
  const nodeStatusSource = fs.readFileSync(
    `/proc/${receipt.processId}/status`,
    'utf8',
  );
  const nodeStatus = parseProcStatus(nodeStatusSource);
  const parentMatch = /^PPid:\s+([0-9]+)$/m.exec(nodeStatusSource);
  const nodeParentPid = Number(parentMatch?.[1]);
  if (!Number.isSafeInteger(nodeParentPid) || nodeParentPid < 1) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'direct Node parent process is invalid',
    );
  }
  const nodeExecutable = fs.realpathSync(`/proc/${receipt.processId}/exe`);
  const nodeArguments = readCmdline(receipt.processId);
  const expectedArguments = [
    session.environment.nodeExecutable,
    session.paths.applicationEntrypoint,
    '--config',
    session.paths.applicationConfig,
  ];
  const nodeMatched =
    nodeStatus.uid === session.uid &&
    nodeStat.processId === receipt.processId &&
    String(nodeStat.startTicks) === receipt.processStartTicks &&
    nodeExecutable === session.environment.nodeExecutable &&
    JSON.stringify(nodeArguments) === JSON.stringify(expectedArguments);
  let initSupervisionMatched = false;
  if (session.service.kind === 'systemd') {
    initSupervisionMatched = nodeParentPid === 1;
  } else {
    const parentExecutable = fs.realpathSync(`/proc/${nodeParentPid}/exe`);
    initSupervisionMatched =
      parentExecutable === session.service.supervisorExecutable &&
      fileSha256(parentExecutable) === session.service.supervisorSha256;
  }
  return Object.freeze({
    bootId: receipt.bootId,
    nodePid: receipt.processId,
    nodeParentPid,
    nodeStartTicks: nodeStat.startTicks,
    clockTicksPerSecond,
    nodeMatched,
    initSupervisionMatched,
    serviceStartBootAgeMs: processStartBootAgeMs(
      receipt.processStartTicks,
      clockTicksPerSecond,
    ),
  });
}

function parseOpenRcDirectState(statusCode, updateOutput, serviceName) {
  const enabled =
    typeof updateOutput === 'string' &&
    updateOutput
      .split('\n')
      .some(
        (line) =>
          new RegExp(`^\\s*${serviceName.replaceAll('-', '\\-')}\\s+\\|`).test(
            line,
          ) && /\bdefault\b/.test(line),
      );
  return Object.freeze({
    active: statusCode === 0,
    enabled,
  });
}

function parseSystemdDirectShow(contents) {
  const values = {};
  for (const line of contents.trim().split('\n')) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  exactKeys(
    values,
    [
      'ActiveState',
      'ExecMainStartTimestampMonotonic',
      'FragmentPath',
      'LoadState',
      'MainPID',
      'SubState',
      'UnitFileState',
    ],
    'systemd show',
  );
  const mainPid = Number(values.MainPID);
  const mainStartMonotonicUs = Number(values.ExecMainStartTimestampMonotonic);
  if (
    !Number.isSafeInteger(mainPid) ||
    mainPid < 1 ||
    !Number.isSafeInteger(mainStartMonotonicUs) ||
    mainStartMonotonicUs < 1
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'systemd process identity or monotonic start is invalid',
    );
  }
  return Object.freeze({
    active:
      values.LoadState === 'loaded' &&
      values.ActiveState === 'active' &&
      values.SubState === 'running',
    enabled: ['enabled', 'enabled-runtime'].includes(values.UnitFileState),
    fragmentPath: values.FragmentPath,
    mainPid,
    mainStartMonotonicUs,
  });
}

function inspectServiceManager(session, nodePid) {
  if (session.service.kind === 'systemd') {
    const result = runBounded(
      session.service.managerExecutable,
      [
        '--no-pager',
        'show',
        `${session.service.serviceName}.service`,
        '--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,MainPID,ExecMainStartTimestampMonotonic',
      ],
      'systemd',
    );
    if (result.status !== 0) {
      throw new QingLong3PhysicalDirectServiceStartEvidenceError(
        'systemd service is unavailable',
      );
    }
    return parseSystemdDirectShow(result.stdout);
  }
  const status = runBounded(
    session.service.managerExecutable,
    [session.service.serviceName, 'status'],
    'OpenRC status',
  );
  const enabled = runBounded(
    session.service.enableExecutable,
    ['show', 'default'],
    'OpenRC enabled state',
  );
  const state = parseOpenRcDirectState(
    status.status,
    enabled.stdout,
    session.service.serviceName,
  );
  return Object.freeze({
    ...state,
    fragmentPath: session.service.descriptorDestination,
    mainPid: nodePid,
    mainStartMonotonicUs: null,
  });
}

function evaluateDirectServiceStartEvidence({
  manifest,
  session,
  observed,
  measurements,
  outcomes,
}) {
  const violations = [];
  if (
    !hasExactKeys(observed, OBSERVED_KEYS) ||
    !hasExactKeys(observed.after, ENVIRONMENT_KEYS) ||
    !validArtifact(observed.artifact) ||
    !hasExactKeys(observed.bridge, OBSERVED_BRIDGE_KEYS) ||
    !hasExactKeys(observed.process, PROCESS_KEYS) ||
    !hasExactKeys(observed.receipt, RECEIPT_KEYS) ||
    !hasExactKeys(observed.service, OBSERVED_SERVICE_KEYS)
  ) {
    return Object.freeze(['direct service start observation shape is invalid']);
  }
  try {
    parseStartupReceipt(JSON.stringify(observed.receipt));
  } catch {
    violations.push('startup receipt digest or values are invalid');
  }
  if (
    !UUID_V4_PATTERN.test(observed.bridge.actionId ?? '') ||
    !SHA256_PATTERN.test(observed.bridge.intentDigest ?? '') ||
    !SHA256_PATTERN.test(observed.bridge.outcomeDigest ?? '') ||
    !SHA256_PATTERN.test(observed.bridge.observationDigest ?? '') ||
    observed.bridge.state !== 'active' ||
    observed.bridge.actionId !== session.bridge.actionId ||
    observed.bridge.intentDigest !== session.bridge.intentDigest
  ) {
    violations.push('Owner service bridge outcome binding is invalid');
  }
  const processValuesValid =
    BOOT_ID_PATTERN.test(observed.process.bootId ?? '') &&
    Number.isSafeInteger(observed.process.nodePid) &&
    observed.process.nodePid >= 1 &&
    Number.isSafeInteger(observed.process.nodeParentPid) &&
    observed.process.nodeParentPid >= 1 &&
    Number.isSafeInteger(observed.process.nodeStartTicks) &&
    observed.process.nodeStartTicks >= 1 &&
    Number.isSafeInteger(observed.process.clockTicksPerSecond) &&
    observed.process.clockTicksPerSecond >= 10 &&
    observed.process.clockTicksPerSecond <= 10_000;
  let computedServiceStartBootAgeMs;
  try {
    computedServiceStartBootAgeMs = processStartBootAgeMs(
      observed.process.nodeStartTicks,
      observed.process.clockTicksPerSecond,
    );
  } catch {
    computedServiceStartBootAgeMs = null;
  }
  const serviceValuesValid =
    Number.isSafeInteger(observed.service.mainPid) &&
    observed.service.mainPid >= 1 &&
    (observed.service.kind === 'systemd'
      ? Number.isSafeInteger(observed.service.mainStartMonotonicUs) &&
        observed.service.mainStartMonotonicUs >= 1
      : observed.service.mainStartMonotonicUs === null);
  const independentlyMatchedManagerStart =
    processValuesValid &&
    serviceValuesValid &&
    observed.service.mainPid === observed.process.nodePid &&
    (observed.service.kind === 'openrc' ||
      Math.abs(
        Math.round(observed.service.mainStartMonotonicUs / 1000) -
          computedServiceStartBootAgeMs,
      ) <= 50);
  if (!processValuesValid || !serviceValuesValid) {
    violations.push('direct process or init observation values are invalid');
  }
  if (
    observed.after.bootId === session.environment.bootId ||
    observed.after.bootId !== observed.process.bootId ||
    observed.after.bootId !== observed.receipt.bootId
  ) {
    violations.push('external reboot identity was not proven');
  }
  violations.push(...validateEnvironment(manifest, observed.after));
  if (
    JSON.stringify(observed.artifact) !== JSON.stringify(session.artifact) ||
    observed.artifact.artifactSha256 !== manifest.expectedArtifactSha256 ||
    observed.artifact.artifactFiles !== manifest.expectedArtifactFiles ||
    observed.artifact.artifactBytes !== manifest.expectedArtifactBytes ||
    observed.service.kind !== manifest.serviceManager ||
    observed.service.serviceName !== session.service.serviceName ||
    observed.service.managerExecutable !== session.service.managerExecutable ||
    observed.service.managerSha256 !== session.service.managerSha256 ||
    observed.service.descriptorSha256 !== session.service.descriptorSha256
  ) {
    violations.push('artifact, manager or descriptor identity drifted');
  }
  if (
    observed.receipt.instanceId !==
      `physical-direct-${String(session.sessionId ?? '').slice(0, 8)}` ||
    observed.receipt.profile !== 'edge' ||
    observed.receipt.aiStatus !== 'deployment_excluded' ||
    observed.receipt.processId !== observed.process.nodePid ||
    String(observed.process.nodeStartTicks) !==
      observed.receipt.processStartTicks ||
    observed.receipt.nodeExecutable !== session.environment.nodeExecutable ||
    observed.receipt.nodeVersion !== session.environment.nodeVersion
  ) {
    violations.push('startup receipt did not bind the direct release process');
  }
  if (
    !hasExactKeys(measurements, MEASUREMENT_KEYS) ||
    MEASUREMENT_KEYS.some(
      (key) =>
        !Number.isSafeInteger(measurements[key]) || measurements[key] < 0,
    ) ||
    measurements.bootToActiveMs !== measurements.activeBootAgeMs ||
    measurements.serviceStartBootAgeMs !== computedServiceStartBootAgeMs ||
    measurements.activeBootAgeMs !== observed.receipt.activeBootAgeMs ||
    measurements.serviceStartToActiveMs !==
      measurements.activeBootAgeMs - measurements.serviceStartBootAgeMs ||
    measurements.serviceStartBootAgeMs >
      manifest.maximumServiceStartBootAgeMs ||
    measurements.serviceStartToActiveMs >
      manifest.maximumServiceStartToActiveMs ||
    measurements.bootToActiveMs > manifest.maximumBootToActiveMs
  ) {
    violations.push('direct service start measurement budget is invalid');
  }
  if (
    !hasExactKeys(outcomes, OUTCOME_KEYS) ||
    outcomes.aiStatus !== 'deployment_excluded' ||
    outcomes.descriptorInstalled !== true ||
    outcomes.initSupervisionMatched !== true ||
    outcomes.managerStartMonotonicMatched !== true ||
    independentlyMatchedManagerStart !== true ||
    outcomes.nodeProcessIdentityMatched !== true ||
    outcomes.ownerBridgeOutcomeVerified !== true ||
    outcomes.serviceActive !== true ||
    outcomes.serviceEnabled !== true ||
    outcomes.startupReceiptValidated !== true
  ) {
    violations.push('direct service manager or application outcome is invalid');
  }
  return Object.freeze(violations);
}

function buildDirectServiceStartReport({
  manifest,
  session,
  observed,
  measurements,
  outcomes,
  generatedAt,
}) {
  const violations = evaluateDirectServiceStartEvidence({
    manifest,
    session,
    observed,
    measurements,
    outcomes,
  });
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_direct_service_start_candidate',
    supported: false,
    generatedAt,
    manifest,
    session: {
      bridgeActionId: session.bridge.actionId,
      bridgeIntentDigest: session.bridge.intentDigest,
      sessionId: session.sessionId,
      sessionDigest: session.sha256,
      preparedAt: session.preparedAt,
      prepareBootId: session.environment.bootId,
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

function validateDirectServiceStartReport(report, manifest, currentObserved) {
  const violations = [];
  if (!hasExactKeys(report, REPORT_KEYS)) {
    return Object.freeze(['direct service start report shape is invalid']);
  }
  const { sha256, ...body } = report;
  if (!SHA256_PATTERN.test(sha256 ?? '') || sha256 !== canonicalDigest(body)) {
    violations.push('direct service start report digest is invalid');
  }
  if (
    report.schemaVersion !== 1 ||
    report.evidenceClass !== 'physical_edge_direct_service_start_candidate' ||
    report.supported !== false ||
    !Number.isFinite(Date.parse(report.generatedAt ?? '')) ||
    canonicalDigest(report.manifest) !== canonicalDigest(manifest) ||
    !hasExactKeys(report.session, REPORT_SESSION_KEYS) ||
    report.session?.bridgeActionId !== report.session?.sessionId ||
    !SHA256_PATTERN.test(report.session?.bridgeIntentDigest ?? '') ||
    !UUID_V4_PATTERN.test(report.session?.sessionId ?? '') ||
    !SHA256_PATTERN.test(report.session?.sessionDigest ?? '') ||
    !Number.isFinite(Date.parse(report.session?.preparedAt ?? '')) ||
    !BOOT_ID_PATTERN.test(report.session?.prepareBootId ?? '') ||
    !hasExactKeys(report.qualification, QUALIFICATION_KEYS) ||
    report.observed?.after?.bootId !== currentObserved.bootId ||
    report.observed?.after?.architecture !== currentObserved.architecture ||
    report.observed?.after?.dataFilesystem !== currentObserved.dataFilesystem
  ) {
    violations.push(
      'direct service start qualification or current device drifted',
    );
  }
  const syntheticSession = {
    sessionId: report.session?.sessionId,
    bridge: {
      actionId: report.session?.bridgeActionId,
      intentDigest: report.session?.bridgeIntentDigest,
    },
    environment: {
      bootId: report.session?.prepareBootId,
      nodeExecutable: report.observed?.after?.nodeExecutable,
      nodeVersion: report.observed?.after?.nodeVersion,
    },
    artifact: report.observed?.artifact,
    service: {
      kind: report.observed?.service?.kind,
      serviceName: report.observed?.service?.serviceName,
      managerExecutable: report.observed?.service?.managerExecutable,
      managerSha256: report.observed?.service?.managerSha256,
      descriptorSha256: report.observed?.service?.descriptorSha256,
    },
  };
  const recomputed = evaluateDirectServiceStartEvidence({
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
    violations.push('direct service start qualification was widened');
  }
  return Object.freeze(violations);
}

async function preparePhase(options, manifest) {
  if (process.platform !== 'linux') {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'prepare requires Linux',
    );
  }
  const dataPath = fs.realpathSync(options.dataPath);
  assertPrivateDirectory(dataPath, 'dataPath');
  assertChildPath(dataPath, options.sessionPath, 'sessionPath');
  if (options.rootCommandOutputPath !== undefined) {
    assertChildPath(
      dataPath,
      options.rootCommandOutputPath,
      'rootCommandOutputPath',
    );
    if (options.rootCommandOutputPath === options.sessionPath) {
      throw new QingLong3PhysicalDirectServiceStartEvidenceError(
        'rootCommandOutputPath must differ from sessionPath',
      );
    }
  }
  if (fs.existsSync(options.sessionPath)) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'sessionPath already exists',
    );
  }
  const artifactIdentity = collectArtifactIdentity(options.artifactRoot);
  const node = collectNodeIdentity();
  const artifactViolations = validateArtifactAgainstManifest(
    manifest,
    artifactIdentity.artifact,
    node,
  );
  if (artifactViolations.length > 0) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      artifactViolations.join('; '),
    );
  }
  const environment = currentBoot(dataPath, node);
  const environmentViolations = validateEnvironment(manifest, environment);
  if (environmentViolations.length > 0) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      environmentViolations.join('; '),
    );
  }
  const uid = process.geteuid?.();
  if (!Number.isSafeInteger(uid)) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'a stable POSIX UID is required',
    );
  }
  const sessionId = crypto.randomUUID();
  const suffix = sessionId.slice(0, 8);
  const serviceName = 'qinglong3';
  const deploymentRoot = path.join(
    dataPath,
    `.ql3-direct-service-start-deployment-${sessionId}`,
  );
  const paths = Object.freeze({
    dataPath,
    deploymentRoot,
    artifactRoot: artifactIdentity.artifactRoot,
    applicationEntrypoint: artifactIdentity.applicationEntrypoint,
    applicationConfig: path.join(deploymentRoot, 'local-application.json'),
    startupReceipt: path.join(
      deploymentRoot,
      'local-application.json.active.json',
    ),
  });
  const timestamp = Date.now();
  const product = requireDeploymentProduct();
  const prepared = await product.prepareLocalDeployment({
    schemaVersion: 1,
    operation: 'local.deployment.prepare',
    options: {
      deploymentRoot,
      profile: 'edge',
      instanceId: `physical-direct-${suffix}`,
      busyTimeoutMs: 100,
      service: {
        kind: manifest.serviceManager,
        nodeExecutable: node.nodeExecutable,
        applicationEntrypoint: paths.applicationEntrypoint,
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
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'fresh direct Edge service deployment was not prepared',
    );
  }
  if (fs.existsSync(paths.startupReceipt)) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'startup receipt existed before the direct service boot',
    );
  }
  const descriptorSource = path.join(
    deploymentRoot,
    'service',
    manifest.serviceManager === 'systemd'
      ? 'qinglong3.service'
      : 'qinglong3.openrc',
  );
  const manager = managerExecutable(manifest.serviceManager);
  const enable = enableExecutable(manifest.serviceManager, manager);
  const supervisor = supervisorExecutable(manifest.serviceManager);
  const install = installContract(
    manifest.serviceManager,
    serviceName,
    descriptorSource,
  );
  const intent = product.prepareLocalServiceManagerIntent({
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.intent.prepare',
    options: {
      deploymentRoot,
      allowRootService: uid === 0,
    },
    request: {
      actionId: sessionId,
      action: 'install-enable-start',
      serviceKind: manifest.serviceManager,
      lineage: { mode: 'fresh' },
      requestedAtMs: timestamp + 2,
    },
  });
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_direct_service_start_session',
    sessionId,
    manifestDigest: canonicalDigest(manifest),
    uid,
    preparedAt: new Date().toISOString(),
    artifact: artifactIdentity.artifact,
    environment,
    paths,
    bridge: {
      actionId: intent.actionId,
      controllerRoot: SERVICE_BRIDGE_CONTROLLER_ROOT,
      intentDigest: intent.intentDigest,
      intentPath: intent.intentPath,
      outcomePath: intent.outcomePath,
    },
    service: {
      kind: manifest.serviceManager,
      serviceName,
      managerExecutable: manager,
      managerSha256: fileSha256(manager),
      enableExecutable: enable,
      enableSha256: fileSha256(enable),
      supervisorExecutable: supervisor,
      supervisorSha256: supervisor === null ? null : fileSha256(supervisor),
      descriptorSource,
      descriptorDestination: install.descriptorDestination,
      descriptorMode: install.descriptorMode,
      descriptorSha256: fileSha256(descriptorSource),
      applicationConfigSha256: fileSha256(paths.applicationConfig),
      installArguments: install.installArguments,
      enableArguments: install.enableArguments,
    },
  };
  const session = Object.freeze({ ...body, sha256: canonicalDigest(body) });
  writeNoReplace(options.sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  const rootBridgeCommand = Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.execute',
    options: Object.freeze({
      controllerRoot: session.bridge.controllerRoot,
      allowRootController: true,
      manager:
        session.service.kind === 'systemd'
          ? Object.freeze({
              kind: 'systemd',
              executable: session.service.managerExecutable,
            })
          : Object.freeze({
              kind: 'openrc',
              serviceExecutable: session.service.managerExecutable,
              updateExecutable: session.service.enableExecutable,
            }),
    }),
    request: Object.freeze({
      intentPath: session.bridge.intentPath,
      expectedIntentDigest: session.bridge.intentDigest,
    }),
  });
  if (options.rootCommandOutputPath !== undefined) {
    writeNoReplace(
      options.rootCommandOutputPath,
      `${JSON.stringify(rootBridgeCommand, null, 2)}\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'awaiting_root_service_bridge_and_reboot',
      sessionId,
      service: {
        kind: session.service.kind,
        serviceName,
        descriptorSource,
        descriptorDestination: session.service.descriptorDestination,
        descriptorSha256: session.service.descriptorSha256,
        ownerIntent: {
          path: session.bridge.intentPath,
          digest: session.bridge.intentDigest,
        },
        rootBridgeCommand,
      },
      directProductionNodeInvocation: true,
      automaticServiceManagerMutationPerformed: false,
      supported: false,
    })}\n`,
  );
}

async function resumePhase(options, manifest) {
  if (process.platform !== 'linux') {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'resume requires Linux',
    );
  }
  const session = normalizeSession(
    readPrivateJson(options.sessionPath, 'session'),
  );
  if (
    session.manifestDigest !== canonicalDigest(manifest) ||
    process.geteuid?.() !== session.uid
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'manifest or resume UID did not match prepare',
    );
  }
  const product = requireDeploymentProduct();
  const bridgeOutcome = product.consumeLocalServiceManagerOutcome({
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.outcome.consume',
    options: {
      deploymentRoot: session.paths.deploymentRoot,
      allowRootService: session.uid === 0,
    },
    request: {
      actionId: session.bridge.actionId,
      expectedIntentDigest: session.bridge.intentDigest,
    },
  });
  if (bridgeOutcome.status !== 'verified' || bridgeOutcome.state !== 'active') {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'Owner could not verify an active root service bridge outcome',
    );
  }
  const dataPath = fs.realpathSync(session.paths.dataPath);
  assertPrivateDirectory(dataPath, 'dataPath');
  assertChildPath(dataPath, options.outputPath, 'outputPath');
  if (fs.existsSync(options.outputPath)) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'outputPath already exists',
    );
  }
  const metadata = preflightArtifactMetadata(
    session.paths.artifactRoot,
    session.paths.applicationEntrypoint,
  );
  if (
    metadata.artifactMetadataSha256 !== session.artifact.artifactMetadataSha256
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'artifact metadata drifted before report collection',
    );
  }
  const node = collectNodeIdentity();
  const after = currentBoot(dataPath, node);
  if (
    after.bootId === session.environment.bootId ||
    validateEnvironment(manifest, after).length > 0
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'reboot or current environment preflight failed',
    );
  }
  const installed = fs.lstatSync(session.service.descriptorDestination);
  if (
    !installed.isFile() ||
    installed.isSymbolicLink() ||
    installed.uid !== 0 ||
    (installed.mode & 0o777) !== session.service.descriptorMode ||
    installed.nlink !== 1 ||
    fileSha256(session.service.descriptorDestination) !==
      session.service.descriptorSha256 ||
    fileSha256(session.service.descriptorSource) !==
      session.service.descriptorSha256 ||
    fileSha256(session.paths.applicationConfig) !==
      session.service.applicationConfigSha256 ||
    fileSha256(session.service.managerExecutable) !==
      session.service.managerSha256 ||
    fileSha256(session.service.enableExecutable) !==
      session.service.enableSha256 ||
    (session.service.supervisorExecutable !== null &&
      fileSha256(session.service.supervisorExecutable) !==
        session.service.supervisorSha256)
  ) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'descriptor, configuration or init executable drifted',
    );
  }
  const receipt = parseStartupReceipt(
    readPrivateFile(
      session.paths.startupReceipt,
      'startup receipt',
      MAX_RECEIPT_BYTES,
    ),
  );
  if (receipt.bootId !== after.bootId) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'startup receipt did not belong to the current boot',
    );
  }
  const clockTicksPerSecond = readLinuxClockTicksPerSecond();
  const processIdentity = directProcessIdentity(
    session,
    receipt,
    clockTicksPerSecond,
  );
  const serviceState = inspectServiceManager(session, receipt.processId);
  const systemdStartMs =
    serviceState.mainStartMonotonicUs === null
      ? null
      : Math.round(serviceState.mainStartMonotonicUs / 1000);
  const managerStartMonotonicMatched =
    serviceState.mainPid === receipt.processId &&
    (systemdStartMs === null ||
      Math.abs(systemdStartMs - processIdentity.serviceStartBootAgeMs) <= 50);
  const artifactIdentity = collectArtifactIdentity(session.paths.artifactRoot);
  const measurements = {
    serviceStartBootAgeMs: processIdentity.serviceStartBootAgeMs,
    activeBootAgeMs: receipt.activeBootAgeMs,
    bootToActiveMs: receipt.activeBootAgeMs,
    serviceStartToActiveMs:
      receipt.activeBootAgeMs - processIdentity.serviceStartBootAgeMs,
  };
  const report = buildDirectServiceStartReport({
    manifest,
    session,
    observed: {
      after,
      artifact: artifactIdentity.artifact,
      bridge: {
        actionId: bridgeOutcome.actionId,
        intentDigest: session.bridge.intentDigest,
        outcomeDigest: bridgeOutcome.outcomeDigest,
        observationDigest: bridgeOutcome.observationDigest,
        state: bridgeOutcome.state,
      },
      process: {
        bootId: processIdentity.bootId,
        nodePid: processIdentity.nodePid,
        nodeParentPid: processIdentity.nodeParentPid,
        nodeStartTicks: processIdentity.nodeStartTicks,
        clockTicksPerSecond: processIdentity.clockTicksPerSecond,
      },
      receipt,
      service: {
        kind: session.service.kind,
        serviceName: session.service.serviceName,
        managerExecutable: session.service.managerExecutable,
        managerSha256: session.service.managerSha256,
        descriptorSha256: session.service.descriptorSha256,
        mainPid: serviceState.mainPid,
        mainStartMonotonicUs: serviceState.mainStartMonotonicUs,
      },
    },
    measurements,
    outcomes: {
      aiStatus: receipt.aiStatus,
      descriptorInstalled:
        serviceState.fragmentPath === session.service.descriptorDestination,
      initSupervisionMatched: processIdentity.initSupervisionMatched,
      managerStartMonotonicMatched,
      nodeProcessIdentityMatched: processIdentity.nodeMatched,
      ownerBridgeOutcomeVerified: true,
      serviceActive: serviceState.active,
      serviceEnabled: serviceState.enabled,
      startupReceiptValidated: true,
    },
    generatedAt: new Date().toISOString(),
  });
  writeNoReplace(
    options.outputPath,
    `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`,
  );
  if (!report.qualification.passed) process.exitCode = 1;
}

function inspectPhase(options) {
  const artifact = collectArtifactIdentity(options.artifactRoot);
  const node = collectNodeIdentity();
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        evidenceClass: 'physical_edge_direct_service_start_inspection',
        profile: 'edge',
        artifact: artifact.artifact,
        node: {
          executable: node.nodeExecutable,
          sha256: node.nodeSha256,
          version: node.nodeVersion,
        },
        directProductionNodeInvocation: true,
        supported: false,
      },
      null,
      options.json ? 0 : 2,
    )}\n`,
  );
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new QingLong3PhysicalDirectServiceStartEvidenceError(
      'Node.js 24 or newer is required',
    );
  }
  const options = parseArguments(process.argv.slice(2));
  if (options.phase === 'inspect') {
    inspectPhase(options);
    return;
  }
  const manifest = normalizeDirectServiceStartManifest(
    readPrivateJson(options.manifestPath, 'manifest'),
  );
  if (options.phase === 'prepare') {
    await preparePhase(options, manifest);
  } else {
    await resumePhase(options, manifest);
  }
}

module.exports = {
  QingLong3PhysicalDirectServiceStartEvidenceError,
  buildDirectServiceStartReport,
  directProcessIdentity,
  evaluateDirectServiceStartEvidence,
  normalizeDirectServiceStartManifest,
  normalizeSession,
  parseArguments,
  parseAuxiliaryVectorClockTicks,
  parseOpenRcDirectState,
  parseStartupReceipt,
  parseSystemdDirectShow,
  processStartBootAgeMs,
  readLinuxClockTicksPerSecond,
  inspectServiceManager,
  validateDirectServiceStartReport,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
