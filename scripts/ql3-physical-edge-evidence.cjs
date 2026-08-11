#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 4 * MIB;
const MANIFEST_KEYS = Object.freeze([
  'deviceId',
  'deviceModel',
  'evidenceClass',
  'expectedArchitecture',
  'expectedFilesystem',
  'memoryBytes',
  'profile',
  'schemaVersion',
  'soc',
  'storageMedium',
]);
const MEMORY_KEYS = Object.freeze(['maximum', 'minimum']);
const IDLE_EVIDENCE_KEYS = Object.freeze([
  'evidenceClass',
  'generatedAt',
  'identity',
  'manifest',
  'qualification',
  'schemaVersion',
  'sha256',
  'summary',
  'supported',
]);
const FAULT_EVIDENCE_KEYS = Object.freeze([
  'evidenceClass',
  'generatedAt',
  'manifest',
  'observed',
  'qualification',
  'schemaVersion',
  'sha256',
  'supported',
]);
const TASK_SCALE_EVIDENCE_KEYS = Object.freeze([
  'evidenceClass',
  'generatedAt',
  'manifest',
  'observed',
  'qualification',
  'schemaVersion',
  'sha256',
  'supported',
  'workload',
]);
const TASK_SCALE_WORKLOAD_KEYS = Object.freeze([
  'baselineRssBytes',
  'cases',
  'finalStorage',
  'migration',
  'peakRssBytes',
]);
const TASK_SCALE_MIGRATION_KEYS = Object.freeze([
  'contractVersion',
  'durationMs',
  'migrationCount',
  'storage',
]);
const TASK_SCALE_CASE_KEYS = Object.freeze([
  'appendDurationMs',
  'appended',
  'count',
  'cumulativeDurationMs',
  'peakRssBytes',
  'rssBytes',
  'scan',
  'storage',
]);
const TASK_SCALE_SCAN_KEYS = Object.freeze([
  'count',
  'durationMs',
  'identityDigest',
  'pages',
]);
const TASK_SCALE_STORAGE_KEYS = Object.freeze([
  'allocatedBytes',
  'files',
  'logicalBytes',
]);
const TASK_SCALE_FILE_KEYS = Object.freeze([
  'allocatedBytes',
  'logicalBytes',
  'suffix',
]);
const STORAGE_MEDIA = Object.freeze([
  'nand',
  'emmc',
  'sd',
  'ssd',
  'nvme',
  'usb',
]);
const VIRTUALIZATION_PATTERN =
  /docker|containerd|kubepods|podman|lxc|qemu|kvm|vmware|virtualbox|parallels|hyper-v|bochs|xen/i;

class QingLong3PhysicalEvidenceError extends Error {
  constructor(message) {
    super(`QingLong 3.0 physical Edge evidence failed: ${message}`);
    this.name = 'QingLong3PhysicalEvidenceError';
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QingLong3PhysicalEvidenceError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new QingLong3PhysicalEvidenceError(
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

function isNonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function isTaskScaleStorage(value) {
  if (
    !hasExactKeys(value, TASK_SCALE_STORAGE_KEYS) ||
    !Number.isSafeInteger(value.logicalBytes) ||
    value.logicalBytes < 0 ||
    !Number.isSafeInteger(value.allocatedBytes) ||
    value.allocatedBytes < 0 ||
    !Array.isArray(value.files) ||
    value.files.length > 4
  ) {
    return false;
  }
  const suffixes = new Set();
  for (const file of value.files) {
    if (
      !hasExactKeys(file, TASK_SCALE_FILE_KEYS) ||
      !['database', '-journal', '-wal', '-shm'].includes(file.suffix) ||
      suffixes.has(file.suffix) ||
      !Number.isSafeInteger(file.logicalBytes) ||
      file.logicalBytes < 0 ||
      !Number.isSafeInteger(file.allocatedBytes) ||
      file.allocatedBytes < 0
    ) {
      return false;
    }
    suffixes.add(file.suffix);
  }
  return true;
}

function validateTaskScaleWorkload(workload) {
  const violations = [];
  if (!hasExactKeys(workload, TASK_SCALE_WORKLOAD_KEYS)) {
    return Object.freeze(['task scale workload shape is invalid']);
  }
  const migration = workload.migration;
  if (
    !hasExactKeys(migration, TASK_SCALE_MIGRATION_KEYS) ||
    migration.contractVersion !== 14 ||
    migration.migrationCount !== 28 ||
    !isNonNegativeNumber(migration.durationMs) ||
    !isTaskScaleStorage(migration.storage)
  ) {
    violations.push('task scale migration measurement is invalid');
  }
  if (
    !Number.isSafeInteger(workload.baselineRssBytes) ||
    workload.baselineRssBytes < 1 ||
    !Number.isSafeInteger(workload.peakRssBytes) ||
    workload.peakRssBytes < workload.baselineRssBytes ||
    !isTaskScaleStorage(workload.finalStorage)
  ) {
    violations.push(
      'task scale process or final storage measurement is invalid',
    );
  }
  const expectedCounts = [100, 1000, 10_000];
  const expectedAppended = [100, 900, 9000];
  if (!Array.isArray(workload.cases) || workload.cases.length !== 3) {
    violations.push('task scale cases are incomplete');
    return Object.freeze(violations);
  }
  for (let index = 0; index < expectedCounts.length; index += 1) {
    const entry = workload.cases[index];
    const count = expectedCounts[index];
    if (
      !hasExactKeys(entry, TASK_SCALE_CASE_KEYS) ||
      entry.count !== count ||
      entry.appended !== expectedAppended[index] ||
      !isNonNegativeNumber(entry.appendDurationMs) ||
      !isNonNegativeNumber(entry.cumulativeDurationMs) ||
      !Number.isSafeInteger(entry.rssBytes) ||
      entry.rssBytes < 1 ||
      !Number.isSafeInteger(entry.peakRssBytes) ||
      entry.peakRssBytes < entry.rssBytes ||
      entry.peakRssBytes > workload.peakRssBytes ||
      !isTaskScaleStorage(entry.storage) ||
      !hasExactKeys(entry.scan, TASK_SCALE_SCAN_KEYS) ||
      entry.scan.count !== count ||
      entry.scan.pages !== Math.ceil(count / 256) ||
      !isNonNegativeNumber(entry.scan.durationMs) ||
      !/^[a-f0-9]{64}$/.test(entry.scan.identityDigest ?? '')
    ) {
      violations.push(`task scale case ${count} is invalid`);
    }
  }
  return Object.freeze(violations);
}

function boundedString(value, label, pattern = /^[\x20-\x7e]+$/) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !pattern.test(value)
  ) {
    throw new QingLong3PhysicalEvidenceError(`${label} is invalid`);
  }
  return value;
}

function normalizeManifest(value) {
  exactKeys(value, MANIFEST_KEYS, 'manifest');
  exactKeys(value.memoryBytes, MEMORY_KEYS, 'manifest.memoryBytes');
  if (value.schemaVersion !== 1) {
    throw new QingLong3PhysicalEvidenceError(
      'manifest schemaVersion must be 1',
    );
  }
  if (value.evidenceClass !== 'physical_edge_candidate') {
    throw new QingLong3PhysicalEvidenceError(
      'manifest evidenceClass must be physical_edge_candidate',
    );
  }
  if (value.profile !== 'edge') {
    throw new QingLong3PhysicalEvidenceError('manifest profile must be edge');
  }
  const deviceId = boundedString(
    value.deviceId,
    'manifest.deviceId',
    /^[a-z0-9][a-z0-9._-]{2,63}$/,
  );
  const deviceModel = boundedString(value.deviceModel, 'manifest.deviceModel');
  const soc = boundedString(value.soc, 'manifest.soc');
  if (!STORAGE_MEDIA.includes(value.storageMedium)) {
    throw new QingLong3PhysicalEvidenceError(
      `manifest.storageMedium must be one of ${STORAGE_MEDIA.join(', ')}`,
    );
  }
  if (!['x64', 'arm64', 'arm'].includes(value.expectedArchitecture)) {
    throw new QingLong3PhysicalEvidenceError(
      'manifest.expectedArchitecture must be x64, arm64 or arm',
    );
  }
  const expectedFilesystem = boundedString(
    value.expectedFilesystem,
    'manifest.expectedFilesystem',
    /^[a-z0-9][a-z0-9._-]{1,31}$/,
  );
  const { minimum, maximum } = value.memoryBytes;
  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum < 128 * MIB ||
    maximum < minimum ||
    maximum > 64 * GIB
  ) {
    throw new QingLong3PhysicalEvidenceError(
      'manifest.memoryBytes must be a 128 MiB to 64 GiB ordered integer range',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_candidate',
    profile: 'edge',
    deviceId,
    deviceModel,
    soc,
    storageMedium: value.storageMedium,
    expectedArchitecture: value.expectedArchitecture,
    memoryBytes: Object.freeze({ minimum, maximum }),
    expectedFilesystem,
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
      throw new QingLong3PhysicalEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (name === '--manifest') options.manifestPath = value;
    else if (name === '--data-path') options.dataPath = value;
    else if (name === '--output') options.outputPath = value;
    else if (name === '--idle-evidence') options.idleEvidencePath = value;
    else if (name === '--task-scale-evidence')
      options.taskScaleEvidencePath = value;
    else if (name === '--adoption-scale-evidence')
      options.adoptionScaleEvidencePath = value;
    else if (name === '--compose-storage-evidence')
      options.composeStorageEvidencePath = value;
    else if (name === '--application-start-evidence')
      options.applicationStartEvidencePath = value;
    else if (name === '--service-start-evidence')
      options.serviceStartEvidencePath = value;
    else if (name === '--direct-service-start-evidence')
      options.directServiceStartEvidencePath = value;
    else if (name === '--direct-service-stop-evidence')
      options.directServiceStopEvidencePath = value;
    else if (name === '--fault-evidence') {
      options.faultEvidencePaths ??= [];
      if (
        options.faultEvidencePaths.length >= 2 ||
        options.faultEvidencePaths.includes(value)
      ) {
        throw new QingLong3PhysicalEvidenceError(
          '--fault-evidence accepts at most two unique paths',
        );
      }
      options.faultEvidencePaths.push(value);
    } else {
      throw new QingLong3PhysicalEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
  }
  for (const name of ['manifestPath', 'dataPath']) {
    if (!path.isAbsolute(options[name] ?? '')) {
      throw new QingLong3PhysicalEvidenceError(`${name} must be absolute`);
    }
  }
  if (options.outputPath && !path.isAbsolute(options.outputPath)) {
    throw new QingLong3PhysicalEvidenceError('outputPath must be absolute');
  }
  if (options.idleEvidencePath && !path.isAbsolute(options.idleEvidencePath)) {
    throw new QingLong3PhysicalEvidenceError(
      'idleEvidencePath must be absolute',
    );
  }
  if (
    options.taskScaleEvidencePath &&
    !path.isAbsolute(options.taskScaleEvidencePath)
  ) {
    throw new QingLong3PhysicalEvidenceError(
      'taskScaleEvidencePath must be absolute',
    );
  }
  if (
    options.adoptionScaleEvidencePath &&
    !path.isAbsolute(options.adoptionScaleEvidencePath)
  ) {
    throw new QingLong3PhysicalEvidenceError(
      'adoptionScaleEvidencePath must be absolute',
    );
  }
  if (
    options.composeStorageEvidencePath &&
    !path.isAbsolute(options.composeStorageEvidencePath)
  ) {
    throw new QingLong3PhysicalEvidenceError(
      'composeStorageEvidencePath must be absolute',
    );
  }
  if (
    options.applicationStartEvidencePath &&
    !path.isAbsolute(options.applicationStartEvidencePath)
  ) {
    throw new QingLong3PhysicalEvidenceError(
      'applicationStartEvidencePath must be absolute',
    );
  }
  if (
    options.serviceStartEvidencePath &&
    !path.isAbsolute(options.serviceStartEvidencePath)
  ) {
    throw new QingLong3PhysicalEvidenceError(
      'serviceStartEvidencePath must be absolute',
    );
  }
  if (
    options.directServiceStartEvidencePath &&
    !path.isAbsolute(options.directServiceStartEvidencePath)
  ) {
    throw new QingLong3PhysicalEvidenceError(
      'directServiceStartEvidencePath must be absolute',
    );
  }
  if (
    options.directServiceStopEvidencePath &&
    !path.isAbsolute(options.directServiceStopEvidencePath)
  ) {
    throw new QingLong3PhysicalEvidenceError(
      'directServiceStopEvidencePath must be absolute',
    );
  }
  for (const faultEvidencePath of options.faultEvidencePaths ?? []) {
    if (!path.isAbsolute(faultEvidencePath)) {
      throw new QingLong3PhysicalEvidenceError(
        'faultEvidencePath must be absolute',
      );
    }
  }
  return Object.freeze(options);
}

function assertPrivateEvidenceFile(stat, label) {
  const effectiveUserId = process.geteuid?.();
  if (
    !Number.isSafeInteger(effectiveUserId) ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.uid !== effectiveUserId
  ) {
    throw new QingLong3PhysicalEvidenceError(
      `${label} must be a current-user-owned private regular file without symlinks`,
    );
  }
}

function readBoundedFile(filePath, label, optional = false) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) {
      throw new QingLong3PhysicalEvidenceError(`${label} is not bounded`);
    }
    const contents = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(contents) > MAX_INPUT_BYTES) {
      throw new QingLong3PhysicalEvidenceError(`${label} is not bounded`);
    }
    return contents;
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readManifest(filePath) {
  let parsed;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new QingLong3PhysicalEvidenceError(
        'manifest must be a regular file without symlinks',
      );
    }
    parsed = JSON.parse(readBoundedFile(filePath, 'manifest'));
  } catch (error) {
    if (error instanceof QingLong3PhysicalEvidenceError) throw error;
    throw new QingLong3PhysicalEvidenceError(
      `manifest could not be read: ${error.message}`,
    );
  }
  return normalizeManifest(parsed);
}

function parseMountTable(raw) {
  return raw
    .trim()
    .split('\n')
    .map((line) => line.split(' '))
    .filter((fields) => fields.length >= 4)
    .map((fields) =>
      Object.freeze({
        source: fields[0],
        path: fields[1].replace(/\\040/g, ' '),
        filesystem: fields[2],
        options: Object.freeze(fields[3].split(',')),
      }),
    );
}

function mountForPath(mounts, targetPath) {
  return mounts
    .filter(
      (mount) =>
        targetPath === mount.path ||
        targetPath.startsWith(
          mount.path === '/' ? '/' : `${mount.path.replace(/\/$/, '')}/`,
        ),
    )
    .sort((left, right) => right.path.length - left.path.length)[0];
}

function parseOsRelease(raw) {
  const values = {};
  for (const line of raw?.split('\n') ?? []) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return Object.freeze({
    id: values.ID ?? 'unknown',
    versionId: values.VERSION_ID ?? 'unknown',
  });
}

function collectObservedPlatform(dataPath) {
  if (process.platform !== 'linux') {
    throw new QingLong3PhysicalEvidenceError('recorder requires Linux');
  }
  const dataLstat = fs.lstatSync(dataPath);
  const dataRealPath = fs.realpathSync(dataPath);
  if (
    dataRealPath === '/' ||
    !dataLstat.isDirectory() ||
    dataLstat.isSymbolicLink() ||
    dataRealPath !== dataPath
  ) {
    throw new QingLong3PhysicalEvidenceError(
      'dataPath must be a canonical non-root directory without symlinks',
    );
  }
  for (const faultPath of options.faultEvidencePaths ?? []) {
    if (!path.isAbsolute(faultPath)) {
      throw new QingLong3PhysicalEvidenceError(
        'faultEvidencePath must be absolute',
      );
    }
  }
  const mounts = parseMountTable(
    readBoundedFile('/proc/mounts', 'mount table'),
  );
  const dataMount = mountForPath(mounts, dataRealPath);
  if (!dataMount) {
    throw new QingLong3PhysicalEvidenceError('dataPath mount was not found');
  }
  const dmi = [
    '/sys/class/dmi/id/sys_vendor',
    '/sys/class/dmi/id/product_name',
    '/sys/class/dmi/id/board_name',
  ]
    .map((filePath) => readBoundedFile(filePath, filePath, true)?.trim())
    .filter(Boolean);
  const deviceTreeModel = readBoundedFile(
    '/proc/device-tree/model',
    'device tree model',
    true,
  )
    ?.replace(/\0/g, '')
    .trim();
  const cgroup = readBoundedFile('/proc/1/cgroup', 'PID 1 cgroup', true) ?? '';
  const virtualizationIndicators = [];
  if (fs.existsSync('/.dockerenv'))
    virtualizationIndicators.push('/.dockerenv');
  if (fs.existsSync('/run/.containerenv')) {
    virtualizationIndicators.push('/run/.containerenv');
  }
  if (VIRTUALIZATION_PATTERN.test(cgroup)) {
    virtualizationIndicators.push('PID 1 cgroup');
  }
  if (dmi.some((value) => VIRTUALIZATION_PATTERN.test(value))) {
    virtualizationIndicators.push('DMI');
  }
  if (dataMount.filesystem === 'overlay') {
    virtualizationIndicators.push('overlay data filesystem');
  }
  const statfs = fs.statfsSync(dataRealPath, { bigint: true });
  const glibc = process.report?.getReport()?.header?.glibcVersionRuntime;
  const muslLoader = fs
    .readdirSync('/lib')
    .find((name) => /^ld-musl-.*\.so\.1$/.test(name));
  return Object.freeze({
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    bootId: readBoundedFile(
      '/proc/sys/kernel/random/boot_id',
      'boot identity',
    ).trim(),
    kernel: os.release(),
    distribution: parseOsRelease(
      readBoundedFile('/etc/os-release', 'os-release', true),
    ),
    libc: glibc
      ? `glibc-${glibc}`
      : muslLoader
      ? `musl-${muslLoader}`
      : 'unknown',
    cpuModel: (os.cpus()[0]?.model || 'unknown')
      .replace(/[\u0000-\u001f\u007f]/g, '?')
      .slice(0, 128),
    cpuCount: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
    observedModel: (deviceTreeModel || dmi.join(' / ') || 'unknown').slice(
      0,
      384,
    ),
    dataPath: dataRealPath,
    dataFilesystem: dataMount.filesystem,
    dataMountOptions: dataMount.options,
    dataBytes: Number(statfs.blocks * statfs.bsize),
    dataAvailableBytes: Number(statfs.bavail * statfs.bsize),
    virtualizationIndicators: Object.freeze(virtualizationIndicators),
  });
}

function validateObservedPlatform(manifest, observed) {
  const violations = [];
  if (observed.platform !== 'linux') violations.push('platform must be Linux');
  if (observed.architecture !== manifest.expectedArchitecture) {
    violations.push(
      `architecture ${observed.architecture} did not equal ${manifest.expectedArchitecture}`,
    );
  }
  if (
    observed.totalMemoryBytes < manifest.memoryBytes.minimum ||
    observed.totalMemoryBytes > manifest.memoryBytes.maximum
  ) {
    violations.push('observed memory is outside the declared device range');
  }
  if (observed.dataFilesystem !== manifest.expectedFilesystem) {
    violations.push(
      `filesystem ${observed.dataFilesystem} did not equal ${manifest.expectedFilesystem}`,
    );
  }
  if (observed.dataMountOptions.includes('ro')) {
    violations.push('data filesystem is read-only');
  }
  if (observed.virtualizationIndicators.length > 0) {
    violations.push(
      `virtualization indicators found: ${observed.virtualizationIndicators.join(
        ', ',
      )}`,
    );
  }
  return Object.freeze(violations);
}

function runJsonWorkload(root, name, script, args, environment = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, script), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
      maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new QingLong3PhysicalEvidenceError(
      `${name} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  try {
    return Object.freeze({ name, report: JSON.parse(result.stdout.trim()) });
  } catch (error) {
    throw new QingLong3PhysicalEvidenceError(
      `${name} returned invalid JSON: ${error.message}`,
    );
  }
}

function runEvidenceWorkloads(root, dataPath) {
  const scratchPath = fs.mkdtempSync(path.join(dataPath, '.ql3-evidence-'));
  try {
    fs.chmodSync(scratchPath, 0o700);
    return Object.freeze([
      runJsonWorkload(root, 'edge-executor', 'scripts/ql3-edge-benchmark.cjs', [
        '--json',
        '--max-rss-delta-mb=96',
        '--max-cancel-ms=5000',
      ]),
      runJsonWorkload(
        root,
        'node-sqlite-on-device-storage',
        'scripts/ql3-node-sqlite-benchmark.cjs',
        [
          '--json',
          '--iterations=250',
          '--batch-size=10',
          '--max-transaction-p95-ms=250',
          '--max-batch-stall-ms=2500',
          '--max-rss-delta-mb=64',
        ],
        { TMPDIR: scratchPath },
      ),
    ]);
  } finally {
    fs.rmSync(scratchPath, { recursive: true, force: false });
  }
}

function canonicalDigest(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function validateIdleEvidenceReport(report, manifest, observed) {
  exactKeys(report, IDLE_EVIDENCE_KEYS, 'idle evidence');
  const { sha256, ...body } = report;
  const violations = [];
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) {
    violations.push('idle evidence SHA-256 is invalid');
  } else if (canonicalDigest(body) !== sha256) {
    violations.push('idle evidence SHA-256 did not match');
  }
  if (
    report.schemaVersion !== 1 ||
    report.evidenceClass !== 'physical_edge_idle_candidate' ||
    report.supported !== false
  ) {
    violations.push('idle evidence identity is invalid');
  }
  if (
    report.manifest?.deviceId !== manifest.deviceId ||
    report.manifest?.profile !== 'edge'
  ) {
    violations.push('idle evidence device identity did not match');
  }
  if (
    report.identity?.bootId !== observed.bootId ||
    report.identity?.architecture !== observed.architecture ||
    report.identity?.platform !== 'linux'
  ) {
    violations.push('idle evidence runtime identity did not match');
  }
  if (
    report.qualification?.passed !== true ||
    !Array.isArray(report.qualification?.violations) ||
    report.qualification.violations.length !== 0
  ) {
    violations.push('idle evidence did not pass its sampler gate');
  }
  const expectedMeasures = [
    'process_rss',
    'process_cpu_ticks',
    'process_context_switches',
    'process_io',
  ];
  const expectedExclusions = [
    'whole_device_cpu_wakeups',
    'whole_device_flash_write_amplification',
    'cold_start_or_first_ready',
  ];
  if (
    JSON.stringify(report.qualification?.measures) !==
      JSON.stringify(expectedMeasures) ||
    JSON.stringify(report.qualification?.doesNotProve) !==
      JSON.stringify(expectedExclusions)
  ) {
    violations.push('idle evidence scope was widened');
  }
  if (
    !Number.isSafeInteger(report.summary?.sampleCount) ||
    report.summary.sampleCount < 2 ||
    !Number.isFinite(report.summary?.actualDurationMs) ||
    report.summary.actualDurationMs <= 0
  ) {
    violations.push('idle evidence summary is invalid');
  }
  return Object.freeze(violations);
}

function readIdleEvidence(filePath, manifest, observed) {
  let report;
  try {
    const stat = fs.lstatSync(filePath);
    assertPrivateEvidenceFile(stat, 'idle evidence');
    report = JSON.parse(readBoundedFile(filePath, 'idle evidence'));
  } catch (error) {
    if (error instanceof QingLong3PhysicalEvidenceError) throw error;
    throw new QingLong3PhysicalEvidenceError(
      `idle evidence could not be read: ${error.message}`,
    );
  }
  const violations = validateIdleEvidenceReport(report, manifest, observed);
  if (violations.length > 0) {
    throw new QingLong3PhysicalEvidenceError(
      `idle evidence rejected: ${violations.join('; ')}`,
    );
  }
  return Object.freeze(report);
}

function validateFaultEvidenceReport(report, manifest, observed) {
  exactKeys(report, FAULT_EVIDENCE_KEYS, 'fault evidence');
  const { sha256, ...body } = report;
  const violations = [];
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) {
    violations.push('fault evidence SHA-256 is invalid');
  } else if (canonicalDigest(body) !== sha256) {
    violations.push('fault evidence SHA-256 did not match');
  }
  if (
    report.schemaVersion !== 1 ||
    report.evidenceClass !== 'physical_edge_fault_candidate' ||
    report.supported !== false
  ) {
    violations.push('fault evidence identity is invalid');
  }
  const fault = report.manifest?.fault;
  if (!['enospc_filesystem', 'read_only_filesystem'].includes(fault)) {
    violations.push('fault evidence kind is invalid');
  }
  if (
    report.manifest?.deviceId !== manifest.deviceId ||
    report.manifest?.profile !== 'edge' ||
    report.manifest?.expectedFilesystem !== manifest.expectedFilesystem
  ) {
    violations.push('fault evidence device or filesystem did not match');
  }
  if (
    report.observed?.bootId !== observed.bootId ||
    report.observed?.architecture !== observed.architecture ||
    report.observed?.platform !== 'linux' ||
    report.observed?.filesystem !== manifest.expectedFilesystem
  ) {
    violations.push('fault evidence runtime identity did not match');
  }
  if (
    report.observed?.probePath !== report.manifest?.probePath ||
    report.observed?.mountPath !== report.manifest?.probePath ||
    !Number.isSafeInteger(report.observed?.totalBytes) ||
    report.observed.totalBytes > report.manifest?.maximumFilesystemBytes ||
    report.observed?.probeEntryRemained !== false
  ) {
    violations.push('fault evidence mount boundary is invalid');
  }
  if (fault === 'enospc_filesystem') {
    if (
      !report.observed?.mountOptions?.includes('rw') ||
      report.observed?.availableBytes !== 0 ||
      report.observed?.processUid === 0 ||
      report.observed?.expectedErrorCode !== 'ENOSPC'
    ) {
      violations.push('ENOSPC evidence did not prove the exact fault');
    }
  } else if (
    !report.observed?.mountOptions?.includes('ro') ||
    report.observed?.expectedErrorCode !== 'EROFS'
  ) {
    violations.push('read-only evidence did not prove the exact fault');
  }
  const expectedExclusions = [
    'main_data_filesystem_fault',
    'application_level_recovery',
    'power_loss_survival',
  ];
  if (
    report.qualification?.passed !== true ||
    report.qualification?.scope !== fault ||
    !Array.isArray(report.qualification?.violations) ||
    report.qualification.violations.length !== 0 ||
    JSON.stringify(report.qualification?.doesNotProve) !==
      JSON.stringify(expectedExclusions)
  ) {
    violations.push('fault evidence did not pass its exact probe scope');
  }
  return Object.freeze(violations);
}

function readFaultEvidence(filePath, manifest, observed) {
  let report;
  try {
    const stat = fs.lstatSync(filePath);
    assertPrivateEvidenceFile(stat, 'fault evidence');
    report = JSON.parse(readBoundedFile(filePath, 'fault evidence'));
  } catch (error) {
    if (error instanceof QingLong3PhysicalEvidenceError) throw error;
    throw new QingLong3PhysicalEvidenceError(
      `fault evidence could not be read: ${error.message}`,
    );
  }
  const violations = validateFaultEvidenceReport(report, manifest, observed);
  if (violations.length > 0) {
    throw new QingLong3PhysicalEvidenceError(
      `fault evidence rejected: ${violations.join('; ')}`,
    );
  }
  return Object.freeze(report);
}

function validateTaskScaleEvidenceReport(report, manifest, observed) {
  exactKeys(report, TASK_SCALE_EVIDENCE_KEYS, 'task scale evidence');
  const { sha256, ...body } = report;
  const violations = [];
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) {
    violations.push('task scale evidence SHA-256 is invalid');
  } else if (canonicalDigest(body) !== sha256) {
    violations.push('task scale evidence SHA-256 did not match');
  }
  if (
    report.schemaVersion !== 1 ||
    report.evidenceClass !== 'physical_edge_task_scale_candidate' ||
    report.supported !== false ||
    typeof report.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(report.generatedAt))
  ) {
    violations.push('task scale evidence identity is invalid');
  }
  if (
    !hasExactKeys(report.manifest, [
      'deviceId',
      'evidenceClass',
      'expectedArchitecture',
      'expectedFilesystem',
      'profile',
      'sampleCounts',
      'schemaVersion',
    ]) ||
    report.manifest?.schemaVersion !== 1 ||
    report.manifest?.evidenceClass !== 'physical_edge_task_scale_candidate' ||
    report.manifest?.deviceId !== manifest.deviceId ||
    report.manifest?.profile !== 'edge' ||
    report.manifest?.expectedArchitecture !== manifest.expectedArchitecture ||
    report.manifest?.expectedFilesystem !== manifest.expectedFilesystem ||
    JSON.stringify(report.manifest?.sampleCounts) !==
      JSON.stringify([100, 1000, 10_000])
  ) {
    violations.push('task scale evidence manifest did not match');
  }
  if (
    !hasExactKeys(report.observed, [
      'architecture',
      'bootId',
      'dataPath',
      'filesystem',
      'mountOptions',
      'node',
      'platform',
    ]) ||
    report.observed?.platform !== 'linux' ||
    report.observed?.architecture !== observed.architecture ||
    report.observed?.bootId !== observed.bootId ||
    report.observed?.dataPath !== observed.dataPath ||
    report.observed?.filesystem !== observed.dataFilesystem ||
    JSON.stringify(report.observed?.mountOptions) !==
      JSON.stringify(observed.dataMountOptions)
  ) {
    violations.push('task scale evidence runtime identity did not match');
  }
  const expectedMeasures = [
    'formal_task_definition_repository_append',
    'built_in_command_v1_semantic_validation',
    'bounded_current_definition_scan',
    'process_rss',
    'database_logical_and_allocated_bytes',
    'fresh_schema_migration',
  ];
  const expectedExclusions = [
    'legacy_crontab_adoption',
    'production_scheduler_throughput',
    'whole_device_flash_write_amplification',
    'non_command_task_spec_semantics',
    'task_definition_execution_compilation',
  ];
  if (
    !hasExactKeys(report.qualification, [
      'doesNotProve',
      'measures',
      'passed',
      'violations',
    ]) ||
    report.qualification?.passed !== true ||
    !Array.isArray(report.qualification?.violations) ||
    report.qualification.violations.length !== 0 ||
    JSON.stringify(report.qualification?.measures) !==
      JSON.stringify(expectedMeasures) ||
    JSON.stringify(report.qualification?.doesNotProve) !==
      JSON.stringify(expectedExclusions)
  ) {
    violations.push('task scale evidence scope was widened');
  }
  violations.push(...validateTaskScaleWorkload(report.workload));
  return Object.freeze(violations);
}

function readTaskScaleEvidence(filePath, manifest, observed) {
  let report;
  try {
    const stat = fs.lstatSync(filePath);
    assertPrivateEvidenceFile(stat, 'task scale evidence');
    report = JSON.parse(readBoundedFile(filePath, 'task scale evidence'));
  } catch (error) {
    if (error instanceof QingLong3PhysicalEvidenceError) throw error;
    throw new QingLong3PhysicalEvidenceError(
      `task scale evidence could not be read: ${error.message}`,
    );
  }
  const violations = validateTaskScaleEvidenceReport(
    report,
    manifest,
    observed,
  );
  if (violations.length > 0) {
    throw new QingLong3PhysicalEvidenceError(
      `task scale evidence rejected: ${violations.join('; ')}`,
    );
  }
  return Object.freeze(report);
}

function validateAdoptionScaleEvidenceReport(report, manifest, observed) {
  const adoptionEvidence = require('./ql3-physical-edge-adoption-scale.cjs');
  let adoptionManifest;
  try {
    adoptionManifest = adoptionEvidence.normalizeManifest({
      schemaVersion: 1,
      evidenceClass: 'physical_edge_adoption_scale_candidate',
      profile: 'edge',
      deviceId: manifest.deviceId,
      expectedArchitecture: manifest.expectedArchitecture,
      expectedFilesystem: manifest.expectedFilesystem,
      rowCount: adoptionEvidence.ROW_COUNT,
      maxReviewFileBytes: adoptionEvidence.MAX_REVIEW_BYTES,
    });
  } catch (error) {
    return Object.freeze([
      `adoption evidence manifest is invalid: ${error.message}`,
    ]);
  }
  return adoptionEvidence.validateReport(report, adoptionManifest, observed);
}

function readAdoptionScaleEvidence(filePath, manifest, observed) {
  let report;
  try {
    const stat = fs.lstatSync(filePath);
    assertPrivateEvidenceFile(stat, 'adoption scale evidence');
    report = JSON.parse(readBoundedFile(filePath, 'adoption scale evidence'));
  } catch (error) {
    if (error instanceof QingLong3PhysicalEvidenceError) throw error;
    throw new QingLong3PhysicalEvidenceError(
      `adoption scale evidence could not be read: ${error.message}`,
    );
  }
  const violations = validateAdoptionScaleEvidenceReport(
    report,
    manifest,
    observed,
  );
  if (violations.length > 0) {
    throw new QingLong3PhysicalEvidenceError(
      `adoption scale evidence rejected: ${violations.join('; ')}`,
    );
  }
  return Object.freeze(report);
}

function validateComposeStorageEvidenceReport(report, manifest, observed) {
  const composeStorage = require('./ql3-physical-edge-compose-storage.cjs');
  let composeManifest;
  try {
    composeManifest = composeStorage.normalizeComposeStorageManifest(
      report?.manifest,
    );
  } catch (error) {
    return Object.freeze([
      `Compose storage evidence manifest is invalid: ${error.message}`,
    ]);
  }
  const violations = [
    ...composeStorage.validateComposeStorageReport(
      report,
      composeManifest,
      observed,
    ),
  ];
  if (
    composeManifest.deviceId !== manifest.deviceId ||
    composeManifest.profile !== 'edge' ||
    composeManifest.expectedArchitecture !== manifest.expectedArchitecture ||
    composeManifest.expectedFilesystem !== manifest.expectedFilesystem
  ) {
    violations.push('Compose storage evidence device binding did not match');
  }
  return Object.freeze(violations);
}

function readComposeStorageEvidence(filePath, manifest, observed) {
  let report;
  try {
    const stat = fs.lstatSync(filePath);
    assertPrivateEvidenceFile(stat, 'Compose storage evidence');
    report = JSON.parse(readBoundedFile(filePath, 'Compose storage evidence'));
  } catch (error) {
    if (error instanceof QingLong3PhysicalEvidenceError) throw error;
    throw new QingLong3PhysicalEvidenceError(
      `Compose storage evidence could not be read: ${error.message}`,
    );
  }
  const violations = validateComposeStorageEvidenceReport(
    report,
    manifest,
    observed,
  );
  if (violations.length > 0) {
    throw new QingLong3PhysicalEvidenceError(
      `Compose storage evidence rejected: ${violations.join('; ')}`,
    );
  }
  return Object.freeze(report);
}

function validateApplicationStartEvidenceReport(report, manifest, observed) {
  const applicationStart = require('./ql3-physical-edge-application-start.cjs');
  let applicationManifest;
  try {
    applicationManifest = applicationStart.normalizeApplicationStartManifest(
      report?.manifest,
    );
  } catch (error) {
    return Object.freeze([
      `application start evidence manifest is invalid: ${error.message}`,
    ]);
  }
  const violations = [
    ...applicationStart.validateApplicationStartReport(
      report,
      applicationManifest,
      observed,
    ),
  ];
  if (
    applicationManifest.deviceId !== manifest.deviceId ||
    applicationManifest.profile !== 'edge' ||
    applicationManifest.expectedArchitecture !==
      manifest.expectedArchitecture ||
    applicationManifest.expectedFilesystem !== manifest.expectedFilesystem
  ) {
    violations.push('application start evidence device binding did not match');
  }
  return Object.freeze(violations);
}

function readApplicationStartEvidence(filePath, manifest, observed) {
  let report;
  try {
    const stat = fs.lstatSync(filePath);
    assertPrivateEvidenceFile(stat, 'application start evidence');
    report = JSON.parse(
      readBoundedFile(filePath, 'application start evidence'),
    );
  } catch (error) {
    if (error instanceof QingLong3PhysicalEvidenceError) throw error;
    throw new QingLong3PhysicalEvidenceError(
      `application start evidence could not be read: ${error.message}`,
    );
  }
  const violations = validateApplicationStartEvidenceReport(
    report,
    manifest,
    observed,
  );
  if (violations.length > 0) {
    throw new QingLong3PhysicalEvidenceError(
      `application start evidence rejected: ${violations.join('; ')}`,
    );
  }
  return Object.freeze(report);
}

function validateServiceStartEvidenceReport(report, manifest, observed) {
  const serviceStart = require('./ql3-physical-edge-service-start.cjs');
  let serviceManifest;
  try {
    serviceManifest = serviceStart.normalizeServiceStartManifest(
      report?.manifest,
    );
  } catch (error) {
    return Object.freeze([
      `service start evidence manifest is invalid: ${error.message}`,
    ]);
  }
  const violations = [
    ...serviceStart.validateServiceStartReport(
      report,
      serviceManifest,
      observed,
    ),
  ];
  if (
    serviceManifest.deviceId !== manifest.deviceId ||
    serviceManifest.profile !== 'edge' ||
    serviceManifest.expectedArchitecture !== manifest.expectedArchitecture ||
    serviceManifest.expectedFilesystem !== manifest.expectedFilesystem
  ) {
    violations.push('service start evidence device binding did not match');
  }
  return Object.freeze(violations);
}

function readServiceStartEvidence(filePath, manifest, observed) {
  let report;
  try {
    const stat = fs.lstatSync(filePath);
    assertPrivateEvidenceFile(stat, 'service start evidence');
    report = JSON.parse(readBoundedFile(filePath, 'service start evidence'));
  } catch (error) {
    if (error instanceof QingLong3PhysicalEvidenceError) throw error;
    throw new QingLong3PhysicalEvidenceError(
      `service start evidence could not be read: ${error.message}`,
    );
  }
  const violations = validateServiceStartEvidenceReport(
    report,
    manifest,
    observed,
  );
  if (violations.length > 0) {
    throw new QingLong3PhysicalEvidenceError(
      `service start evidence rejected: ${violations.join('; ')}`,
    );
  }
  return Object.freeze(report);
}

function validateDirectServiceStartEvidenceReport(report, manifest, observed) {
  const directServiceStart = require('./ql3-physical-edge-direct-service-start.cjs');
  let directManifest;
  try {
    directManifest = directServiceStart.normalizeDirectServiceStartManifest(
      report?.manifest,
    );
  } catch (error) {
    return Object.freeze([
      `direct service start evidence manifest is invalid: ${error.message}`,
    ]);
  }
  const violations = [
    ...directServiceStart.validateDirectServiceStartReport(
      report,
      directManifest,
      observed,
    ),
  ];
  if (
    directManifest.deviceId !== manifest.deviceId ||
    directManifest.profile !== 'edge' ||
    directManifest.expectedArchitecture !== manifest.expectedArchitecture ||
    directManifest.expectedFilesystem !== manifest.expectedFilesystem
  ) {
    violations.push(
      'direct service start evidence device binding did not match',
    );
  }
  return Object.freeze(violations);
}

function readDirectServiceStartEvidence(filePath, manifest, observed) {
  let report;
  try {
    const stat = fs.lstatSync(filePath);
    assertPrivateEvidenceFile(stat, 'direct service start evidence');
    report = JSON.parse(
      readBoundedFile(filePath, 'direct service start evidence'),
    );
  } catch (error) {
    if (error instanceof QingLong3PhysicalEvidenceError) throw error;
    throw new QingLong3PhysicalEvidenceError(
      `direct service start evidence could not be read: ${error.message}`,
    );
  }
  const violations = validateDirectServiceStartEvidenceReport(
    report,
    manifest,
    observed,
  );
  if (violations.length > 0) {
    throw new QingLong3PhysicalEvidenceError(
      `direct service start evidence rejected: ${violations.join('; ')}`,
    );
  }
  return Object.freeze(report);
}

function validateDirectServiceStopEvidenceReport(
  report,
  manifest,
  observed,
  directServiceStartEvidence,
) {
  const directServiceStart = require('./ql3-physical-edge-direct-service-start.cjs');
  const directServiceStop = require('./ql3-physical-edge-direct-service-stop.cjs');
  let directManifest;
  try {
    directManifest = directServiceStart.normalizeDirectServiceStartManifest(
      report?.manifest,
    );
  } catch (error) {
    return Object.freeze([
      `direct service stop evidence manifest is invalid: ${error.message}`,
    ]);
  }
  const violations = [
    ...directServiceStop.validateDirectServiceStopReport(
      report,
      directManifest,
    ),
  ];
  if (
    directManifest.deviceId !== manifest.deviceId ||
    directManifest.profile !== 'edge' ||
    directManifest.expectedArchitecture !== manifest.expectedArchitecture ||
    directManifest.expectedFilesystem !== manifest.expectedFilesystem ||
    report?.observed?.currentBootId !== observed.bootId
  ) {
    violations.push(
      'direct service stop evidence device binding did not match',
    );
  }
  if (
    !directServiceStartEvidence ||
    report?.session?.activeReportDigest !== directServiceStartEvidence.sha256 ||
    report?.session?.directSessionDigest !==
      directServiceStartEvidence.session?.sessionDigest ||
    report?.session?.activeBootId !==
      directServiceStartEvidence.observed?.after?.bootId ||
    report?.session?.startupReceiptDigest !==
      directServiceStartEvidence.observed?.receipt?.sha256 ||
    report?.session?.processId !==
      directServiceStartEvidence.observed?.receipt?.processId ||
    report?.session?.processStartTicks !==
      directServiceStartEvidence.observed?.receipt?.processStartTicks ||
    report?.observed?.shutdownReceipt?.instanceId !==
      directServiceStartEvidence.observed?.receipt?.instanceId ||
    report?.observed?.shutdownReceipt?.nodeExecutable !==
      directServiceStartEvidence.observed?.receipt?.nodeExecutable
  ) {
    violations.push(
      'direct service stop evidence lost the active report binding',
    );
  }
  return Object.freeze(violations);
}

function readDirectServiceStopEvidence(
  filePath,
  manifest,
  observed,
  directServiceStartEvidence,
) {
  let report;
  try {
    const stat = fs.lstatSync(filePath);
    assertPrivateEvidenceFile(stat, 'direct service stop evidence');
    report = JSON.parse(
      readBoundedFile(filePath, 'direct service stop evidence'),
    );
  } catch (error) {
    if (error instanceof QingLong3PhysicalEvidenceError) throw error;
    throw new QingLong3PhysicalEvidenceError(
      `direct service stop evidence could not be read: ${error.message}`,
    );
  }
  const violations = validateDirectServiceStopEvidenceReport(
    report,
    manifest,
    observed,
    directServiceStartEvidence,
  );
  if (violations.length > 0) {
    throw new QingLong3PhysicalEvidenceError(
      `direct service stop evidence rejected: ${violations.join('; ')}`,
    );
  }
  return Object.freeze(report);
}

function buildEvidenceReport({
  manifest,
  observed,
  workloads,
  supplementalEvidence = [],
  generatedAt,
}) {
  const violations = validateObservedPlatform(manifest, observed);
  const idleEvidence = supplementalEvidence.find(
    ({ evidenceClass }) => evidenceClass === 'physical_edge_idle_candidate',
  );
  const faultKinds = new Set(
    supplementalEvidence
      .filter(
        ({ evidenceClass }) =>
          evidenceClass === 'physical_edge_fault_candidate',
      )
      .map(({ manifest: supplementalManifest }) => supplementalManifest.fault),
  );
  const taskScaleEvidence = supplementalEvidence.find(
    ({ evidenceClass }) =>
      evidenceClass === 'physical_edge_task_scale_candidate',
  );
  const adoptionScaleEvidence = supplementalEvidence.find(
    ({ evidenceClass }) =>
      evidenceClass === 'physical_edge_adoption_scale_candidate',
  );
  const composeStorageEvidence = supplementalEvidence.find(
    ({ evidenceClass }) =>
      evidenceClass === 'physical_edge_compose_storage_candidate',
  );
  const applicationStartEvidence = supplementalEvidence.find(
    ({ evidenceClass }) =>
      evidenceClass === 'physical_edge_application_start_candidate',
  );
  const serviceStartEvidence = supplementalEvidence.find(
    ({ evidenceClass }) =>
      evidenceClass === 'physical_edge_service_start_candidate',
  );
  const directServiceStartEvidence = supplementalEvidence.find(
    ({ evidenceClass }) =>
      evidenceClass === 'physical_edge_direct_service_start_candidate',
  );
  const directServiceStopEvidence = supplementalEvidence.find(
    ({ evidenceClass }) =>
      evidenceClass === 'physical_edge_direct_service_stop_candidate',
  );
  if (
    directServiceStopEvidence &&
    (!directServiceStartEvidence ||
      directServiceStopEvidence.session?.activeReportDigest !==
        directServiceStartEvidence.sha256)
  ) {
    violations.push('direct service stop evidence is detached from start');
  }
  const collectedEvidence = [];
  if (idleEvidence) {
    collectedEvidence.push(
      'idle_process_rss_cpu_ticks_context_switches_and_io',
    );
  }
  if (faultKinds.has('enospc_filesystem')) {
    collectedEvidence.push('real_enospc_filesystem');
  }
  if (faultKinds.has('read_only_filesystem')) {
    collectedEvidence.push('read_only_filesystem');
  }
  if (taskScaleEvidence) {
    collectedEvidence.push('task_definition_100_1000_10000_scaling');
  }
  if (adoptionScaleEvidence) {
    collectedEvidence.push('legacy_adoption_100000_row_scaling');
  }
  if (composeStorageEvidence) {
    collectedEvidence.push(
      'compose_sqlite_collection_reboot_and_partition_write_upper_bound',
    );
  }
  if (applicationStartEvidence) {
    collectedEvidence.push(
      'post_reboot_warm_node_native_application_start_to_active',
    );
  }
  if (serviceStartEvidence) {
    collectedEvidence.push(
      'kernel_boot_to_init_managed_native_application_active',
    );
  }
  if (directServiceStartEvidence) {
    collectedEvidence.push(
      'kernel_boot_to_direct_init_managed_release_application_active',
    );
  }
  if (directServiceStopEvidence) {
    collectedEvidence.push('init_managed_graceful_application_stop');
  }
  const remainingRequiredEvidence = [
    ...(directServiceStartEvidence
      ? ['firmware_and_bootloader_power_on_to_linux_kernel_clock']
      : serviceStartEvidence
      ? [
          'firmware_and_bootloader_power_on_to_linux_kernel_clock',
          'direct_release_unit_without_evidence_wrapper',
        ]
      : applicationStartEvidence
      ? ['power_on_cold_node_and_service_manager_start_to_first_ready']
      : ['cold_start_and_first_ready']),
    ...(directServiceStartEvidence && !directServiceStopEvidence
      ? ['init_managed_graceful_application_stop']
      : []),
    'whole_device_cpu_wakeups_and_flash_write_amplification',
    'migration_time_and_peak_disk',
    ...(composeStorageEvidence
      ? []
      : ['compose_sqlite_collection_reboot_and_partition_write_upper_bound']),
    'power_loss_restart',
    'release_archive_signature',
  ];
  if (!idleEvidence) {
    remainingRequiredEvidence.splice(
      1,
      0,
      'idle_process_rss_cpu_ticks_context_switches_and_io',
    );
  }
  if (!taskScaleEvidence) {
    remainingRequiredEvidence.splice(
      2,
      0,
      'task_definition_100_1000_10000_scaling',
    );
  }
  if (!adoptionScaleEvidence) {
    remainingRequiredEvidence.splice(
      3,
      0,
      'legacy_adoption_100000_row_scaling',
    );
  }
  if (!faultKinds.has('enospc_filesystem')) {
    remainingRequiredEvidence.splice(-1, 0, 'real_enospc_filesystem');
  }
  if (!faultKinds.has('read_only_filesystem')) {
    remainingRequiredEvidence.splice(-1, 0, 'read_only_filesystem');
  }
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_candidate',
    supported: false,
    generatedAt,
    manifest,
    observed,
    workloads,
    supplementalEvidence,
    qualification: {
      physicalCandidate: violations.length === 0,
      violations,
      collectedEvidence,
      remainingRequiredEvidence,
    },
  };
  return Object.freeze({ ...body, sha256: canonicalDigest(body) });
}

function writeNoReplace(outputPath, contents) {
  const parent = fs.realpathSync(path.dirname(outputPath));
  const resolved = path.join(parent, path.basename(outputPath));
  if (resolved !== outputPath) {
    throw new QingLong3PhysicalEvidenceError(
      'outputPath parent must be canonical',
    );
  }
  const descriptor = fs.openSync(outputPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new QingLong3PhysicalEvidenceError('Node.js 24 or newer is required');
  }
  const options = parseArguments(process.argv.slice(2));
  const manifest = readManifest(options.manifestPath);
  const observed = collectObservedPlatform(options.dataPath);
  const preflightViolations = validateObservedPlatform(manifest, observed);
  if (preflightViolations.length > 0) {
    throw new QingLong3PhysicalEvidenceError(
      `device preflight rejected: ${preflightViolations.join('; ')}`,
    );
  }
  const root = path.resolve(__dirname, '..');
  const workloads = runEvidenceWorkloads(root, observed.dataPath);
  const supplementalEvidence = options.idleEvidencePath
    ? [readIdleEvidence(options.idleEvidencePath, manifest, observed)]
    : [];
  if (options.taskScaleEvidencePath) {
    supplementalEvidence.push(
      readTaskScaleEvidence(options.taskScaleEvidencePath, manifest, observed),
    );
  }
  if (options.adoptionScaleEvidencePath) {
    supplementalEvidence.push(
      readAdoptionScaleEvidence(
        options.adoptionScaleEvidencePath,
        manifest,
        observed,
      ),
    );
  }
  if (options.composeStorageEvidencePath) {
    supplementalEvidence.push(
      readComposeStorageEvidence(
        options.composeStorageEvidencePath,
        manifest,
        observed,
      ),
    );
  }
  if (options.applicationStartEvidencePath) {
    supplementalEvidence.push(
      readApplicationStartEvidence(
        options.applicationStartEvidencePath,
        manifest,
        observed,
      ),
    );
  }
  if (options.serviceStartEvidencePath) {
    supplementalEvidence.push(
      readServiceStartEvidence(
        options.serviceStartEvidencePath,
        manifest,
        observed,
      ),
    );
  }
  let directServiceStartEvidence;
  if (options.directServiceStartEvidencePath) {
    directServiceStartEvidence = readDirectServiceStartEvidence(
      options.directServiceStartEvidencePath,
      manifest,
      observed,
    );
    supplementalEvidence.push(directServiceStartEvidence);
  }
  if (options.directServiceStopEvidencePath) {
    if (!directServiceStartEvidence) {
      throw new QingLong3PhysicalEvidenceError(
        'direct service stop evidence requires direct service start evidence',
      );
    }
    supplementalEvidence.push(
      readDirectServiceStopEvidence(
        options.directServiceStopEvidencePath,
        manifest,
        observed,
        directServiceStartEvidence,
      ),
    );
  }
  for (const faultPath of options.faultEvidencePaths ?? []) {
    supplementalEvidence.push(readFaultEvidence(faultPath, manifest, observed));
  }
  const faultKinds = supplementalEvidence
    .filter(
      ({ evidenceClass }) => evidenceClass === 'physical_edge_fault_candidate',
    )
    .map(({ manifest: supplementalManifest }) => supplementalManifest.fault);
  if (new Set(faultKinds).size !== faultKinds.length) {
    throw new QingLong3PhysicalEvidenceError(
      'duplicate fault evidence is not allowed',
    );
  }
  const report = buildEvidenceReport({
    manifest,
    observed,
    workloads,
    supplementalEvidence,
    generatedAt: new Date().toISOString(),
  });
  const serialized = `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`;
  if (options.outputPath) writeNoReplace(options.outputPath, serialized);
  process.stdout.write(serialized);
}

module.exports = {
  QingLong3PhysicalEvidenceError,
  assertPrivateEvidenceFile,
  buildEvidenceReport,
  canonicalDigest,
  collectObservedPlatform,
  mountForPath,
  normalizeManifest,
  parseArguments,
  parseMountTable,
  parseOsRelease,
  readIdleEvidence,
  readAdoptionScaleEvidence,
  readTaskScaleEvidence,
  readFaultEvidence,
  readComposeStorageEvidence,
  readApplicationStartEvidence,
  readServiceStartEvidence,
  readDirectServiceStartEvidence,
  readDirectServiceStopEvidence,
  validateFaultEvidenceReport,
  validateIdleEvidenceReport,
  validateAdoptionScaleEvidenceReport,
  validateTaskScaleEvidenceReport,
  validateComposeStorageEvidenceReport,
  validateApplicationStartEvidenceReport,
  validateServiceStartEvidenceReport,
  validateDirectServiceStartEvidenceReport,
  validateDirectServiceStopEvidenceReport,
  validateTaskScaleWorkload,
  validateObservedPlatform,
  writeNoReplace,
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
