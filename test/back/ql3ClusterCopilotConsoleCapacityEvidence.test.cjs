'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const {
  ASSERTION_SEQUENCE,
  LIMITATIONS,
  MEMORY_MAX_BYTES,
  MINIMUM_MEMORY_HEADROOM_BYTES,
  createArchitectureEvidence,
  evidenceDigest,
  mergeCrossArchitectureEvidence,
  normalizeSource,
  readJsonFile,
  validateArchitectureEvidence,
  validateObservation,
  validateReleaseEvidence,
} = require('../../scripts/ql3-cluster-copilot-console-capacity-evidence.cjs');

const root = path.resolve(__dirname, '../..');
const scriptPath = path.join(
  root,
  'scripts/ql3-cluster-copilot-console-capacity-evidence.cjs',
);
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

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

function memoryEvents(overrides = {}) {
  return {
    low: 0,
    high: 0,
    max: 0,
    oom: 0,
    oomKill: 0,
    oomGroupKill: 0,
    ...overrides,
  };
}

function fixtureObservation(architecture, overrides = {}) {
  const peak = 96 * 1024 * 1024;
  return {
    schemaVersion: 1,
    observedAtMs: 1_700_000_000_000,
    platform: 'linux',
    architecture,
    image: {
      architecture: architecture === 'x64' ? 'amd64' : 'arm64',
      id: `sha256:${architecture === 'x64' ? '1' : '2'}`.padEnd(
        71,
        architecture === 'x64' ? '1' : '2',
      ),
      bytes: architecture === 'x64' ? 120_000_000 : 119_000_000,
      user: '10001:10001',
    },
    runtime: { node: 'v24.18.0', uid: 10001, gid: 10001 },
    envelope: {
      memoryMaxBytes: MEMORY_MAX_BYTES,
      memoryPeakBytes: peak,
      memoryHeadroomBytes: MEMORY_MAX_BYTES - peak,
      swapMaxBytes: 0,
      cpuQuotaMicros: 25_000,
      cpuPeriodMicros: 100_000,
      pidsMax: 32,
      pidsCurrent: 5,
      noNewPrivileges: 1,
      seccompMode: 2,
      readOnlyRoot: true,
      tmpfsBytes: 8 * 1024 * 1024,
      publishedHostAddress: '127.0.0.1',
      capabilityDrop: 'ALL',
      memoryEventsBefore: memoryEvents(),
      memoryEventsAfter: memoryEvents(),
    },
    assertionLifecycle: {
      requestCount: 4,
      sequence: [...ASSERTION_SEQUENCE],
      tlsVersion: 'TLSv1.3',
      mutualTls: true,
      consoleRestarted: false,
      mutation: false,
      operation: 'run.cancellation.summary',
      expiredConsoleStatus: 502,
      expiredCode: 'assertion_expired',
    },
    ...overrides,
  };
}

function fixtureArchitecture(architecture, source = fixtureSource()) {
  return createArchitectureEvidence({
    source,
    architecture,
    observation: fixtureObservation(architecture),
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

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function runCli(arguments_, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...arguments_], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('creates exact native reports and a source-bound cross-architecture release report', () => {
  const source = fixtureSource();
  const x64 = fixtureArchitecture('x64', source);
  const arm64 = fixtureArchitecture('arm64', source);
  const release = mergeCrossArchitectureEvidence({ source, x64, arm64 });

  assert.equal(
    x64.fixture,
    'qinglong/cluster-console-capacity-architecture-evidence@v1',
  );
  assert.equal(
    release.fixture,
    'qinglong/cluster-console-capacity-cross-architecture-evidence@v1',
  );
  assert.deepEqual(
    release.architectures.map(({ architecture }) => architecture),
    ['x64', 'arm64'],
  );
  assert.equal(release.gates.releaseEvidenceComplete, true);
  assert.equal(release.gates.passed, true);
  assert.deepEqual(release.assertionLifecycle.sequence, ASSERTION_SEQUENCE);
  assert.deepEqual(release.limitations, LIMITATIONS);
  assert.equal(release.releaseDigest.length, 64);
  assert.notEqual(x64.bundleDigest, arm64.bundleDigest);
  assert.equal(validateReleaseEvidence(release, source), release);
});

test('rejects memory pressure, OOM, swap, PID and widened envelope observations', () => {
  const architecture = 'x64';
  const base = fixtureObservation(architecture);
  const cases = [
    [
      {
        envelope: {
          ...base.envelope,
          memoryPeakBytes: MEMORY_MAX_BYTES - MINIMUM_MEMORY_HEADROOM_BYTES + 1,
          memoryHeadroomBytes: MINIMUM_MEMORY_HEADROOM_BYTES - 1,
        },
      },
      /resource envelope drifted/,
    ],
    [
      {
        envelope: {
          ...base.envelope,
          memoryEventsAfter: memoryEvents({ oomKill: 1 }),
        },
      },
      /memory event oomKill changed/,
    ],
    [
      { envelope: { ...base.envelope, swapMaxBytes: 1024 } },
      /resource envelope drifted/,
    ],
    [
      { envelope: { ...base.envelope, pidsCurrent: 33 } },
      /resource envelope drifted/,
    ],
    [
      { envelope: { ...base.envelope, unexpected: true } },
      /envelope fields are invalid/,
    ],
  ];
  for (const [override, expected] of cases) {
    assert.throws(
      () =>
        validateObservation(
          fixtureObservation(architecture, override),
          architecture,
        ),
      expected,
    );
  }
});

test('rejects assertion lifecycle, native identity and mutation drift', () => {
  const base = fixtureObservation('arm64');
  for (const assertionLifecycle of [
    { ...base.assertionLifecycle, requestCount: 3 },
    {
      ...base.assertionLifecycle,
      sequence: ['initial_accepted', 'expired_rejected'],
    },
    { ...base.assertionLifecycle, tlsVersion: 'TLSv1.2' },
    { ...base.assertionLifecycle, mutualTls: false },
    { ...base.assertionLifecycle, consoleRestarted: true },
    { ...base.assertionLifecycle, mutation: true },
    { ...base.assertionLifecycle, operation: 'run.cancellation.rearm' },
    { ...base.assertionLifecycle, expiredCode: 'assertion_invalid' },
  ]) {
    assert.throws(
      () =>
        validateObservation(
          fixtureObservation('arm64', { assertionLifecycle }),
          'arm64',
        ),
      /assertion lifecycle drifted/,
    );
  }
  assert.throws(
    () => validateObservation(fixtureObservation('arm64'), 'x64'),
    /native identity is invalid/,
  );
});

test('rejects tampering, cross-run mixing and duplicate image identity', () => {
  const source = fixtureSource();
  const x64 = fixtureArchitecture('x64', source);
  const arm64 = fixtureArchitecture('arm64', source);
  assert.throws(
    () =>
      validateArchitectureEvidence(
        { ...x64, bundleDigest: '0'.repeat(64) },
        source,
        'x64',
      ),
    /digest or gates drifted/,
  );
  assert.throws(
    () =>
      mergeCrossArchitectureEvidence({
        source,
        x64,
        arm64: fixtureArchitecture(
          'arm64',
          fixtureSource({ revision: 'b'.repeat(40) }),
        ),
      }),
    /belongs to another source/,
  );

  const duplicateObservation = fixtureObservation('arm64');
  duplicateObservation.image.id = x64.observation.image.id;
  const duplicate = createArchitectureEvidence({
    source,
    architecture: 'arm64',
    observation: duplicateObservation,
  });
  assert.throws(
    () => mergeCrossArchitectureEvidence({ source, x64, arm64: duplicate }),
    /independently measured images/,
  );
});

test('rejects coercible source fields and oversized canonical evidence', () => {
  for (const source of [
    fixtureSource({ repository: 123 }),
    fixtureSource({ revision: 123 }),
    fixtureSource({ runId: 123456 }),
  ]) {
    assert.throws(
      () => normalizeSource(source),
      /source (repository|revision|runId)/,
    );
  }
  assert.throws(
    () => evidenceDigest(Array.from({ length: 100_000 }, () => null)),
    /node budget exceeded/,
  );
});

test('CLI merges, audits and refuses overwrite, symlink and source drift', (t) => {
  const temporaryDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-console-capacity-evidence-')),
  );
  t.after(() =>
    fs.rmSync(temporaryDirectory, { recursive: true, force: true }),
  );
  const source = fixtureSource();
  const x64Path = path.join(temporaryDirectory, 'x64.json');
  const arm64Path = path.join(temporaryDirectory, 'arm64.json');
  const outputPath = path.join(temporaryDirectory, 'cross.json');
  writeJson(x64Path, fixtureArchitecture('x64', source));
  writeJson(arm64Path, fixtureArchitecture('arm64', source));

  const merged = runCli([
    '--mode=merge',
    ...sourceArguments(source),
    `--x64=${x64Path}`,
    `--arm64=${arm64Path}`,
    `--output=${outputPath}`,
  ]);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  const report = readJsonFile(outputPath, 'release evidence');
  validateReleaseEvidence(report, source);

  const audit = runCli([
    '--mode=audit',
    ...sourceArguments(source),
    `--report=${outputPath}`,
  ]);
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).passed, true);

  const overwrite = runCli([
    '--mode=merge',
    ...sourceArguments(source),
    `--x64=${x64Path}`,
    `--arm64=${arm64Path}`,
    `--output=${outputPath}`,
  ]);
  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /output must be a new private file/);

  const drift = runCli([
    '--mode=audit',
    ...sourceArguments(fixtureSource({ revision: 'b'.repeat(40) })),
    `--report=${outputPath}`,
  ]);
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /belongs to another source/);

  const linkPath = path.join(temporaryDirectory, 'report-link.json');
  fs.symlinkSync(outputPath, linkPath);
  const symlink = runCli([
    '--mode=audit',
    ...sourceArguments(source),
    `--report=${linkPath}`,
  ]);
  assert.notEqual(symlink.status, 0);
  assert.match(symlink.stderr, /readable non-symlink file/);
});

test('capture fails closed before Docker without explicit live opt-in', () => {
  const result = runCli([
    '--mode=capture',
    ...sourceArguments(),
    `--architecture=${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
    '--image=qinglong3-cluster-admin:ci-test',
    '--output=/tmp/ql3-console-capacity-should-not-exist.json',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /QL3_CLUSTER_COPILOT_CONSOLE_CAPACITY_LIVE=1 is required/,
  );
});

test('live source freezes native cgroup v2, isolation and assertion rotation mechanics', () => {
  for (const contract of [
    "process.platform !== 'linux' || process.arch !== architecture",
    'process.version !== NODE_VERSION',
    "'--memory',\n      '192m'",
    "'--memory-swap',\n      '192m'",
    "'--cpus',\n      '0.25'",
    "'--pids-limit',\n      String(PIDS_MAX)",
    "'--read-only'",
    "'--cap-drop',\n      'ALL'",
    "'--security-opt',\n      'no-new-privileges'",
    '`127.0.0.1:${port}:${port}/tcp`',
    "memoryPeakBytes: integer('memory.peak')",
    'memoryEvents: { low: events.low',
    "swapMaxBytes: integer('memory.swap.max')",
    'requestCert: true',
    'rejectUnauthorized: true',
    "minVersion: 'TLSv1.3'",
    "fs.renameSync(next, '/authority/assertion.jwt')",
    "operation: 'run.cancellation.summary'",
    'consoleRestarted: false',
    'mutation: false',
    'created.network = true',
    "cleanupDocker(['network', 'rm', network])",
  ]) {
    assert.ok(scriptSource.includes(contract), `missing ${contract}`);
  }
  assert.equal(scriptSource.match(/'--interactive'/g)?.length, 2);
  assert.equal(scriptSource.match(/'--cap-add',\n      'CHOWN'/g)?.length, 2);
  assert.doesNotMatch(scriptSource, /run\.cancellation\.(?:rearm|stop|retry)/);
  assert.doesNotMatch(scriptSource, /--privileged|--network[= ]host/);
});
