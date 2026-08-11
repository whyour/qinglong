const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');

const {
  buildDirectServiceStartReport,
  normalizeDirectServiceStartManifest,
  normalizeSession,
  parseArguments,
  parseAuxiliaryVectorClockTicks,
  parseOpenRcDirectState,
  parseStartupReceipt,
  parseSystemdDirectShow,
  processStartBootAgeMs,
  readLinuxClockTicksPerSecond,
  validateDirectServiceStartReport,
} = require('../../scripts/ql3-physical-edge-direct-service-start.cjs');
const {
  buildEvidenceReport,
  canonicalDigest,
  normalizeManifest,
  parseArguments: parseEvidenceArguments,
  validateDirectServiceStartEvidenceReport,
} = require('../../scripts/ql3-physical-edge-evidence.cjs');

const packages = [
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
];

function artifact() {
  return {
    artifactSha256: 'a'.repeat(64),
    artifactMetadataSha256: 'b'.repeat(64),
    artifactFiles: 627,
    artifactBytes: 5_045_360,
    entrypointSha256: 'c'.repeat(64),
    packages,
  };
}

function manifest(overrides = {}) {
  return normalizeDirectServiceStartManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_direct_service_start_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    serviceManager: 'systemd',
    expectedArchitecture: 'arm64',
    expectedFilesystem: 'ext4',
    expectedArtifactSha256: 'a'.repeat(64),
    expectedArtifactFiles: 627,
    expectedArtifactBytes: 5_045_360,
    expectedNodeSha256: 'd'.repeat(64),
    maximumBootToActiveMs: 180_000,
    maximumServiceStartBootAgeMs: 60_000,
    maximumServiceStartToActiveMs: 30_000,
    ...overrides,
  });
}

function baseManifest() {
  return normalizeManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    deviceModel: 'router-a1-model',
    soc: 'arm-soc',
    storageMedium: 'emmc',
    expectedArchitecture: 'arm64',
    memoryBytes: {
      minimum: 128 * 1024 * 1024,
      maximum: 512 * 1024 * 1024,
    },
    expectedFilesystem: 'ext4',
  });
}

function environment(bootId) {
  return {
    platform: 'linux',
    architecture: 'arm64',
    bootId,
    bootAgeMs: 15_000,
    dataFilesystem: 'ext4',
    nodeExecutable: '/usr/bin/node',
    nodeSha256: 'd'.repeat(64),
    nodeVersion: 'v24.18.0',
    virtualizationIndicators: [],
  };
}

function physicalObserved(bootId) {
  return {
    platform: 'linux',
    architecture: 'arm64',
    node: 'v24.18.0',
    bootId,
    kernel: '6.6.0',
    distribution: { id: 'openwrt', versionId: '24.10' },
    libc: 'musl-ld-musl-aarch64.so.1',
    cpuModel: 'test-cpu',
    cpuCount: 1,
    totalMemoryBytes: 256 * 1024 * 1024,
    observedModel: 'router-a1-model',
    dataPath: '/mnt/ql3-evidence',
    dataFilesystem: 'ext4',
    dataMountOptions: ['rw', 'noatime'],
    dataBytes: 4 * 1024 * 1024 * 1024,
    dataAvailableBytes: 2 * 1024 * 1024 * 1024,
    virtualizationIndicators: [],
  };
}

function sessionFixture() {
  const sessionId = '019f0000-0000-4000-8000-000000000030';
  const dataPath = '/mnt/ql3-evidence';
  const deploymentRoot = `${dataPath}/.ql3-direct-service-start-deployment-${sessionId}`;
  const serviceName = 'qinglong3';
  const descriptorSource = `${deploymentRoot}/service/qinglong3.service`;
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_direct_service_start_session',
    sessionId,
    manifestDigest: canonicalDigest(manifest()),
    uid: 1000,
    preparedAt: '2026-07-29T08:00:00.000Z',
    artifact: artifact(),
    environment: environment('019f0000-0000-4000-8000-000000000001'),
    bridge: {
      actionId: sessionId,
      controllerRoot: '/var/lib/qinglong3-service-bridge',
      intentDigest: '9'.repeat(64),
      intentPath: `${deploymentRoot}/service/service-manager-intents/${sessionId}.json`,
      outcomePath: `${deploymentRoot}/service/service-manager-outcomes/${sessionId}.json`,
    },
    paths: {
      dataPath,
      deploymentRoot,
      artifactRoot: '/opt/qinglong3-release',
      applicationEntrypoint:
        '/opt/qinglong3-release/node_modules/@qinglong/local-application/dist/cli.js',
      applicationConfig: `${deploymentRoot}/local-application.json`,
      startupReceipt: `${deploymentRoot}/local-application.json.active.json`,
    },
    service: {
      kind: 'systemd',
      serviceName,
      managerExecutable: '/usr/bin/systemctl',
      managerSha256: 'e'.repeat(64),
      enableExecutable: '/usr/bin/systemctl',
      enableSha256: 'e'.repeat(64),
      supervisorExecutable: null,
      supervisorSha256: null,
      descriptorSource,
      descriptorDestination: `/etc/systemd/system/${serviceName}.service`,
      descriptorMode: 0o644,
      descriptorSha256: 'f'.repeat(64),
      applicationConfigSha256: '8'.repeat(64),
      installArguments: [
        '-o',
        'root',
        '-g',
        'root',
        '-m',
        '644',
        descriptorSource,
        `/etc/systemd/system/${serviceName}.service`,
      ],
      enableArguments: ['enable', serviceName],
    },
  };
  return normalizeSession({ ...body, sha256: canonicalDigest(body) });
}

function receipt(session, overrides = {}) {
  const body = {
    schemaVersion: 1,
    schema: 'qinglong/local-application-startup-receipt@v1',
    instanceId: `physical-direct-${session.sessionId.slice(0, 8)}`,
    profile: 'edge',
    aiStatus: 'deployment_excluded',
    bootId: '019f0000-0000-4000-8000-000000000002',
    activeBootAgeMs: 13_250,
    processId: 101,
    processStartTicks: '1200',
    nodeExecutable: '/usr/bin/node',
    nodeVersion: 'v24.18.0',
    ...overrides,
  };
  const sha256 = crypto
    .createHash('sha256')
    .update('qinglong.local-application-startup-receipt.v1\0', 'utf8')
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
  return parseStartupReceipt(JSON.stringify({ ...body, sha256 }));
}

function reportFixture(overrides = {}) {
  const session = sessionFixture();
  const activeReceipt = receipt(session);
  const after = environment(activeReceipt.bootId);
  return buildDirectServiceStartReport({
    manifest: manifest(),
    session,
    observed: {
      after,
      artifact: artifact(),
      bridge: {
        actionId: session.bridge.actionId,
        intentDigest: session.bridge.intentDigest,
        outcomeDigest: '1'.repeat(64),
        observationDigest: '2'.repeat(64),
        state: 'active',
      },
      process: {
        bootId: after.bootId,
        nodePid: 101,
        nodeParentPid: 1,
        nodeStartTicks: 1200,
        clockTicksPerSecond: 100,
      },
      receipt: activeReceipt,
      service: {
        kind: 'systemd',
        serviceName: session.service.serviceName,
        managerExecutable: '/usr/bin/systemctl',
        managerSha256: 'e'.repeat(64),
        descriptorSha256: 'f'.repeat(64),
        mainPid: 101,
        mainStartMonotonicUs: 12_000_000,
      },
    },
    measurements: {
      serviceStartBootAgeMs: 12_000,
      activeBootAgeMs: 13_250,
      bootToActiveMs: 13_250,
      serviceStartToActiveMs: 1_250,
    },
    outcomes: {
      aiStatus: 'deployment_excluded',
      descriptorInstalled: true,
      initSupervisionMatched: true,
      managerStartMonotonicMatched: true,
      nodeProcessIdentityMatched: true,
      ownerBridgeOutcomeVerified: true,
      serviceActive: true,
      serviceEnabled: true,
      startupReceiptValidated: true,
    },
    generatedAt: '2026-07-29T08:01:00.000Z',
    ...overrides,
  });
}

test('normalizes direct systemd and OpenRC measurement budgets', () => {
  assert.equal(manifest().serviceManager, 'systemd');
  assert.equal(manifest({ serviceManager: 'openrc' }).serviceManager, 'openrc');
  assert.throws(
    () => manifest({ maximumServiceStartToActiveMs: 120_001 }),
    /measurement budget/,
  );
});

test('requires phase-specific canonical authority inputs', () => {
  assert.deepEqual(
    parseArguments([
      'inspect',
      '--artifact-root=/opt/qinglong3-release',
      '--json',
    ]),
    {
      phase: 'inspect',
      artifactRoot: '/opt/qinglong3-release',
      json: true,
    },
  );
  assert.equal(
    parseArguments([
      'prepare',
      '--manifest=/mnt/data/manifest.json',
      '--data-path=/mnt/data',
      '--artifact-root=/opt/qinglong3-release',
      '--session=/mnt/data/session.json',
      '--root-command-output=/mnt/data/start-root-command.json',
    ]).phase,
    'prepare',
  );
  assert.equal(
    parseArguments([
      'prepare',
      '--manifest=/mnt/data/manifest.json',
      '--data-path=/mnt/data',
      '--artifact-root=/opt/qinglong3-release',
      '--session=/mnt/data/session.json',
      '--root-command-output=/mnt/data/start-root-command.json',
    ]).rootCommandOutputPath,
    '/mnt/data/start-root-command.json',
  );
  assert.throws(
    () =>
      parseArguments([
        'resume',
        '--manifest=/mnt/data/manifest.json',
        '--session=/mnt/data/session.json',
        '--output=/mnt/data/report.json',
        '--root-command-output=/mnt/data/start-root-command.json',
      ]),
    /phase resume received an invalid option/,
  );
  assert.throws(
    () =>
      parseArguments([
        'resume',
        '--manifest=manifest.json',
        '--session=/mnt/data/session.json',
        '--output=/mnt/data/report.json',
      ]),
    /manifestPath must be absolute/,
  );
});

test('parses init manager state and monotonic process clocks', () => {
  assert.deepEqual(
    parseSystemdDirectShow(
      [
        'LoadState=loaded',
        'ActiveState=active',
        'SubState=running',
        'UnitFileState=enabled',
        'FragmentPath=/etc/systemd/system/qinglong3.service',
        'MainPID=101',
        'ExecMainStartTimestampMonotonic=12000000',
      ].join('\n'),
    ),
    {
      active: true,
      enabled: true,
      fragmentPath: '/etc/systemd/system/qinglong3.service',
      mainPid: 101,
      mainStartMonotonicUs: 12_000_000,
    },
  );
  assert.deepEqual(
    parseOpenRcDirectState(0, ' qinglong3 | default', 'qinglong3'),
    { active: true, enabled: true },
  );
  const auxiliaryVector = Buffer.alloc(32);
  auxiliaryVector.writeBigUInt64LE(17n, 0);
  auxiliaryVector.writeBigUInt64LE(100n, 8);
  assert.equal(parseAuxiliaryVectorClockTicks(auxiliaryVector, 8, 'LE'), 100);
  assert.equal(processStartBootAgeMs('1200', 100), 12_000);
  assert.throws(
    () => parseAuxiliaryVectorClockTicks(Buffer.alloc(16), 8, 'LE'),
    /AT_CLKTCK/,
  );
});

test(
  'reads AT_CLKTCK without an external utility on Linux',
  { skip: process.platform !== 'linux' },
  () => {
    const value = readLinuxClockTicksPerSecond();
    assert.equal(Number.isSafeInteger(value), true);
    assert.ok(value >= 10 && value <= 10_000);
  },
);

test('binds the startup receipt and direct deployment session digests', () => {
  const session = sessionFixture();
  const activeReceipt = receipt(session);
  assert.equal(activeReceipt.processId, 101);
  assert.equal(
    activeReceipt.instanceId,
    `physical-direct-${session.sessionId.slice(0, 8)}`,
  );
  assert.throws(
    () =>
      parseStartupReceipt(
        JSON.stringify({ ...activeReceipt, activeBootAgeMs: 13_251 }),
      ),
    /values or digest/,
  );
});

test('recomputes a passing direct release report without widening', () => {
  const report = reportFixture();
  assert.equal(report.qualification.passed, true);
  assert.deepEqual(
    validateDirectServiceStartReport(
      report,
      manifest(),
      environment(report.observed.after.bootId),
    ),
    [],
  );
  const widened = {
    ...report,
    qualification: {
      ...report.qualification,
      doesNotProve: [],
    },
  };
  const body = { ...widened };
  delete body.sha256;
  assert.notDeepEqual(
    validateDirectServiceStartReport(
      { ...body, sha256: canonicalDigest(body) },
      manifest(),
      environment(report.observed.after.bootId),
    ),
    [],
  );
});

test('fails qualification when direct process or service facts drift', () => {
  const report = reportFixture({
    outcomes: {
      aiStatus: 'deployment_excluded',
      descriptorInstalled: true,
      initSupervisionMatched: false,
      managerStartMonotonicMatched: true,
      nodeProcessIdentityMatched: true,
      ownerBridgeOutcomeVerified: true,
      serviceActive: true,
      serviceEnabled: true,
      startupReceiptValidated: true,
    },
  });
  assert.equal(report.qualification.passed, false);
  assert.match(
    report.qualification.violations.join('; '),
    /manager or application outcome/,
  );
});

test('fails qualification when Owner service bridge evidence drifts', () => {
  const baseline = reportFixture();
  const report = reportFixture({
    observed: {
      ...baseline.observed,
      bridge: {
        ...baseline.observed.bridge,
        intentDigest: '7'.repeat(64),
      },
    },
  });
  assert.equal(report.qualification.passed, false);
  assert.match(
    report.qualification.violations.join('; '),
    /service bridge outcome binding/,
  );
});

test('imports direct service evidence and removes only the wrapper gap', () => {
  const report = reportFixture();
  const current = environment(report.observed.after.bootId);
  assert.deepEqual(
    validateDirectServiceStartEvidenceReport(report, baseManifest(), current),
    [],
  );
  assert.equal(
    parseEvidenceArguments([
      '--manifest=/mnt/data/manifest.json',
      '--data-path=/mnt/data',
      '--direct-service-start-evidence=/mnt/data/direct.json',
    ]).directServiceStartEvidencePath,
    '/mnt/data/direct.json',
  );
  const aggregated = buildEvidenceReport({
    manifest: baseManifest(),
    observed: physicalObserved(report.observed.after.bootId),
    workloads: [],
    supplementalEvidence: [report],
    generatedAt: '2026-07-29T08:02:00.000Z',
  });
  assert.ok(
    aggregated.qualification.collectedEvidence.includes(
      'kernel_boot_to_direct_init_managed_release_application_active',
    ),
  );
  assert.equal(
    aggregated.qualification.remainingRequiredEvidence.includes(
      'direct_release_unit_without_evidence_wrapper',
    ),
    false,
  );
  assert.equal(
    aggregated.qualification.remainingRequiredEvidence.includes(
      'firmware_and_bootloader_power_on_to_linux_kernel_clock',
    ),
    true,
  );
});

test('rejects a forged inner receipt even with a recomputed outer report', () => {
  const report = reportFixture();
  const body = {
    ...report,
    observed: {
      ...report.observed,
      receipt: {
        ...report.observed.receipt,
        activeBootAgeMs: report.observed.receipt.activeBootAgeMs + 1,
      },
    },
  };
  delete body.sha256;
  const forged = { ...body, sha256: canonicalDigest(body) };
  assert.notDeepEqual(
    validateDirectServiceStartReport(
      forged,
      manifest(),
      environment(report.observed.after.bootId),
    ),
    [],
  );
});
