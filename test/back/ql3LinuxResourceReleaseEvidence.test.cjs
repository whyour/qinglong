const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const {
  RESOURCE_TIERS,
  createWorkloadPlans,
} = require('../../scripts/ql3-linux-resource-gate.cjs');
const {
  TIER_NAMES,
  bundleArchitectureEvidence,
  evidenceDigest,
  mergeCrossArchitectureEvidence,
  normalizeSource,
  readJsonFile,
  validateArchitectureEvidence,
} = require('../../scripts/ql3-linux-resource-release-evidence.cjs');

const scriptPath = path.resolve(
  __dirname,
  '../../scripts/ql3-linux-resource-release-evidence.cjs',
);

function fixtureSource(overrides = {}) {
  return {
    repository: 'whyour/qinglong',
    revision: 'a'.repeat(40),
    workflow: 'QingLong 3.0 CI',
    runId: '123456',
    runAttempt: 1,
    ...overrides,
  };
}

function fixtureTierReport(tierName, architecture) {
  const tier = RESOURCE_TIERS[tierName];
  return {
    schemaVersion: 1,
    tier: tierName,
    evidenceClass: tier.evidenceClass,
    supportedMinimum: tier.supportedMinimum,
    identity: {
      platform: 'linux',
      architecture,
      node: 'v24.18.0',
      uid: 65532,
      gid: 65532,
    },
    envelope: {
      memoryMaxBytes: tier.memoryMaxBytes,
      memoryPeakBytes: Math.min(64 * 1024 * 1024, tier.memoryMaxBytes),
      swapMaxBytes: tier.swapMaxBytes,
      cpuQuotaCores: tier.cpuQuotaCores,
      pidsMax: tier.pidsMax,
      noNewPrivileges: 1,
      seccompMode: 2,
      rootReadOnly: true,
      workspaceReadOnly: true,
      tmpWritable: true,
      memoryEventsBefore: {
        low: 0,
        high: 0,
        max: 0,
        oom: 0,
        oom_kill: 0,
        oom_group_kill: 0,
      },
      memoryEventsAfter: {
        low: 0,
        high: 0,
        max: 0,
        oom: 0,
        oom_kill: 0,
        oom_group_kill: 0,
      },
    },
    workloads: createWorkloadPlans('/workspace', tierName).map(({ name }) => ({
      name,
      report: { passed: true },
    })),
    gates: { passed: true, violations: [] },
  };
}

function fixtureReports(architecture) {
  return Object.fromEntries(
    TIER_NAMES.map((tierName) => [
      tierName,
      fixtureTierReport(tierName, architecture),
    ]),
  );
}

function fixtureBundle(architecture, source = fixtureSource()) {
  return bundleArchitectureEvidence({
    source,
    architecture,
    reports: fixtureReports(architecture),
  });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function runCli(arguments_) {
  return spawnSync(process.execPath, [scriptPath, ...arguments_], {
    encoding: 'utf8',
  });
}

function sourceArguments(source = fixtureSource()) {
  return [
    `--repository=${source.repository}`,
    `--revision=${source.revision}`,
    `--workflow=${source.workflow}`,
    `--run-id=${source.runId}`,
    `--run-attempt=${source.runAttempt}`,
  ];
}

test('bundles native x64 and arm64 reports into source-bound release evidence', () => {
  const source = fixtureSource();
  const x64 = fixtureBundle('x64', source);
  const arm64 = fixtureBundle('arm64', source);
  const release = mergeCrossArchitectureEvidence({ source, x64, arm64 });

  assert.equal(
    release.fixture,
    'qinglong/linux-resource-cross-architecture-evidence@v1',
  );
  assert.deepEqual(
    release.architectures.map(({ architecture }) => architecture),
    ['x64', 'arm64'],
  );
  assert.equal(release.architectures[0].tiers.length, 3);
  assert.equal(release.architectures[1].tiers.length, 3);
  assert.equal(release.gates.passed, true);
  assert.equal(release.releaseDigest.length, 64);
  assert.notEqual(x64.bundleDigest, arm64.bundleDigest);
  assert.deepEqual(release.limitations, [
    'CI cgroup evidence is not a supported minimum hardware claim',
    'CI evidence does not replace fixed-device power-loss, flash, thermal, or soak evidence',
    'GitHub workflow identity binding is not a cryptographic hardware attestation',
  ]);
});

test('rejects architecture, gate, memory event and schema drift', () => {
  const source = fixtureSource();
  const wrongArchitecture = fixtureReports('x64');
  wrongArchitecture['router-stress-ci'].identity.architecture = 'arm64';
  assert.throws(
    () =>
      bundleArchitectureEvidence({
        source,
        architecture: 'x64',
        reports: wrongArchitecture,
      }),
    /reviewed native identity/,
  );

  const failedGate = fixtureReports('x64');
  failedGate['edge-release-ci'].gates = {
    passed: false,
    violations: ['benchmark failed'],
  };
  assert.throws(
    () =>
      bundleArchitectureEvidence({
        source,
        architecture: 'x64',
        reports: failedGate,
      }),
    /gate did not pass/,
  );

  const memoryEvent = fixtureReports('x64');
  memoryEvent['cluster-control-ci'].envelope.memoryEventsAfter.oom_kill = 1;
  assert.throws(
    () =>
      bundleArchitectureEvidence({
        source,
        architecture: 'x64',
        reports: memoryEvent,
      }),
    /memory event oom_kill changed/,
  );

  const widened = fixtureReports('x64');
  widened['router-stress-ci'].unexpected = true;
  assert.throws(
    () =>
      bundleArchitectureEvidence({
        source,
        architecture: 'x64',
        reports: widened,
      }),
    /report fields are invalid/,
  );
});

test('rejects source identifiers that only coerce to the reviewed text shape', () => {
  for (const source of [
    fixtureSource({ repository: 123 }),
    fixtureSource({ revision: 123 }),
    fixtureSource({ runId: 123456 }),
  ]) {
    assert.throws(() => normalizeSource(source), /source (repository|revision|runId)/);
  }
});

test('rejects tampered bundles, cross-source mixing and duplicate architecture', () => {
  const source = fixtureSource();
  const x64 = fixtureBundle('x64', source);
  const arm64 = fixtureBundle('arm64', source);
  const tamperedX64 = { ...x64, bundleDigest: '0'.repeat(64) };
  assert.throws(
    () => validateArchitectureEvidence(tamperedX64, source, 'x64'),
    /digest or gates drifted/,
  );

  const otherSource = fixtureSource({ revision: 'b'.repeat(40) });
  assert.throws(
    () =>
      mergeCrossArchitectureEvidence({
        source,
        x64,
        arm64: fixtureBundle('arm64', otherSource),
      }),
    /belongs to another source/,
  );
  assert.throws(
    () => mergeCrossArchitectureEvidence({ source, x64, arm64: x64 }),
    /arm64 architecture evidence digest or gates drifted/,
  );
  assert.throws(
    () => mergeCrossArchitectureEvidence({ source, x64, arm64: undefined }),
    /plain object/,
  );
});

test('enforces a shared canonical node budget across sibling branches', () => {
  assert.throws(
    () => evidenceDigest(Array.from({ length: 100_000 }, () => null)),
    /node budget exceeded/,
  );
});

test('CLI creates non-overwriting native bundles and merged evidence', (t) => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-linux-resource-release-evidence-'),
  );
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const source = fixtureSource();

  const bundlePaths = {};
  for (const architecture of ['x64', 'arm64']) {
    const reports = fixtureReports(architecture);
    const reportArguments = [];
    for (const tierName of TIER_NAMES) {
      const reportPath = path.join(
        temporaryDirectory,
        `${architecture}-${tierName}.json`,
      );
      writeJson(reportPath, reports[tierName]);
      reportArguments.push(`--${tierName}=${reportPath}`);
    }
    bundlePaths[architecture] = path.join(
      temporaryDirectory,
      `${architecture}.json`,
    );
    const result = runCli([
      '--mode=bundle',
      ...sourceArguments(source),
      `--architecture=${architecture}`,
      ...reportArguments,
      `--output=${bundlePaths[architecture]}`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, true);
    validateArchitectureEvidence(
      JSON.parse(fs.readFileSync(bundlePaths[architecture], 'utf8')),
      source,
      architecture,
    );
  }

  const releasePath = path.join(temporaryDirectory, 'release.json');
  const merge = runCli([
    '--mode=merge',
    ...sourceArguments(source),
    `--x64=${bundlePaths.x64}`,
    `--arm64=${bundlePaths.arm64}`,
    `--output=${releasePath}`,
  ]);
  assert.equal(merge.status, 0, merge.stderr);
  assert.equal(JSON.parse(merge.stdout).passed, true);
  assert.equal(
    JSON.parse(fs.readFileSync(releasePath, 'utf8')).releaseDigest.length,
    64,
  );

  const overwrite = runCli([
    '--mode=merge',
    ...sourceArguments(source),
    `--x64=${bundlePaths.x64}`,
    `--arm64=${bundlePaths.arm64}`,
    `--output=${releasePath}`,
  ]);
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /EEXIST/);
});

test('rejects symlink evidence inputs', (t) => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-linux-resource-symlink-'),
  );
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const target = path.join(temporaryDirectory, 'target.json');
  const link = path.join(temporaryDirectory, 'link.json');
  writeJson(target, { passed: true });
  fs.symlinkSync(target, link);
  assert.throws(() => readJsonFile(link, 'evidence'), /non-symlink file/);
});
