#!/usr/bin/env node

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const {
  canonicalDigest,
  collectObservedPlatform,
  writeNoReplace,
} = require('./ql3-physical-edge-evidence.cjs');
const {
  fileUsage,
  validateObserved,
} = require('./ql3-physical-edge-task-scale.cjs');

const ROW_COUNT = 100_000;
const MAX_REVIEW_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const MANIFEST_KEYS = Object.freeze([
  'deviceId',
  'evidenceClass',
  'expectedArchitecture',
  'expectedFilesystem',
  'maxReviewFileBytes',
  'profile',
  'rowCount',
  'schemaVersion',
]);
const REPORT_KEYS = Object.freeze([
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
const OBSERVED_KEYS = Object.freeze([
  'architecture',
  'bootId',
  'dataPath',
  'filesystem',
  'mountOptions',
  'node',
  'platform',
]);
const WORKLOAD_KEYS = Object.freeze(['commit', 'final', 'issue', 'preflight']);
const PREFLIGHT_KEYS = Object.freeze([
  'reviewFileBytes',
  'sourceRowCount',
  'targetLedgerCount',
  'targetStorage',
]);
const FINAL_KEYS = Object.freeze([
  'adoptedTaskCount',
  'adoptedTriggerCount',
  'ledgerCount',
  'targetStorage',
]);
const PHASE_KEYS = Object.freeze([
  'cancelledWriteBytes',
  'durationMs',
  'exitCode',
  'peakRssBytes',
  'readBytes',
  'sampleCount',
  'writeBytes',
]);
const STORAGE_KEYS = Object.freeze(['allocatedBytes', 'files', 'logicalBytes']);
const STORAGE_FILE_KEYS = Object.freeze([
  'allocatedBytes',
  'logicalBytes',
  'suffix',
]);
const QUALIFICATION_KEYS = Object.freeze([
  'doesNotProve',
  'measures',
  'passed',
  'violations',
]);
const MEASURES = Object.freeze([
  'real_ql3_adoption_issue_and_commit_binary',
  '100000_reviewed_legacy_crontab_rows',
  'child_peak_rss_sampling',
  'linux_process_storage_io_bytes',
  'database_logical_and_allocated_bytes',
  'atomic_task_trigger_audit_ledger_result',
]);
const EXCLUSIONS = Object.freeze([
  'whole_device_flash_or_nand_write_amplification',
  'power_loss_survival',
  'human_review_ui_throughput',
  'production_scheduler_or_run_admission',
  'cluster_or_postgresql_adoption',
]);

class QingLong3PhysicalAdoptionScaleEvidenceError extends Error {
  constructor(message) {
    super(`QingLong 3.0 physical Edge adoption evidence failed: ${message}`);
    this.name = 'QingLong3PhysicalAdoptionScaleEvidenceError';
  }
}

function exactKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)
  ) {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      `${label} shape is invalid`,
    );
  }
}

function normalizeManifest(value) {
  exactKeys(value, MANIFEST_KEYS, 'manifest');
  if (
    value.schemaVersion !== 1 ||
    value.evidenceClass !== 'physical_edge_adoption_scale_candidate' ||
    value.profile !== 'edge' ||
    value.rowCount !== ROW_COUNT ||
    value.maxReviewFileBytes !== MAX_REVIEW_BYTES ||
    typeof value.deviceId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.deviceId) ||
    !['x64', 'arm64', 'arm'].includes(value.expectedArchitecture) ||
    typeof value.expectedFilesystem !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(value.expectedFilesystem)
  ) {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      'manifest identity or fixed workload is invalid',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_adoption_scale_candidate',
    profile: 'edge',
    deviceId: value.deviceId,
    expectedArchitecture: value.expectedArchitecture,
    expectedFilesystem: value.expectedFilesystem,
    rowCount: ROW_COUNT,
    maxReviewFileBytes: MAX_REVIEW_BYTES,
  });
}

function parseArguments(argv) {
  const options = { json: false };
  for (const argument of argv) {
    if (argument === '--' || argument === '--json') {
      if (argument === '--json') options.json = true;
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator < 1) {
      throw new QingLong3PhysicalAdoptionScaleEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (name === '--manifest') options.manifestPath = value;
    else if (name === '--data-path') options.dataPath = value;
    else if (name === '--issue-command') options.issueCommandPath = value;
    else if (name === '--commit-command') options.commitCommandPath = value;
    else if (name === '--output') options.outputPath = value;
    else {
      throw new QingLong3PhysicalAdoptionScaleEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
  }
  for (const name of [
    'manifestPath',
    'dataPath',
    'issueCommandPath',
    'commitCommandPath',
    'outputPath',
  ]) {
    if (!path.isAbsolute(options[name] ?? '')) {
      throw new QingLong3PhysicalAdoptionScaleEvidenceError(
        `${name} must be absolute`,
      );
    }
  }
  return Object.freeze(options);
}

function readPrivateJson(filePath, label) {
  try {
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.geteuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size < 1 ||
      stat.size > MAX_INPUT_BYTES
    ) {
      throw new Error('private file identity is invalid');
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      `${label} could not be read: ${error.message}`,
    );
  }
}

function commandFixture(issue, commit, dataPath) {
  if (
    issue?.schemaVersion !== 1 ||
    issue.operation !== 'legacy-crontab.decision.issue' ||
    commit?.schemaVersion !== 1 ||
    commit.operation !== 'legacy-crontab.adoption.commit'
  ) {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      'command operations are invalid',
    );
  }
  const left = issue.options;
  const right = commit.options;
  if (
    !left ||
    !right ||
    left.profile !== 'edge' ||
    right.profile !== 'edge' ||
    left.deploymentRoot !== right.deploymentRoot ||
    left.databasePath !== right.targetPath ||
    left.sourcePath !== right.sourcePath ||
    left.authorizationPath !== right.authorizationPath ||
    left.credentialFilePath !== right.credentialFilePath ||
    left.issuerKeyringPath !== right.issuerKeyringPath ||
    left.ownerPepperKeyringDirectory !== right.ownerPepperKeyringDirectory ||
    left.expectedPlanDigest !== right.expectedPlanDigest ||
    left.decisionId !== right.expectedDecisionId
  ) {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      'issue and commit commands do not describe one adoption',
    );
  }
  for (const candidate of [
    left.deploymentRoot,
    left.databasePath,
    left.sourcePath,
    left.reviewFilePath,
    left.authorizationPath,
  ]) {
    const relative = path.relative(dataPath, candidate ?? '');
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new QingLong3PhysicalAdoptionScaleEvidenceError(
        'adoption fixture must be contained by dataPath',
      );
    }
  }
  return Object.freeze({
    sourcePath: left.sourcePath,
    targetPath: left.databasePath,
    reviewFilePath: left.reviewFilePath,
    authorizationPath: left.authorizationPath,
  });
}

function readProcMeasurement(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const io = fs.readFileSync(`/proc/${pid}/io`, 'utf8');
  const rss = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0) * 1024;
  const value = (name) =>
    Number(io.match(new RegExp(`^${name}:\\s+(\\d+)$`, 'm'))?.[1] ?? 0);
  return Object.freeze({
    rssBytes: rss,
    readBytes: value('read_bytes'),
    writeBytes: value('write_bytes'),
    cancelledWriteBytes: value('cancelled_write_bytes'),
  });
}

async function measureProductCommand(binaryPath, commandPath) {
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [binaryPath, 'run', '--command-file', commandPath],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  let peakRssBytes = 0;
  let sampleCount = 0;
  let io = { readBytes: 0, writeBytes: 0, cancelledWriteBytes: 0 };
  const sample = () => {
    try {
      const current = readProcMeasurement(child.pid);
      sampleCount += 1;
      peakRssBytes = Math.max(peakRssBytes, current.rssBytes);
      io = current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };
  sample();
  const sampler = setInterval(sample, 10);
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > MAX_CHILD_OUTPUT_BYTES)
      child.kill('SIGKILL');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr) > MAX_CHILD_OUTPUT_BYTES)
      child.kill('SIGKILL');
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearInterval(sampler);
  if (exitCode !== 0) {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      `product command failed with exit ${exitCode}: ${stderr.slice(0, 512)}`,
    );
  }
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      'product command returned invalid bounded JSON',
    );
  }
  return Object.freeze({
    result,
    measurement: Object.freeze({
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
      peakRssBytes,
      sampleCount,
      readBytes: io.readBytes,
      writeBytes: io.writeBytes,
      cancelledWriteBytes: io.cancelledWriteBytes,
      exitCode,
    }),
  });
}

function databaseCount(databasePath, table) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number(
      database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count,
    );
  } finally {
    database.close();
  }
}

function validStorage(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(STORAGE_KEYS) ||
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
  return value.files.every((file) => {
    if (
      !file ||
      typeof file !== 'object' ||
      Array.isArray(file) ||
      JSON.stringify(Object.keys(file).sort()) !==
        JSON.stringify(STORAGE_FILE_KEYS) ||
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
    return true;
  });
}

function buildReport({
  manifest,
  observed,
  preflight,
  issue,
  commit,
  final,
  generatedAt,
}) {
  const violations = [...validateObserved(manifest, observed)];
  if (
    preflight.sourceRowCount !== ROW_COUNT ||
    preflight.reviewFileBytes < 1 ||
    preflight.reviewFileBytes > MAX_REVIEW_BYTES ||
    preflight.targetLedgerCount !== 0 ||
    !validStorage(preflight.targetStorage)
  ) {
    violations.push('prepared adoption fixture is invalid');
  }
  for (const [name, phase] of [
    ['issue', issue],
    ['commit', commit],
  ]) {
    if (
      phase.exitCode !== 0 ||
      phase.sampleCount < 1 ||
      !Number.isSafeInteger(phase.sampleCount) ||
      phase.peakRssBytes < 1 ||
      !Number.isSafeInteger(phase.peakRssBytes) ||
      phase.durationMs < 0 ||
      !Number.isFinite(phase.durationMs) ||
      phase.readBytes < 0 ||
      !Number.isSafeInteger(phase.readBytes) ||
      phase.writeBytes < 0 ||
      !Number.isSafeInteger(phase.writeBytes) ||
      !Number.isSafeInteger(phase.cancelledWriteBytes)
    ) {
      violations.push(`${name} measurement is invalid`);
    }
  }
  if (
    final.ledgerCount !== 1 ||
    final.adoptedTaskCount !== ROW_COUNT ||
    final.adoptedTriggerCount !== ROW_COUNT ||
    !validStorage(final.targetStorage)
  ) {
    violations.push('atomic adoption result is incomplete');
  }
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_adoption_scale_candidate',
    supported: false,
    generatedAt,
    manifest,
    observed: Object.freeze({
      platform: observed.platform,
      architecture: observed.architecture,
      node: observed.node,
      bootId: observed.bootId,
      dataPath: observed.dataPath,
      filesystem: observed.dataFilesystem,
      mountOptions: observed.dataMountOptions,
    }),
    workload: Object.freeze({ preflight, issue, commit, final }),
    qualification: Object.freeze({
      passed: violations.length === 0,
      violations: Object.freeze(violations),
      measures: MEASURES,
      doesNotProve: EXCLUSIONS,
    }),
  };
  return Object.freeze({ ...body, sha256: canonicalDigest(body) });
}

function validateReport(report, manifest, observed) {
  const violations = [];
  try {
    exactKeys(report, REPORT_KEYS, 'report');
  } catch (error) {
    return Object.freeze([error.message]);
  }
  const { sha256, ...body } = report;
  if (
    !/^[a-f0-9]{64}$/.test(sha256 ?? '') ||
    canonicalDigest(body) !== sha256
  ) {
    violations.push('report SHA-256 is invalid');
  }
  if (
    report.schemaVersion !== 1 ||
    report.evidenceClass !== 'physical_edge_adoption_scale_candidate' ||
    report.supported !== false ||
    !Number.isFinite(Date.parse(report.generatedAt))
  ) {
    violations.push('report identity is invalid');
  }
  if (
    JSON.stringify(Object.keys(report.observed ?? {}).sort()) !==
      JSON.stringify(OBSERVED_KEYS) ||
    JSON.stringify(report.manifest) !== JSON.stringify(manifest) ||
    report.observed?.platform !== 'linux' ||
    report.observed?.architecture !== observed.architecture ||
    report.observed?.bootId !== observed.bootId ||
    report.observed?.dataPath !== observed.dataPath ||
    report.observed?.filesystem !== observed.dataFilesystem ||
    JSON.stringify(report.observed?.mountOptions) !==
      JSON.stringify(observed.dataMountOptions)
  ) {
    violations.push('report device identity did not match');
  }
  if (
    JSON.stringify(Object.keys(report.qualification ?? {}).sort()) !==
      JSON.stringify(QUALIFICATION_KEYS) ||
    report.qualification?.passed !== true ||
    !Array.isArray(report.qualification?.violations) ||
    report.qualification.violations.length !== 0 ||
    JSON.stringify(report.qualification?.measures) !==
      JSON.stringify(MEASURES) ||
    JSON.stringify(report.qualification?.doesNotProve) !==
      JSON.stringify(EXCLUSIONS)
  ) {
    violations.push('report qualification scope was widened');
  }
  const workload = report.workload;
  if (
    JSON.stringify(Object.keys(workload ?? {}).sort()) !==
      JSON.stringify(WORKLOAD_KEYS) ||
    JSON.stringify(Object.keys(workload?.preflight ?? {}).sort()) !==
      JSON.stringify(PREFLIGHT_KEYS) ||
    JSON.stringify(Object.keys(workload?.final ?? {}).sort()) !==
      JSON.stringify(FINAL_KEYS) ||
    workload?.preflight?.sourceRowCount !== ROW_COUNT ||
    workload.preflight.reviewFileBytes < 1 ||
    workload.preflight.reviewFileBytes > MAX_REVIEW_BYTES ||
    workload.preflight.targetLedgerCount !== 0 ||
    !validStorage(workload.preflight.targetStorage) ||
    workload?.final?.ledgerCount !== 1 ||
    workload.final.adoptedTaskCount !== ROW_COUNT ||
    workload.final.adoptedTriggerCount !== ROW_COUNT ||
    !validStorage(workload.final.targetStorage)
  ) {
    violations.push('report workload is incomplete');
  }
  for (const phase of [workload?.issue, workload?.commit]) {
    if (
      JSON.stringify(Object.keys(phase ?? {}).sort()) !==
        JSON.stringify(PHASE_KEYS) ||
      phase?.exitCode !== 0 ||
      !Number.isSafeInteger(phase.sampleCount) ||
      phase.sampleCount < 1 ||
      !Number.isSafeInteger(phase.peakRssBytes) ||
      phase.peakRssBytes < 1 ||
      !Number.isFinite(phase.durationMs) ||
      phase.durationMs < 0 ||
      !Number.isSafeInteger(phase.readBytes) ||
      phase.readBytes < 0 ||
      !Number.isSafeInteger(phase.writeBytes) ||
      phase.writeBytes < 0 ||
      !Number.isSafeInteger(phase.cancelledWriteBytes)
    ) {
      violations.push('report phase measurement is invalid');
      break;
    }
  }
  return Object.freeze(violations);
}

function readEvidence(filePath, manifest, observed) {
  const report = readPrivateJson(filePath, 'adoption evidence');
  const violations = validateReport(report, manifest, observed);
  if (violations.length > 0) {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      `adoption evidence rejected: ${violations.join('; ')}`,
    );
  }
  return Object.freeze(report);
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'linux' || major !== 24 || minor < 18) {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      'native Linux Node.js 24.18 or newer within major 24 is required',
    );
  }
  const options = parseArguments(process.argv.slice(2));
  const manifest = normalizeManifest(
    readPrivateJson(options.manifestPath, 'manifest'),
  );
  const observed = collectObservedPlatform(options.dataPath);
  const preflightViolations = validateObserved(manifest, observed);
  if (preflightViolations.length > 0) {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      `device preflight rejected: ${preflightViolations.join('; ')}`,
    );
  }
  const issueCommand = readPrivateJson(
    options.issueCommandPath,
    'issue command',
  );
  const commitCommand = readPrivateJson(
    options.commitCommandPath,
    'commit command',
  );
  const fixture = commandFixture(
    issueCommand,
    commitCommand,
    observed.dataPath,
  );
  if (fs.existsSync(fixture.authorizationPath)) {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      'authorization must not exist before measurement',
    );
  }
  const preflight = Object.freeze({
    sourceRowCount: databaseCount(fixture.sourcePath, 'Crontabs'),
    reviewFileBytes: fs.statSync(fixture.reviewFilePath).size,
    targetLedgerCount: databaseCount(
      fixture.targetPath,
      'QingLong3LegacyAdoptions',
    ),
    targetStorage: fileUsage(fixture.targetPath),
  });
  const binaryPath = path.resolve(
    __dirname,
    '../packages/ql3-local-owner-cli/dist/lifecycle/adoptionCli.js',
  );
  const issue = await measureProductCommand(
    binaryPath,
    options.issueCommandPath,
  );
  if (issue.result.operation !== 'legacy-crontab.decision.issue') {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      'issue result identity is invalid',
    );
  }
  const commit = await measureProductCommand(
    binaryPath,
    options.commitCommandPath,
  );
  if (
    commit.result.operation !== 'legacy-crontab.adoption.commit' ||
    commit.result.status !== 'inserted'
  ) {
    throw new QingLong3PhysicalAdoptionScaleEvidenceError(
      'commit result identity is invalid',
    );
  }
  const final = Object.freeze({
    ledgerCount: databaseCount(fixture.targetPath, 'QingLong3LegacyAdoptions'),
    adoptedTaskCount: commit.result.adoption.adoptedTaskCount,
    adoptedTriggerCount: commit.result.adoption.adoptedTriggerCount,
    targetStorage: fileUsage(fixture.targetPath),
  });
  const report = buildReport({
    manifest,
    observed,
    preflight,
    issue: issue.measurement,
    commit: commit.measurement,
    final,
    generatedAt: new Date().toISOString(),
  });
  const serialized = `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`;
  writeNoReplace(options.outputPath, serialized);
  process.stdout.write(serialized);
}

module.exports = {
  MAX_REVIEW_BYTES,
  QingLong3PhysicalAdoptionScaleEvidenceError,
  ROW_COUNT,
  buildReport,
  commandFixture,
  normalizeManifest,
  parseArguments,
  readEvidence,
  readProcMeasurement,
  validateReport,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
