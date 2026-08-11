#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  collectArtifactIdentity,
  parseEventLines,
  preflightArtifactMetadata,
  readBootAgeMs,
  validateArtifactAgainstManifest,
} = require('./ql3-physical-edge-application-start.cjs');
const {
  canonicalDigest,
  collectObservedPlatform,
} = require('./ql3-physical-edge-evidence.cjs');
const {
  parseProcStat,
  parseProcStatus,
} = require('./ql3-physical-edge-idle-sampler.cjs');

const MIB = 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_SERVICE_NAME_PATTERN = /^qinglong3-physical-[0-9a-f]{8}$/;
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
  'activeRecord',
  'applicationConfig',
  'applicationEntrypoint',
  'artifactRoot',
  'dataPath',
  'deploymentRoot',
  'eventLog',
  'fifo',
  'nodeRecord',
  'stderrLog',
  'toolRoot',
  'wrapper',
  'wrapperStartRecord',
]);
const SERVICE_KEYS = Object.freeze([
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
  'wrapperSha256',
]);
const SESSION_KEYS = Object.freeze([
  'artifact',
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
const MEASUREMENT_KEYS = Object.freeze([
  'activeBootAgeMs',
  'activeEventOrdinal',
  'bootToActiveMs',
  'serviceStartBootAgeMs',
  'serviceStartToActiveMs',
]);
const OUTCOME_KEYS = Object.freeze([
  'activeEventCount',
  'aiStatus',
  'descriptorInstalled',
  'nodeProcessIdentityMatched',
  'serviceActive',
  'serviceEnabled',
  'stderrBytes',
  'wrapperProcessIdentityMatched',
]);
const OBSERVED_KEYS = Object.freeze([
  'after',
  'artifact',
  'process',
  'service',
]);
const PROCESS_KEYS = Object.freeze([
  'bootId',
  'nodePid',
  'nodeStartTicks',
  'wrapperPid',
  'wrapperStartTicks',
]);
const OBSERVED_SERVICE_KEYS = Object.freeze([
  'descriptorSha256',
  'kind',
  'mainPid',
  'managerExecutable',
  'managerSha256',
  'serviceName',
]);
const START_RECORD_KEYS = Object.freeze([
  'boot_id',
  'schema',
  'service_start_uptime',
  'wrapper_pid',
]);
const NODE_RECORD_KEYS = Object.freeze(['node_pid', 'schema']);
const ACTIVE_RECORD_KEYS = Object.freeze([
  'active_uptime',
  'boot_id',
  'event_ordinal',
  'schema',
]);
const MEASURES = Object.freeze([
  'different_boot_identity',
  'kernel_boot_to_evidence_service_wrapper_start',
  'kernel_boot_to_official_native_application_active',
  'init_managed_service_active_and_enabled',
  'exact_installed_production_rendered_service_descriptor',
  'pre_node_posix_uptime_anchor',
  'exact_ai_excluded_native_release_closure',
  'live_wrapper_and_node_process_identity',
]);
const EXCLUSIONS = Object.freeze([
  'firmware_or_bootloader_power_on_to_linux_kernel_clock',
  'exclusive_cold_page_cache_or_dynamic_linker_provenance',
  'direct_release_unit_without_evidence_wrapper',
  'application_rss_or_io_before_active',
  'graceful_service_manager_stop_or_disable',
  'unexpected_power_loss_recovery',
  'compose_or_container_runtime_start',
  'standalone_or_cluster_profile',
  'release_archive_signature_or_attestation',
]);

class QingLong3PhysicalServiceStartEvidenceError extends Error {
  constructor(message) {
    super(
      `QingLong 3.0 physical Edge service start evidence failed: ${message}`,
    );
    this.name = 'QingLong3PhysicalServiceStartEvidenceError';
  }
}

function exactKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)
  ) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
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

function normalizeServiceStartManifest(value) {
  exactKeys(value, MANIFEST_KEYS, 'manifest');
  if (
    value.schemaVersion !== 1 ||
    value.evidenceClass !== 'physical_edge_service_start_candidate' ||
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
    throw new QingLong3PhysicalServiceStartEvidenceError(
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
      throw new QingLong3PhysicalServiceStartEvidenceError(
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
      throw new QingLong3PhysicalServiceStartEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
  }
  if (!phase) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
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
    if (!path.isAbsolute(options[name] ?? '')) {
      throw new QingLong3PhysicalServiceStartEvidenceError(
        `${name} must be absolute`,
      );
    }
  }
  const allowed = new Set(['json', ...required]);
  if (Object.keys(options).some((name) => !allowed.has(name))) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
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
    throw new QingLong3PhysicalServiceStartEvidenceError(
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
    throw new QingLong3PhysicalServiceStartEvidenceError(
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
    throw new QingLong3PhysicalServiceStartEvidenceError(
      `${label} must be a bounded current-user 0600 single-link file`,
    );
  }
  return fs.readFileSync(filePath, 'utf8');
}

function readPrivateJson(filePath, label) {
  try {
    return JSON.parse(readPrivateFile(filePath, label));
  } catch (error) {
    if (error instanceof QingLong3PhysicalServiceStartEvidenceError) {
      throw error;
    }
    throw new QingLong3PhysicalServiceStartEvidenceError(
      `${label} is invalid: ${error.message}`,
    );
  }
}

function writeNoReplace(filePath, contents, mode = 0o600) {
  const parent = fs.realpathSync(path.dirname(filePath));
  assertPrivateDirectory(parent, 'output parent');
  if (path.join(parent, path.basename(filePath)) !== filePath) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
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
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'Node executable is not trusted',
    );
  }
  return Object.freeze({
    nodeExecutable,
    nodeSha256: fileSha256(nodeExecutable),
    nodeVersion: process.version,
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function renderEvidenceWrapper({
  applicationEntrypoint,
  nodeExecutable,
  paths,
}) {
  const q = shellQuote;
  return `#!/bin/sh
set -eu
umask 077

expected_node=${q(nodeExecutable)}
entrypoint=${q(applicationEntrypoint)}
config=${q(paths.applicationConfig)}
fifo=${q(paths.fifo)}
start_record=${q(paths.wrapperStartRecord)}
node_record=${q(paths.nodeRecord)}
active_record=${q(paths.activeRecord)}
event_log=${q(paths.eventLog)}
stderr_log=${q(paths.stderrLog)}

[ "$#" -eq 3 ] || exit 64
[ "$1" = "$expected_node" ] || exit 64
[ "$2" = "--config" ] || exit 64
[ "$3" = "$config" ] || exit 64
[ -p "$fifo" ] || exit 64
[ ! -e "$start_record" ] || exit 64
[ ! -e "$node_record" ] || exit 64
[ ! -e "$active_record" ] || exit 64
[ ! -e "$event_log" ] || exit 64
[ ! -e "$stderr_log" ] || exit 64

IFS= read -r boot_id < /proc/sys/kernel/random/boot_id
IFS=' ' read -r service_start_uptime ignored < /proc/uptime
case "$boot_id" in
  ????????-????-4???-[89ab]???-????????????) ;;
  *) exit 64 ;;
esac
case "$service_start_uptime" in
  ''|*[!0-9.]*) exit 64 ;;
esac

set -C
: > "$start_record"
: > "$event_log"
: > "$stderr_log"
set +C
printf '%s\\n' \\
  'schema=qinglong/physical-edge-service-wrapper-start@v1' \\
  "boot_id=$boot_id" \\
  "service_start_uptime=$service_start_uptime" \\
  "wrapper_pid=$$" > "$start_record"

"$expected_node" "$entrypoint" --config "$config" > "$fifo" 2> "$stderr_log" &
node_pid=$!
set -C
: > "$node_record"
set +C
printf '%s\\n' \\
  'schema=qinglong/physical-edge-service-node@v1' \\
  "node_pid=$node_pid" > "$node_record"

terminate_child() {
  kill -TERM "$node_pid" 2>/dev/null || true
}
trap terminate_child TERM INT HUP

event_ordinal=0
active_seen=0
while IFS= read -r line; do
  event_ordinal=$((event_ordinal + 1))
  [ "$event_ordinal" -le 64 ] || {
    terminate_child
    wait "$node_pid" || true
    exit 64
  }
  [ "\${#line}" -le 4096 ] || {
    terminate_child
    wait "$node_pid" || true
    exit 64
  }
  printf '%s\\n' "$line" >> "$event_log"
  active_candidate=1
  case "$line" in
    *'"component":"qinglong3-local-application"'*) ;;
    *) active_candidate=0 ;;
  esac
  case "$line" in
    *'"event":"active"'*) ;;
    *) active_candidate=0 ;;
  esac
  case "$line" in
    *'"profile":"edge"'*) ;;
    *) active_candidate=0 ;;
  esac
  case "$line" in
    *'"aiStatus":"deployment_excluded"'*) ;;
    *) active_candidate=0 ;;
  esac
  if [ "$active_candidate" -eq 1 ]; then
    [ "$active_seen" -eq 0 ] || {
      terminate_child
      wait "$node_pid" || true
      exit 64
    }
    active_seen=1
    IFS=' ' read -r active_uptime ignored < /proc/uptime
    set -C
    : > "$active_record"
    set +C
    printf '%s\\n' \\
      'schema=qinglong/physical-edge-service-active@v1' \\
      "boot_id=$boot_id" \\
      "event_ordinal=$event_ordinal" \\
      "active_uptime=$active_uptime" > "$active_record"
  fi
done < "$fifo"

wait "$node_pid"
`;
}

function parseRecord(contents, expectedKeys, schema, label) {
  const value = {};
  const lines = contents.endsWith('\n')
    ? contents.slice(0, -1).split('\n')
    : contents.split('\n');
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator < 1) {
      throw new QingLong3PhysicalServiceStartEvidenceError(
        `${label} contains an invalid line`,
      );
    }
    const key = line.slice(0, separator);
    if (Object.hasOwn(value, key)) {
      throw new QingLong3PhysicalServiceStartEvidenceError(
        `${label} contains a duplicate key`,
      );
    }
    value[key] = line.slice(separator + 1);
  }
  exactKeys(value, expectedKeys, label);
  if (value.schema !== schema) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      `${label} schema is invalid`,
    );
  }
  return Object.freeze(value);
}

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]{0,9}$/.test(value ?? '')) {
    throw new QingLong3PhysicalServiceStartEvidenceError(`${label} is invalid`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new QingLong3PhysicalServiceStartEvidenceError(`${label} is invalid`);
  }
  return number;
}

function uptimeMilliseconds(value, label) {
  if (!/^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/.test(value ?? '')) {
    throw new QingLong3PhysicalServiceStartEvidenceError(`${label} is invalid`);
  }
  const milliseconds = Math.round(Number(value) * 1000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new QingLong3PhysicalServiceStartEvidenceError(`${label} is invalid`);
  }
  return milliseconds;
}

function parseWrapperObservations({
  startContents,
  nodeContents,
  activeContents,
  eventContents,
}) {
  const start = parseRecord(
    startContents,
    START_RECORD_KEYS,
    'qinglong/physical-edge-service-wrapper-start@v1',
    'wrapper start record',
  );
  const node = parseRecord(
    nodeContents,
    NODE_RECORD_KEYS,
    'qinglong/physical-edge-service-node@v1',
    'node record',
  );
  const active = parseRecord(
    activeContents,
    ACTIVE_RECORD_KEYS,
    'qinglong/physical-edge-service-active@v1',
    'active record',
  );
  const events = [];
  const remaining = parseEventLines(eventContents, events);
  if (remaining !== '') {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'event log ended with a partial line',
    );
  }
  const activeEvents = events
    .map((event, index) => ({ event, ordinal: index + 1 }))
    .filter(({ event }) => event.event === 'active');
  const activeOrdinal = positiveInteger(
    active.event_ordinal,
    'active event ordinal',
  );
  const activeEvent = activeEvents.find(
    ({ ordinal }) => ordinal === activeOrdinal,
  )?.event;
  if (
    activeEvents.length !== 1 ||
    !activeEvent ||
    activeEvent.level !== 'info' ||
    activeEvent.profile !== 'edge' ||
    activeEvent.aiStatus !== 'deployment_excluded'
  ) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'event log does not contain one ordinal-bound official active event',
    );
  }
  const serviceStartBootAgeMs = uptimeMilliseconds(
    start.service_start_uptime,
    'service start uptime',
  );
  const activeBootAgeMs = uptimeMilliseconds(
    active.active_uptime,
    'active uptime',
  );
  if (
    active.boot_id !== start.boot_id ||
    activeBootAgeMs < serviceStartBootAgeMs
  ) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'wrapper boot identity or monotonic ordering drifted',
    );
  }
  return Object.freeze({
    bootId: start.boot_id,
    wrapperPid: positiveInteger(start.wrapper_pid, 'wrapper PID'),
    nodePid: positiveInteger(node.node_pid, 'Node PID'),
    serviceStartBootAgeMs,
    activeBootAgeMs,
    serviceStartToActiveMs: activeBootAgeMs - serviceStartBootAgeMs,
    activeEventOrdinal: activeOrdinal,
    activeEvent,
    activeEventCount: activeEvents.length,
    eventCount: events.length,
  });
}

function parseSystemdShow(contents) {
  const values = {};
  for (const line of contents.trim().split('\n')) {
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const expected = [
    'ActiveState',
    'FragmentPath',
    'LoadState',
    'MainPID',
    'SubState',
    'UnitFileState',
  ];
  exactKeys(values, expected, 'systemd show');
  return Object.freeze({
    active:
      values.LoadState === 'loaded' &&
      values.ActiveState === 'active' &&
      values.SubState === 'running',
    enabled: ['enabled', 'enabled-runtime'].includes(values.UnitFileState),
    fragmentPath: values.FragmentPath,
    mainPid: positiveInteger(values.MainPID, 'systemd MainPID'),
  });
}

function parseOpenRcState(statusCode, updateOutput, serviceName) {
  if (
    statusCode !== 0 ||
    !SAFE_SERVICE_NAME_PATTERN.test(serviceName) ||
    !updateOutput
      .split('\n')
      .some(
        (line) =>
          new RegExp(
            `^\\\\s*${serviceName.replaceAll('-', '\\\\-')}\\\\s+\\\\|`,
          ).test(line) && /\bdefault\b/.test(line),
      )
  ) {
    return Object.freeze({ active: false, enabled: false, mainPid: null });
  }
  return Object.freeze({ active: true, enabled: true, mainPid: null });
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

function normalizeSession(value) {
  exactKeys(value, SESSION_KEYS, 'session');
  const { sha256, ...body } = value;
  const expectedDeploymentRoot = path.join(
    value.paths?.dataPath ?? '',
    `.ql3-service-start-deployment-${value.sessionId ?? ''}`,
  );
  const expectedToolRoot = path.join(
    expectedDeploymentRoot,
    'physical-service-start',
  );
  const expectedServiceName = `qinglong3-physical-${String(
    value.sessionId ?? '',
  ).slice(0, 8)}`;
  const expectedDescriptorSource = path.join(
    expectedDeploymentRoot,
    'service',
    value.service?.kind === 'systemd'
      ? 'qinglong3.service'
      : 'qinglong3.openrc',
  );
  const expectedDescriptorDestination =
    value.service?.kind === 'systemd'
      ? `/etc/systemd/system/${expectedServiceName}.service`
      : `/etc/init.d/${expectedServiceName}`;
  const expectedDescriptorMode =
    value.service?.kind === 'systemd' ? 0o644 : 0o755;
  const expectedInstall = [
    '-o',
    'root',
    '-g',
    'root',
    '-m',
    expectedDescriptorMode.toString(8),
    expectedDescriptorSource,
    expectedDescriptorDestination,
  ];
  const expectedEnable =
    value.service?.kind === 'systemd'
      ? ['enable', expectedServiceName]
      : ['add', expectedServiceName, 'default'];
  const expectedManagerPattern =
    value.service?.kind === 'systemd'
      ? /^\/(?:usr\/)?bin\/systemctl$/
      : /^\/(?:usr\/)?sbin\/rc-service$/;
  const expectedEnablePattern =
    value.service?.kind === 'systemd'
      ? /^\/(?:usr\/)?bin\/systemctl$/
      : /^\/(?:usr\/)?sbin\/rc-update$/;
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
    value.evidenceClass !== 'physical_edge_service_start_session' ||
    !UUID_V4_PATTERN.test(value.sessionId ?? '') ||
    !SHA256_PATTERN.test(value.manifestDigest ?? '') ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0 ||
    typeof value.preparedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.preparedAt)) ||
    !validArtifact(value.artifact) ||
    !hasExactKeys(value.environment, ENVIRONMENT_KEYS) ||
    value.environment.platform !== 'linux' ||
    !hasExactKeys(value.paths, PATH_KEYS) ||
    !hasExactKeys(value.service, SERVICE_KEYS) ||
    !['systemd', 'openrc'].includes(value.service.kind) ||
    value.service.serviceName !== expectedServiceName ||
    !SAFE_SERVICE_NAME_PATTERN.test(value.service.serviceName ?? '') ||
    !SHA256_PATTERN.test(value.service.descriptorSha256 ?? '') ||
    !SHA256_PATTERN.test(value.service.managerSha256 ?? '') ||
    !SHA256_PATTERN.test(value.service.enableSha256 ?? '') ||
    !SHA256_PATTERN.test(value.service.wrapperSha256 ?? '') ||
    value.service.descriptorMode !== expectedDescriptorMode ||
    JSON.stringify(value.service.installArguments) !==
      JSON.stringify(expectedInstall) ||
    JSON.stringify(value.service.enableArguments) !==
      JSON.stringify(expectedEnable) ||
    !expectedManagerPattern.test(value.service.managerExecutable ?? '') ||
    !expectedEnablePattern.test(value.service.enableExecutable ?? '') ||
    (value.service.kind === 'systemd' &&
      (value.service.enableExecutable !== value.service.managerExecutable ||
        value.service.enableSha256 !== value.service.managerSha256)) ||
    !path.isAbsolute(value.paths.dataPath ?? '') ||
    !path.isAbsolute(value.paths.artifactRoot ?? '') ||
    value.paths.deploymentRoot !== expectedDeploymentRoot ||
    value.paths.toolRoot !== expectedToolRoot ||
    value.paths.applicationEntrypoint !== expectedEntrypoint ||
    value.paths.applicationConfig !==
      path.join(expectedDeploymentRoot, 'local-application.json') ||
    value.paths.wrapper !== path.join(expectedToolRoot, 'boot-probe.sh') ||
    value.paths.wrapperStartRecord !==
      path.join(expectedToolRoot, 'wrapper-start.record') ||
    value.paths.nodeRecord !== path.join(expectedToolRoot, 'node.record') ||
    value.paths.activeRecord !== path.join(expectedToolRoot, 'active.record') ||
    value.paths.eventLog !== path.join(expectedToolRoot, 'events.jsonl') ||
    value.paths.stderrLog !== path.join(expectedToolRoot, 'stderr.log') ||
    value.paths.fifo !== path.join(expectedToolRoot, 'events.fifo') ||
    value.service.descriptorSource !== expectedDescriptorSource ||
    value.service.descriptorDestination !== expectedDescriptorDestination ||
    value.sha256 !== canonicalDigest(body)
  ) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'session is invalid or drifted',
    );
  }
  for (const name of [
    'deploymentRoot',
    'toolRoot',
    'wrapper',
    'wrapperStartRecord',
    'nodeRecord',
    'activeRecord',
    'eventLog',
    'stderrLog',
    'fifo',
  ]) {
    assertChildPath(value.paths.dataPath, value.paths[name], `paths.${name}`);
  }
  return Object.freeze(value);
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
  throw new QingLong3PhysicalServiceStartEvidenceError(
    `${label} executable is unavailable`,
  );
}

function managerExecutable(kind) {
  return kind === 'systemd'
    ? findExecutable(['/usr/bin/systemctl', '/bin/systemctl'], 'systemd')
    : findExecutable(['/sbin/rc-service', '/usr/sbin/rc-service'], 'OpenRC');
}

function serviceEnableExecutable(kind, manager) {
  return kind === 'systemd'
    ? manager
    : findExecutable(
        ['/sbin/rc-update', '/usr/sbin/rc-update'],
        'OpenRC update',
      );
}

function createFifo(filePath) {
  const executable = findExecutable(
    ['/usr/bin/mkfifo', '/bin/mkfifo'],
    'mkfifo',
  );
  const result = spawnSync(executable, ['-m', '600', filePath], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status !== 0 || result.signal !== null) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'private event FIFO could not be created',
    );
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFIFO() || (stat.mode & 0o777) !== 0o600) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'private event FIFO is invalid',
    );
  }
}

function requireDeploymentProduct() {
  try {
    return require(path.join(
      __dirname,
      '..',
      'packages/ql3-local-owner-cli/dist/deployment/localDeployment.js',
    ));
  } catch (error) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      `QingLong 3.0 local deployment package must be built first: ${error.message}`,
    );
  }
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
    typeof environment.bootId !== 'string' ||
    environment.bootId.length < 8 ||
    !Array.isArray(environment.virtualizationIndicators) ||
    environment.virtualizationIndicators.length > 0
  ) {
    violations.push('device, Node or boot environment did not match manifest');
  }
  return Object.freeze(violations);
}

function installContract(kind, serviceName, descriptorSource) {
  const descriptorDestination =
    kind === 'systemd'
      ? `/etc/systemd/system/${serviceName}.service`
      : `/etc/init.d/${serviceName}`;
  const descriptorMode = kind === 'systemd' ? 0o644 : 0o755;
  return Object.freeze({
    descriptorDestination,
    descriptorMode,
    installArguments: Object.freeze([
      '-o',
      'root',
      '-g',
      'root',
      '-m',
      descriptorMode.toString(8),
      descriptorSource,
      descriptorDestination,
    ]),
    enableArguments: Object.freeze(
      kind === 'systemd'
        ? ['enable', serviceName]
        : ['add', serviceName, 'default'],
    ),
  });
}

async function preparePhase(options, manifest) {
  if (process.platform !== 'linux') {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'prepare requires Linux',
    );
  }
  const dataPath = fs.realpathSync(options.dataPath);
  assertPrivateDirectory(dataPath, 'dataPath');
  assertChildPath(dataPath, options.sessionPath, 'sessionPath');
  if (fs.existsSync(options.sessionPath)) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
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
    throw new QingLong3PhysicalServiceStartEvidenceError(
      artifactViolations.join('; '),
    );
  }
  const environment = currentBoot(dataPath, node);
  const environmentViolations = validateEnvironment(manifest, environment);
  if (environmentViolations.length > 0) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      environmentViolations.join('; '),
    );
  }
  const uid = process.geteuid?.();
  if (!Number.isSafeInteger(uid)) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'a stable POSIX UID is required',
    );
  }
  const sessionId = crypto.randomUUID();
  const suffix = sessionId.slice(0, 8);
  const serviceName = `qinglong3-physical-${suffix}`;
  const deploymentRoot = path.join(
    dataPath,
    `.ql3-service-start-deployment-${sessionId}`,
  );
  const toolRoot = path.join(deploymentRoot, 'physical-service-start');
  fs.mkdirSync(deploymentRoot, { mode: 0o700 });
  fs.mkdirSync(toolRoot, { mode: 0o700 });
  assertPrivateDirectory(deploymentRoot, 'deploymentRoot');
  assertPrivateDirectory(toolRoot, 'toolRoot');
  const paths = Object.freeze({
    dataPath,
    toolRoot,
    deploymentRoot,
    artifactRoot: artifactIdentity.artifactRoot,
    applicationEntrypoint: artifactIdentity.applicationEntrypoint,
    applicationConfig: path.join(deploymentRoot, 'local-application.json'),
    wrapper: path.join(toolRoot, 'boot-probe.sh'),
    wrapperStartRecord: path.join(toolRoot, 'wrapper-start.record'),
    nodeRecord: path.join(toolRoot, 'node.record'),
    activeRecord: path.join(toolRoot, 'active.record'),
    eventLog: path.join(toolRoot, 'events.jsonl'),
    stderrLog: path.join(toolRoot, 'stderr.log'),
    fifo: path.join(toolRoot, 'events.fifo'),
  });
  const wrapper = renderEvidenceWrapper({
    applicationEntrypoint: paths.applicationEntrypoint,
    nodeExecutable: node.nodeExecutable,
    paths,
  });
  writeNoReplace(paths.wrapper, wrapper, 0o700);
  createFifo(paths.fifo);
  const timestamp = Date.now();
  const product = requireDeploymentProduct();
  const prepared = await product.prepareLocalDeployment({
    schemaVersion: 1,
    operation: 'local.deployment.prepare',
    options: {
      deploymentRoot,
      profile: 'edge',
      instanceId: `physical-service-${suffix}`,
      busyTimeoutMs: 100,
      service: {
        kind: manifest.serviceManager,
        nodeExecutable: paths.wrapper,
        applicationEntrypoint: node.nodeExecutable,
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
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'fresh Edge service deployment was not prepared',
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
  const enable = serviceEnableExecutable(manifest.serviceManager, manager);
  const install = installContract(
    manifest.serviceManager,
    serviceName,
    descriptorSource,
  );
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_service_start_session',
    sessionId,
    manifestDigest: canonicalDigest(manifest),
    uid,
    preparedAt: new Date().toISOString(),
    artifact: artifactIdentity.artifact,
    environment,
    paths,
    service: {
      kind: manifest.serviceManager,
      serviceName,
      managerExecutable: manager,
      managerSha256: fileSha256(manager),
      enableExecutable: enable,
      enableSha256: fileSha256(enable),
      descriptorSource,
      descriptorDestination: install.descriptorDestination,
      descriptorMode: install.descriptorMode,
      descriptorSha256: fileSha256(descriptorSource),
      wrapperSha256: fileSha256(paths.wrapper),
      installArguments: install.installArguments,
      enableArguments: install.enableArguments,
    },
  };
  const session = Object.freeze({ ...body, sha256: canonicalDigest(body) });
  writeNoReplace(options.sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'awaiting_operator_install_enable_and_reboot',
      sessionId,
      service: {
        kind: session.service.kind,
        serviceName,
        descriptorSource,
        descriptorDestination: session.service.descriptorDestination,
        descriptorSha256: session.service.descriptorSha256,
        install: {
          arguments: session.service.installArguments,
        },
        enable: {
          executable: session.service.enableExecutable,
          arguments: session.service.enableArguments,
        },
      },
      automaticServiceManagerMutationPerformed: false,
      supported: false,
    })}\n`,
  );
}

function readCmdline(processId) {
  return fs
    .readFileSync(`/proc/${processId}/cmdline`)
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function processIdentity(session, observations) {
  const wrapperStat = parseProcStat(
    fs.readFileSync(`/proc/${observations.wrapperPid}/stat`, 'utf8'),
  );
  const wrapperStatus = parseProcStatus(
    fs.readFileSync(`/proc/${observations.wrapperPid}/status`, 'utf8'),
  );
  const nodeStat = parseProcStat(
    fs.readFileSync(`/proc/${observations.nodePid}/stat`, 'utf8'),
  );
  const nodeStatusSource = fs.readFileSync(
    `/proc/${observations.nodePid}/status`,
    'utf8',
  );
  const nodeStatus = parseProcStatus(nodeStatusSource);
  const parentMatch = /^PPid:\s+([0-9]+)$/m.exec(nodeStatusSource);
  const nodeExecutable = fs.realpathSync(`/proc/${observations.nodePid}/exe`);
  const wrapperArguments = readCmdline(observations.wrapperPid);
  const nodeArguments = readCmdline(observations.nodePid);
  const expectedNodeArguments = [
    session.environment.nodeExecutable,
    session.paths.applicationEntrypoint,
    '--config',
    session.paths.applicationConfig,
  ];
  const wrapperMatched =
    wrapperStatus.uid === session.uid &&
    wrapperStat.processId === observations.wrapperPid &&
    wrapperArguments.includes(session.paths.wrapper) &&
    wrapperArguments.includes(session.environment.nodeExecutable);
  const nodeMatched =
    nodeStatus.uid === session.uid &&
    nodeStat.processId === observations.nodePid &&
    Number(parentMatch?.[1]) === observations.wrapperPid &&
    nodeExecutable === session.environment.nodeExecutable &&
    JSON.stringify(nodeArguments) === JSON.stringify(expectedNodeArguments);
  return Object.freeze({
    wrapperMatched,
    nodeMatched,
    wrapperPid: observations.wrapperPid,
    wrapperStartTicks: wrapperStat.startTicks,
    nodePid: observations.nodePid,
    nodeStartTicks: nodeStat.startTicks,
  });
}

function runBounded(executable, arguments_, label) {
  const result = spawnSync(executable, arguments_, {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
  });
  if (result.error || result.signal !== null) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      `${label} probe failed`,
    );
  }
  return result;
}

function inspectServiceManager(session, wrapperPid) {
  if (session.service.kind === 'systemd') {
    const result = runBounded(
      session.service.managerExecutable,
      [
        '--no-pager',
        'show',
        `${session.service.serviceName}.service`,
        '--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,MainPID',
      ],
      'systemd',
    );
    if (result.status !== 0) {
      throw new QingLong3PhysicalServiceStartEvidenceError(
        'systemd service is unavailable',
      );
    }
    const state = parseSystemdShow(result.stdout);
    return Object.freeze({
      active: state.active,
      enabled: state.enabled,
      mainPid: state.mainPid,
      fragmentPath: state.fragmentPath,
      mainPidMatched: state.mainPid === wrapperPid,
    });
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
  const state = parseOpenRcState(
    status.status,
    enabled.stdout,
    session.service.serviceName,
  );
  return Object.freeze({
    ...state,
    fragmentPath: session.service.descriptorDestination,
    mainPidMatched: true,
  });
}

function evaluateServiceStartEvidence({
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
    !hasExactKeys(observed.process, PROCESS_KEYS) ||
    !hasExactKeys(observed.service, OBSERVED_SERVICE_KEYS)
  ) {
    return Object.freeze(['service start observation shape is invalid']);
  }
  if (
    observed.after.bootId === session.environment.bootId ||
    observed.after.bootId !== observed.process.bootId
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
    !hasExactKeys(measurements, MEASUREMENT_KEYS) ||
    MEASUREMENT_KEYS.some(
      (key) =>
        !Number.isSafeInteger(measurements[key]) || measurements[key] < 0,
    ) ||
    measurements.bootToActiveMs !== measurements.activeBootAgeMs ||
    measurements.serviceStartBootAgeMs >
      manifest.maximumServiceStartBootAgeMs ||
    measurements.serviceStartToActiveMs >
      manifest.maximumServiceStartToActiveMs ||
    measurements.bootToActiveMs > manifest.maximumBootToActiveMs ||
    measurements.activeEventOrdinal < 1
  ) {
    violations.push('service start measurement budget is invalid');
  }
  if (
    !hasExactKeys(outcomes, OUTCOME_KEYS) ||
    outcomes.activeEventCount !== 1 ||
    outcomes.aiStatus !== 'deployment_excluded' ||
    outcomes.descriptorInstalled !== true ||
    outcomes.nodeProcessIdentityMatched !== true ||
    outcomes.serviceActive !== true ||
    outcomes.serviceEnabled !== true ||
    outcomes.stderrBytes !== 0 ||
    outcomes.wrapperProcessIdentityMatched !== true
  ) {
    violations.push('service manager or application outcome is invalid');
  }
  return Object.freeze(violations);
}

function buildServiceStartReport({
  manifest,
  session,
  observed,
  measurements,
  outcomes,
  generatedAt,
}) {
  const violations = evaluateServiceStartEvidence({
    manifest,
    session,
    observed,
    measurements,
    outcomes,
  });
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_service_start_candidate',
    supported: false,
    generatedAt,
    manifest,
    session: {
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

function validateServiceStartReport(report, manifest, currentObserved) {
  const violations = [];
  if (!hasExactKeys(report, REPORT_KEYS)) {
    return Object.freeze(['service start report shape is invalid']);
  }
  const { sha256, ...body } = report;
  if (!SHA256_PATTERN.test(sha256 ?? '') || sha256 !== canonicalDigest(body)) {
    violations.push('service start report digest is invalid');
  }
  if (
    report.schemaVersion !== 1 ||
    report.evidenceClass !== 'physical_edge_service_start_candidate' ||
    report.supported !== false ||
    !Number.isFinite(Date.parse(report.generatedAt ?? '')) ||
    canonicalDigest(report.manifest) !== canonicalDigest(manifest) ||
    !hasExactKeys(report.session, REPORT_SESSION_KEYS) ||
    !UUID_V4_PATTERN.test(report.session?.sessionId ?? '') ||
    !SHA256_PATTERN.test(report.session?.sessionDigest ?? '') ||
    !Number.isFinite(Date.parse(report.session?.preparedAt ?? '')) ||
    typeof report.session?.prepareBootId !== 'string' ||
    report.session.prepareBootId.length < 8 ||
    !hasExactKeys(report.qualification, QUALIFICATION_KEYS) ||
    report.observed?.after?.bootId !== currentObserved.bootId ||
    report.observed?.after?.architecture !== currentObserved.architecture ||
    report.observed?.after?.dataFilesystem !== currentObserved.dataFilesystem
  ) {
    violations.push('service start report qualification or device drifted');
  }
  const syntheticSession = {
    environment: { bootId: report.session?.prepareBootId },
    artifact: report.observed?.artifact,
    service: {
      kind: report.observed?.service?.kind,
      serviceName: report.observed?.service?.serviceName,
      managerExecutable: report.observed?.service?.managerExecutable,
      managerSha256: report.observed?.service?.managerSha256,
      descriptorSha256: report.observed?.service?.descriptorSha256,
    },
  };
  const recomputed = evaluateServiceStartEvidence({
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
    violations.push('service start report qualification was widened');
  }
  return Object.freeze(violations);
}

async function resumePhase(options, manifest) {
  if (process.platform !== 'linux') {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'resume requires Linux',
    );
  }
  const session = normalizeSession(
    readPrivateJson(options.sessionPath, 'session'),
  );
  if (session.manifestDigest !== canonicalDigest(manifest)) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'manifest did not match session',
    );
  }
  if (process.geteuid?.() !== session.uid) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'resume UID did not match prepare',
    );
  }
  const dataPath = fs.realpathSync(session.paths.dataPath);
  assertPrivateDirectory(dataPath, 'dataPath');
  assertChildPath(dataPath, options.outputPath, 'outputPath');
  if (fs.existsSync(options.outputPath)) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
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
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'artifact metadata drifted before report collection',
    );
  }
  const node = collectNodeIdentity();
  const after = currentBoot(dataPath, node);
  if (
    after.bootId === session.environment.bootId ||
    validateEnvironment(manifest, after).length > 0
  ) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'reboot or current environment preflight failed',
    );
  }
  const installedStat = fs.lstatSync(session.service.descriptorDestination);
  if (
    !installedStat.isFile() ||
    installedStat.isSymbolicLink() ||
    installedStat.uid !== 0 ||
    (installedStat.mode & 0o777) !== session.service.descriptorMode ||
    installedStat.nlink !== 1 ||
    fileSha256(session.service.descriptorDestination) !==
      session.service.descriptorSha256 ||
    fileSha256(session.paths.wrapper) !== session.service.wrapperSha256 ||
    fileSha256(session.service.managerExecutable) !==
      session.service.managerSha256 ||
    fileSha256(session.service.enableExecutable) !==
      session.service.enableSha256
  ) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'installed descriptor, wrapper or service manager drifted',
    );
  }
  const wrapper = parseWrapperObservations({
    startContents: readPrivateFile(
      session.paths.wrapperStartRecord,
      'wrapper start record',
    ),
    nodeContents: readPrivateFile(session.paths.nodeRecord, 'node record'),
    activeContents: readPrivateFile(
      session.paths.activeRecord,
      'active record',
    ),
    eventContents: readPrivateFile(
      session.paths.eventLog,
      'event log',
      MAX_EVENT_BYTES,
    ),
  });
  if (wrapper.bootId !== after.bootId) {
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'wrapper record did not belong to current boot',
    );
  }
  const process = processIdentity(session, wrapper);
  const serviceState = inspectServiceManager(session, wrapper.wrapperPid);
  const artifactIdentity = collectArtifactIdentity(session.paths.artifactRoot);
  const stderrBytes = Buffer.byteLength(
    readPrivateFile(session.paths.stderrLog, 'stderr log', MAX_EVENT_BYTES),
    'utf8',
  );
  const report = buildServiceStartReport({
    manifest,
    session,
    observed: {
      after,
      artifact: artifactIdentity.artifact,
      process: {
        bootId: wrapper.bootId,
        wrapperPid: process.wrapperPid,
        wrapperStartTicks: process.wrapperStartTicks,
        nodePid: process.nodePid,
        nodeStartTicks: process.nodeStartTicks,
      },
      service: {
        kind: session.service.kind,
        serviceName: session.service.serviceName,
        managerExecutable: session.service.managerExecutable,
        managerSha256: session.service.managerSha256,
        descriptorSha256: session.service.descriptorSha256,
        mainPid: serviceState.mainPid,
      },
    },
    measurements: {
      serviceStartBootAgeMs: wrapper.serviceStartBootAgeMs,
      activeBootAgeMs: wrapper.activeBootAgeMs,
      bootToActiveMs: wrapper.activeBootAgeMs,
      serviceStartToActiveMs: wrapper.serviceStartToActiveMs,
      activeEventOrdinal: wrapper.activeEventOrdinal,
    },
    outcomes: {
      activeEventCount: wrapper.activeEventCount,
      aiStatus: wrapper.activeEvent.aiStatus,
      descriptorInstalled:
        serviceState.fragmentPath === session.service.descriptorDestination,
      serviceActive: serviceState.active,
      serviceEnabled: serviceState.enabled,
      wrapperProcessIdentityMatched:
        process.wrapperMatched && serviceState.mainPidMatched,
      nodeProcessIdentityMatched: process.nodeMatched,
      stderrBytes,
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
        evidenceClass: 'physical_edge_service_start_inspection',
        profile: 'edge',
        artifact: artifact.artifact,
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
    throw new QingLong3PhysicalServiceStartEvidenceError(
      'Node.js 24 or newer is required',
    );
  }
  const options = parseArguments(process.argv.slice(2));
  if (options.phase === 'inspect') {
    inspectPhase(options);
    return;
  }
  const manifest = normalizeServiceStartManifest(
    readPrivateJson(options.manifestPath, 'manifest'),
  );
  if (options.phase === 'prepare') {
    await preparePhase(options, manifest);
  } else {
    await resumePhase(options, manifest);
  }
}

module.exports = {
  QingLong3PhysicalServiceStartEvidenceError,
  buildServiceStartReport,
  evaluateServiceStartEvidence,
  installContract,
  normalizeServiceStartManifest,
  normalizeSession,
  parseArguments,
  parseOpenRcState,
  parseSystemdShow,
  parseWrapperObservations,
  renderEvidenceWrapper,
  validateServiceStartReport,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
