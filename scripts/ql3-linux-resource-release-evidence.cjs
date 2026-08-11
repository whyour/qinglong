#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const {
  RESOURCE_TIERS,
  createWorkloadPlans,
} = require('./ql3-linux-resource-gate.cjs');

const ARCHITECTURES = Object.freeze(['x64', 'arm64']);
const TIER_NAMES = Object.freeze([
  'router-stress-ci',
  'edge-release-ci',
  'cluster-control-ci',
]);
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 100_000;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,31}$/;
const NODE_VERSION = 'v24.18.0';

class QingLong3LinuxResourceReleaseEvidenceError extends Error {
  constructor(message) {
    super(`QingLong 3.0 Linux resource release evidence failed: ${message}`);
    this.name = 'QingLong3LinuxResourceReleaseEvidenceError';
  }
}

function fail(message) {
  throw new QingLong3LinuxResourceReleaseEvidenceError(message);
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be a plain object`);
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(assertRecord(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields are invalid`);
  }
}

function assertSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function canonicalize(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_NODES) fail('evidence node budget exceeded');
  if (depth > MAX_CANONICAL_DEPTH) fail('evidence depth budget exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('evidence contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry, depth + 1, budget));
  }
  if (!isRecord(value)) fail('evidence contains an unsupported value');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!key || key.length > 128) fail('evidence contains an invalid key');
    result[key] = canonicalize(value[key], depth + 1, budget);
  }
  return result;
}

function evidenceDigest(value) {
  return createHash('sha256')
    .update('qinglong/linux-resource-release-evidence\0')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function normalizeSource(source) {
  assertExactKeys(
    source,
    ['repository', 'revision', 'workflow', 'runId', 'runAttempt'],
    'source',
  );
  if (
    typeof source.repository !== 'string' ||
    !REPOSITORY_PATTERN.test(source.repository)
  ) {
    fail('source repository is invalid');
  }
  if (
    typeof source.revision !== 'string' ||
    !REVISION_PATTERN.test(source.revision)
  ) {
    fail('source revision must be a lowercase 40-character commit SHA');
  }
  if (
    typeof source.workflow !== 'string' ||
    source.workflow.length < 1 ||
    source.workflow.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(source.workflow)
  ) {
    fail('source workflow is invalid');
  }
  if (
    typeof source.runId !== 'string' ||
    !RUN_ID_PATTERN.test(source.runId)
  ) {
    fail('source runId is invalid');
  }
  assertSafeInteger(source.runAttempt, 'source runAttempt', 1);
  return Object.freeze({
    repository: source.repository,
    revision: source.revision,
    workflow: source.workflow,
    runId: source.runId,
    runAttempt: source.runAttempt,
  });
}

function validateMemoryEvents(before, after, tierName) {
  assertRecord(before, `${tierName} memoryEventsBefore`);
  assertRecord(after, `${tierName} memoryEventsAfter`);
  for (const event of ['max', 'oom', 'oom_kill', 'oom_group_kill']) {
    const previous = assertSafeInteger(
      before[event],
      `${tierName} memoryEventsBefore.${event}`,
    );
    const current = assertSafeInteger(
      after[event],
      `${tierName} memoryEventsAfter.${event}`,
    );
    if (current !== previous) fail(`${tierName} memory event ${event} changed`);
  }
}

function validateTierReport(report, expectedTier, expectedArchitecture) {
  assertExactKeys(
    report,
    [
      'schemaVersion',
      'tier',
      'evidenceClass',
      'supportedMinimum',
      'identity',
      'envelope',
      'workloads',
      'gates',
    ],
    `${expectedTier} report`,
  );
  const tier = RESOURCE_TIERS[expectedTier];
  if (
    report.schemaVersion !== 1 ||
    report.tier !== expectedTier ||
    report.evidenceClass !== tier.evidenceClass ||
    report.supportedMinimum !== tier.supportedMinimum
  ) {
    fail(`${expectedTier} identity is invalid`);
  }

  assertExactKeys(
    report.identity,
    ['platform', 'architecture', 'node', 'uid', 'gid'],
    `${expectedTier} process identity`,
  );
  if (
    report.identity.platform !== 'linux' ||
    report.identity.architecture !== expectedArchitecture ||
    report.identity.node !== NODE_VERSION ||
    report.identity.uid !== 65532 ||
    report.identity.gid !== 65532
  ) {
    fail(`${expectedTier} did not run under the reviewed native identity`);
  }

  assertExactKeys(
    report.envelope,
    [
      'memoryMaxBytes',
      'memoryPeakBytes',
      'swapMaxBytes',
      'cpuQuotaCores',
      'pidsMax',
      'noNewPrivileges',
      'seccompMode',
      'rootReadOnly',
      'workspaceReadOnly',
      'tmpWritable',
      'memoryEventsBefore',
      'memoryEventsAfter',
    ],
    `${expectedTier} envelope`,
  );
  if (
    report.envelope.memoryMaxBytes !== tier.memoryMaxBytes ||
    report.envelope.swapMaxBytes !== tier.swapMaxBytes ||
    report.envelope.cpuQuotaCores !== tier.cpuQuotaCores ||
    report.envelope.pidsMax !== tier.pidsMax ||
    report.envelope.noNewPrivileges !== 1 ||
    report.envelope.seccompMode !== 2 ||
    report.envelope.rootReadOnly !== true ||
    report.envelope.workspaceReadOnly !== true ||
    report.envelope.tmpWritable !== true
  ) {
    fail(`${expectedTier} envelope drifted`);
  }
  const peak = assertSafeInteger(
    report.envelope.memoryPeakBytes,
    `${expectedTier} memoryPeakBytes`,
    1,
  );
  if (peak > tier.memoryMaxBytes) fail(`${expectedTier} memory peak exceeded`);
  validateMemoryEvents(
    report.envelope.memoryEventsBefore,
    report.envelope.memoryEventsAfter,
    expectedTier,
  );

  if (!Array.isArray(report.workloads)) fail(`${expectedTier} workloads are invalid`);
  const expectedNames = createWorkloadPlans('/workspace', expectedTier).map(
    ({ name }) => name,
  );
  const actualNames = report.workloads.map((entry, index) => {
    assertExactKeys(entry, ['name', 'report'], `${expectedTier} workload ${index}`);
    if (!isRecord(entry.report)) fail(`${expectedTier} workload report is invalid`);
    return entry.name;
  });
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    fail(`${expectedTier} workload set drifted`);
  }

  assertExactKeys(report.gates, ['passed', 'violations'], `${expectedTier} gates`);
  if (
    report.gates.passed !== true ||
    !Array.isArray(report.gates.violations) ||
    report.gates.violations.length !== 0
  ) {
    fail(`${expectedTier} gate did not pass`);
  }
  canonicalize(report);
  return report;
}

function architecturePayload(source, architecture, reports) {
  return {
    schemaVersion: 1,
    fixture: 'qinglong/linux-resource-architecture-evidence@v1',
    source,
    architecture,
    reports,
    gates: {
      nativeArchitecture: true,
      exactTierSet: true,
      exactResourceEnvelopes: true,
      memoryEventsStable: true,
      allTierGatesPassed: true,
      sourceBound: true,
      passed: true,
    },
  };
}

function bundleArchitectureEvidence({ source, architecture, reports }) {
  const normalizedSource = normalizeSource(source);
  if (!ARCHITECTURES.includes(architecture)) fail('architecture is invalid');
  assertExactKeys(reports, TIER_NAMES, 'reports');
  const normalizedReports = Object.freeze(
    Object.fromEntries(
      TIER_NAMES.map((tierName) => [
        tierName,
        validateTierReport(reports[tierName], tierName, architecture),
      ]),
    ),
  );
  const payload = architecturePayload(
    normalizedSource,
    architecture,
    normalizedReports,
  );
  return Object.freeze({
    ...payload,
    bundleDigest: evidenceDigest(payload),
  });
}

function validateArchitectureEvidence(value, expectedSource, architecture) {
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'fixture',
      'source',
      'architecture',
      'reports',
      'gates',
      'bundleDigest',
    ],
    `${architecture} architecture evidence`,
  );
  const rebuilt = bundleArchitectureEvidence({
    source: value.source,
    architecture: value.architecture,
    reports: value.reports,
  });
  if (
    value.schemaVersion !== rebuilt.schemaVersion ||
    value.fixture !== rebuilt.fixture ||
    value.architecture !== architecture ||
    JSON.stringify(value.gates) !== JSON.stringify(rebuilt.gates) ||
    value.bundleDigest !== rebuilt.bundleDigest
  ) {
    fail(`${architecture} architecture evidence digest or gates drifted`);
  }
  if (JSON.stringify(rebuilt.source) !== JSON.stringify(normalizeSource(expectedSource))) {
    fail(`${architecture} architecture evidence belongs to another source`);
  }
  return rebuilt;
}

function tierSummary(report) {
  return Object.freeze({
    tier: report.tier,
    evidenceClass: report.evidenceClass,
    memoryMaxBytes: report.envelope.memoryMaxBytes,
    memoryPeakBytes: report.envelope.memoryPeakBytes,
    cpuQuotaCores: report.envelope.cpuQuotaCores,
    pidsMax: report.envelope.pidsMax,
    workloadCount: report.workloads.length,
  });
}

function releasePayload(source, x64, arm64) {
  return {
    schemaVersion: 1,
    fixture: 'qinglong/linux-resource-cross-architecture-evidence@v1',
    source,
    architectures: [x64, arm64].map((entry) => ({
      architecture: entry.architecture,
      node: entry.reports['router-stress-ci'].identity.node,
      bundleDigest: entry.bundleDigest,
      tiers: TIER_NAMES.map((tierName) => tierSummary(entry.reports[tierName])),
    })),
    gates: {
      nativeX64Passed: true,
      nativeArm64Passed: true,
      sameSourceRevision: true,
      sameWorkflowRun: true,
      exactTierParity: true,
      releaseEvidenceComplete: true,
      passed: true,
    },
    limitations: [
      'CI cgroup evidence is not a supported minimum hardware claim',
      'CI evidence does not replace fixed-device power-loss, flash, thermal, or soak evidence',
      'GitHub workflow identity binding is not a cryptographic hardware attestation',
    ],
  };
}

function mergeCrossArchitectureEvidence({ source, x64, arm64 }) {
  const normalizedSource = normalizeSource(source);
  const validatedX64 = validateArchitectureEvidence(x64, normalizedSource, 'x64');
  const validatedArm64 = validateArchitectureEvidence(
    arm64,
    normalizedSource,
    'arm64',
  );
  if (validatedX64.bundleDigest === validatedArm64.bundleDigest) {
    fail('architecture bundles must be independently measured');
  }
  const payload = releasePayload(
    normalizedSource,
    validatedX64,
    validatedArm64,
  );
  return Object.freeze({
    ...payload,
    releaseDigest: evidenceDigest(payload),
  });
}

function readJsonFile(filePath, label) {
  const absolute = path.resolve(filePath);
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    fail('platform does not support no-follow evidence reads');
  }
  let handle;
  try {
    handle = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    fail(
      `${label} must be a readable non-symlink file (${error?.code ?? 'unknown'})`,
    );
  }
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_EVIDENCE_BYTES) {
      fail(`${label} size is invalid`);
    }
    const content = fs.readFileSync(handle);
    if (content.length < 2 || content.length > MAX_EVIDENCE_BYTES) {
      fail(`${label} size is invalid`);
    }
    let value;
    try {
      value = JSON.parse(content.toString('utf8'));
    } catch {
      fail(`${label} must contain valid JSON`);
    }
    canonicalize(value);
    return value;
  } finally {
    fs.closeSync(handle);
  }
}

function writeJsonFile(filePath, value) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const handle = fs.openSync(absolute, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    fs.closeSync(handle);
  }
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    const separator = argument.indexOf('=');
    if (separator < 3 || !argument.startsWith('--')) {
      fail(`unsupported argument ${argument}`);
    }
    const name = argument.slice(2, separator);
    if (Object.hasOwn(options, name)) fail(`duplicate argument --${name}`);
    options[name] = argument.slice(separator + 1);
  }
  const mode = options.mode;
  const common = [
    'mode',
    'repository',
    'revision',
    'workflow',
    'run-id',
    'run-attempt',
    'output',
  ];
  const modeKeys =
    mode === 'bundle'
      ? [...common, 'architecture', ...TIER_NAMES]
      : mode === 'merge'
        ? [...common, 'x64', 'arm64']
        : fail('--mode must be bundle or merge');
  if (JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(modeKeys.sort())) {
    fail(`${mode} arguments are incomplete or widened`);
  }
  const runAttempt = Number(options['run-attempt']);
  const source = normalizeSource({
    repository: options.repository,
    revision: options.revision,
    workflow: options.workflow,
    runId: options['run-id'],
    runAttempt,
  });
  return Object.freeze({ ...options, mode, source });
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === 'bundle') {
    const reports = Object.fromEntries(
      TIER_NAMES.map((tierName) => [
        tierName,
        readJsonFile(options[tierName], tierName),
      ]),
    );
    const result = bundleArchitectureEvidence({
      source: options.source,
      architecture: options.architecture,
      reports,
    });
    writeJsonFile(options.output, result);
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, mode: 'bundle', architecture: result.architecture, bundleDigest: result.bundleDigest, passed: true })}\n`,
    );
    return;
  }
  const result = mergeCrossArchitectureEvidence({
    source: options.source,
    x64: readJsonFile(options.x64, 'x64 evidence'),
    arm64: readJsonFile(options.arm64, 'arm64 evidence'),
  });
  writeJsonFile(options.output, result);
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, mode: 'merge', releaseDigest: result.releaseDigest, passed: true })}\n`,
  );
}

module.exports = {
  ARCHITECTURES,
  MAX_EVIDENCE_BYTES,
  NODE_VERSION,
  QingLong3LinuxResourceReleaseEvidenceError,
  TIER_NAMES,
  bundleArchitectureEvidence,
  evidenceDigest,
  mergeCrossArchitectureEvidence,
  normalizeSource,
  parseArguments,
  readJsonFile,
  validateArchitectureEvidence,
  validateTierReport,
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
