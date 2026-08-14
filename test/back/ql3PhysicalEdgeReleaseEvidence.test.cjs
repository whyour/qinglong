const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const {
  buildDirectServiceStartReport,
  normalizeDirectServiceStartManifest,
  normalizeSession,
  parseStartupReceipt,
} = require('../../scripts/ql3-physical-edge-direct-service-start.cjs');
const {
  buildEvidenceReport,
  canonicalDigest,
  normalizeManifest,
  writeNoReplace,
} = require('../../scripts/ql3-physical-edge-evidence.cjs');
const {
  buildFinalReport,
  buildSigningPayload,
  parseArguments,
  validatePhysicalEvidenceReport,
} = require('../../scripts/ql3-physical-edge-release-evidence.cjs');
const {
  runBenchmark: runPluginPackageRecoveryEdgeBenchmark,
} = require('../../scripts/ql3-plugin-package-recovery-edge-benchmark.cjs');

const SCRIPT_PATH = path.resolve(
  __dirname,
  '../../scripts/ql3-physical-edge-release-evidence.cjs',
);
const REPOSITORY = 'https://github.com/whyour/qinglong.git';
const REVISION = 'a'.repeat(40);
const PACKAGES = [
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
    artifactSha256: '1'.repeat(64),
    artifactMetadataSha256: '2'.repeat(64),
    artifactFiles: 627,
    artifactBytes: 5_045_360,
    entrypointSha256: '3'.repeat(64),
    packages: PACKAGES,
  };
}

function directManifest() {
  return normalizeDirectServiceStartManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_direct_service_start_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    serviceManager: 'systemd',
    expectedArchitecture: 'arm64',
    expectedFilesystem: 'ext4',
    expectedArtifactSha256: '1'.repeat(64),
    expectedArtifactFiles: 627,
    expectedArtifactBytes: 5_045_360,
    expectedNodeSha256: '4'.repeat(64),
    maximumBootToActiveMs: 180_000,
    maximumServiceStartBootAgeMs: 60_000,
    maximumServiceStartToActiveMs: 30_000,
  });
}

function physicalManifest() {
  return normalizeManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    deviceModel: 'Example Router A1',
    soc: 'Example SoC',
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
    nodeSha256: '4'.repeat(64),
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
    cpuModel: 'Example CPU',
    cpuCount: 1,
    totalMemoryBytes: 256 * 1024 * 1024,
    observedModel: 'Example Router A1',
    dataPath: '/mnt/ql3-evidence',
    dataFilesystem: 'ext4',
    dataMountOptions: ['rw', 'noatime'],
    dataBytes: 4 * 1024 * 1024 * 1024,
    dataAvailableBytes: 2 * 1024 * 1024 * 1024,
    virtualizationIndicators: [],
  };
}

function edgeWorkloadReport() {
  return {
    schemaVersion: 1,
    profile: 'edge',
    generatedAt: '2026-08-14T08:01:30.000Z',
    host: {
      platform: 'linux',
      architecture: 'arm64',
      node: 'v24.18.0',
      cpuCount: 1,
      totalMemoryBytes: 256 * 1024 * 1024,
    },
    moduleLoad: {
      rssBeforeBytes: 50_000_000,
      rssAfterBytes: 55_000_000,
      rssDeltaBytes: 5_000_000,
    },
    cases: [
      {
        name: 'single_noop',
        durationMs: 15,
        baselineRssBytes: 55_000_000,
        peakRssBytes: 56_000_000,
        peakRssDeltaBytes: 1_000_000,
        outcome: 'succeeded',
        exitCode: 0,
      },
      {
        name: 'stdout_10000_lines',
        durationMs: 45,
        baselineRssBytes: 56_000_000,
        peakRssBytes: 58_000_000,
        peakRssDeltaBytes: 2_000_000,
        outcome: 'succeeded',
        exitCode: 0,
        output: { bytes: 270_000, lines: 10_000, writes: 20 },
      },
    ],
    cancellation: {
      durationMs: 20,
      outcome: 'cancelled',
      termSignalSent: true,
      killSignalSent: false,
    },
    gates: {
      maxRssDeltaMb: 96,
      maxCancelMs: 5000,
      passed: true,
      violations: [],
    },
  };
}

function sqliteWorkloadReport() {
  return {
    node: 'v24.18.0',
    arch: 'arm64',
    platform: 'linux',
    iterations: 250,
    batchSize: 10,
    journalMode: 'delete',
    synchronous: 'full',
    transactionMs: { p50: 0.1, p95: 0.2, p99: 0.3, max: 0.4 },
    maxBatchStallMs: 2,
    rssDeltaMb: 1,
    databaseBytes: 16_384,
    integrityCheck: 'ok',
  };
}

function directSession() {
  const manifest = directManifest();
  const sessionId = '019f0000-0000-4000-8000-000000000030';
  const dataPath = '/mnt/ql3-evidence';
  const deploymentRoot = `${dataPath}/.ql3-direct-service-start-deployment-${sessionId}`;
  const descriptorSource = `${deploymentRoot}/service/qinglong3.service`;
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_direct_service_start_session',
    sessionId,
    manifestDigest: canonicalDigest(manifest),
    uid: 1000,
    preparedAt: '2026-08-14T08:00:00.000Z',
    artifact: artifact(),
    environment: environment('019f0000-0000-4000-8000-000000000001'),
    bridge: {
      actionId: sessionId,
      controllerRoot: '/var/lib/qinglong3-service-bridge',
      intentDigest: '5'.repeat(64),
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
      serviceName: 'qinglong3',
      managerExecutable: '/usr/bin/systemctl',
      managerSha256: '6'.repeat(64),
      enableExecutable: '/usr/bin/systemctl',
      enableSha256: '6'.repeat(64),
      supervisorExecutable: null,
      supervisorSha256: null,
      descriptorSource,
      descriptorDestination: '/etc/systemd/system/qinglong3.service',
      descriptorMode: 0o644,
      descriptorSha256: '7'.repeat(64),
      applicationConfigSha256: '8'.repeat(64),
      installArguments: [
        '-o',
        'root',
        '-g',
        'root',
        '-m',
        '644',
        descriptorSource,
        '/etc/systemd/system/qinglong3.service',
      ],
      enableArguments: ['enable', 'qinglong3'],
    },
  };
  return normalizeSession({ ...body, sha256: canonicalDigest(body) });
}

function startupReceipt() {
  const body = {
    schemaVersion: 1,
    schema: 'qinglong/local-application-startup-receipt@v1',
    instanceId: 'physical-direct-019f0000',
    profile: 'edge',
    aiStatus: 'deployment_excluded',
    bootId: '019f0000-0000-4000-8000-000000000002',
    activeBootAgeMs: 13_250,
    processId: 101,
    processStartTicks: '1200',
    nodeExecutable: '/usr/bin/node',
    nodeVersion: 'v24.18.0',
  };
  const sha256 = crypto
    .createHash('sha256')
    .update('qinglong.local-application-startup-receipt.v1\0', 'utf8')
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
  return parseStartupReceipt(JSON.stringify({ ...body, sha256 }));
}

function directReport() {
  const session = directSession();
  const receipt = startupReceipt();
  const after = environment(receipt.bootId);
  return buildDirectServiceStartReport({
    manifest: directManifest(),
    session,
    observed: {
      after,
      artifact: artifact(),
      bridge: {
        actionId: session.bridge.actionId,
        intentDigest: session.bridge.intentDigest,
        outcomeDigest: '9'.repeat(64),
        observationDigest: 'a'.repeat(64),
        state: 'active',
      },
      process: {
        bootId: after.bootId,
        nodePid: 101,
        nodeParentPid: 1,
        nodeStartTicks: 1200,
        clockTicksPerSecond: 100,
      },
      receipt,
      service: {
        kind: 'systemd',
        serviceName: 'qinglong3',
        managerExecutable: '/usr/bin/systemctl',
        managerSha256: '6'.repeat(64),
        descriptorSha256: '7'.repeat(64),
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
    generatedAt: '2026-08-14T08:01:00.000Z',
  });
}

async function physicalReport() {
  const plugin = await runPluginPackageRecoveryEdgeBenchmark({
    maxDatabaseGrowthBytes: 4 * 1024 * 1024,
    maxDurationMs: 10_000,
    maxRssDeltaBytes: 96 * 1024 * 1024,
  });
  const direct = directReport();
  const observed = physicalObserved(direct.observed.after.bootId);
  return buildEvidenceReport({
    manifest: physicalManifest(),
    observed,
    workloads: [
      {
        name: 'edge-executor',
        report: edgeWorkloadReport(),
      },
      {
        name: 'node-sqlite-on-device-storage',
        report: sqliteWorkloadReport(),
      },
      {
        name: 'plugin-package-failed-upgrade',
        report: {
          ...plugin,
          identity: {
            ...plugin.identity,
            platform: 'linux',
            architecture: 'arm64',
          },
        },
      },
    ],
    supplementalEvidence: [direct],
    generatedAt: '2026-08-14T08:02:00.000Z',
  });
}

function writeFile(filePath, contents, mode) {
  fs.writeFileSync(filePath, contents, { mode });
  fs.chmodSync(filePath, mode);
}

test('requires exact phase-specific source and authority inputs', () => {
  assert.equal(
    parseArguments([
      'prepare',
      '--physical-report=/tmp/physical.json',
      '--release-archive=/tmp/release.tar.gz',
      `--repository=${REPOSITORY}`,
      `--revision=${REVISION}`,
      '--payload=/tmp/payload.json',
    ]).phase,
    'prepare',
  );
  assert.equal(
    parseArguments([
      'finalize',
      '--physical-report=/tmp/physical.json',
      '--release-archive=/tmp/release.tar.gz',
      '--payload=/tmp/payload.json',
      '--signature=/tmp/payload.sig',
      '--trusted-public-key=/tmp/release.pub',
      `--expected-repository=${REPOSITORY}`,
      `--expected-revision=${REVISION}`,
      '--output=/tmp/release-evidence.json',
    ]).phase,
    'finalize',
  );
  assert.throws(
    () =>
      parseArguments([
        'prepare',
        '--physical-report=physical.json',
        '--release-archive=/tmp/release.tar.gz',
        `--repository=${REPOSITORY}`,
        `--revision=${REVISION}`,
        '--payload=/tmp/payload.json',
      ]),
    /physicalReportPath must be absolute/,
  );
});

test('reconstructs a passed physical report and retains unsupported status', async () => {
  const report = await physicalReport();
  assert.equal(report.qualification.physicalCandidate, true);
  assert.deepEqual(validatePhysicalEvidenceReport(report), []);
  const minimalForgery = buildEvidenceReport({
    manifest: report.manifest,
    observed: report.observed,
    workloads: [
      {
        name: 'edge-executor',
        report: {
          schemaVersion: 1,
          profile: 'edge',
          host: {
            platform: 'linux',
            architecture: 'arm64',
          },
          gates: { passed: true, violations: [] },
        },
      },
      report.workloads[1],
      report.workloads[2],
    ],
    supplementalEvidence: report.supplementalEvidence,
    generatedAt: report.generatedAt,
  });
  assert.equal(minimalForgery.qualification.physicalCandidate, true);
  assert.match(
    validatePhysicalEvidenceReport(minimalForgery).join('; '),
    /not an exact recorder result/,
  );
  const withoutDirect = buildEvidenceReport({
    manifest: report.manifest,
    observed: report.observed,
    workloads: report.workloads,
    generatedAt: report.generatedAt,
  });
  assert.match(
    validatePhysicalEvidenceReport(withoutDirect).join('; '),
    /direct release service start evidence is required/,
  );
  const payload = buildSigningPayload({
    physicalReport: report,
    releaseArchive: { sha256: 'b'.repeat(64), bytes: 1024 },
    repository: REPOSITORY,
    revision: REVISION,
    signedAt: '2026-08-14T08:03:00.000Z',
  });
  const final = buildFinalReport({
    physicalReport: report,
    payload,
    signature: Buffer.alloc(64, 1),
    fingerprint: 'c'.repeat(64),
  });
  assert.equal(final.supported, false);
  assert.equal(
    final.qualification.remainingRequiredEvidence.includes(
      'release_archive_signature',
    ),
    false,
  );
  assert.ok(
    final.qualification.remainingRequiredEvidence.includes(
      'power_loss_restart',
    ),
  );
});

test('prepares and verifies one externally signed release binding', async (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-release-evidence-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = {
    physical: path.join(directory, 'physical.json'),
    archive: path.join(directory, 'release.tar.gz'),
    payload: path.join(directory, 'payload.json'),
    signature: path.join(directory, 'payload.sig'),
    publicKey: path.join(directory, 'release.pub'),
    output: path.join(directory, 'release-evidence.json'),
    mismatchOutput: path.join(directory, 'mismatch-evidence.json'),
    tamperedOutput: path.join(directory, 'tampered-evidence.json'),
  };
  writeNoReplace(
    paths.physical,
    `${JSON.stringify(await physicalReport(), null, 2)}\n`,
  );
  writeFile(paths.archive, Buffer.from('bounded release archive'), 0o444);

  const prepared = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      'prepare',
      `--physical-report=${paths.physical}`,
      `--release-archive=${paths.archive}`,
      `--repository=${REPOSITORY}`,
      `--revision=${REVISION}`,
      `--payload=${paths.payload}`,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(fs.statSync(paths.payload).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(paths.payload, 'utf8').endsWith('\n'), false);

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signature = crypto.sign(
    null,
    fs.readFileSync(paths.payload),
    privateKey,
  );
  writeFile(paths.signature, signature, 0o600);
  writeFile(
    paths.publicKey,
    publicKey.export({ type: 'spki', format: 'pem' }),
    0o444,
  );
  const finalized = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      'finalize',
      `--physical-report=${paths.physical}`,
      `--release-archive=${paths.archive}`,
      `--payload=${paths.payload}`,
      `--signature=${paths.signature}`,
      `--trusted-public-key=${paths.publicKey}`,
      `--expected-repository=${REPOSITORY}`,
      `--expected-revision=${REVISION}`,
      `--output=${paths.output}`,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(finalized.status, 0, finalized.stderr);
  const report = JSON.parse(fs.readFileSync(paths.output, 'utf8'));
  assert.equal(report.supported, false);
  assert.equal(report.qualification.passed, true);
  assert.equal(report.payload.release.archiveBytes, 23);
  assert.ok(
    report.qualification.collectedEvidence.includes(
      'release_archive_signature_or_attestation',
    ),
  );
  assert.match(report.trust.publicKeyFingerprintSha256, /^[a-f0-9]{64}$/);

  const sourceMismatch = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      'finalize',
      `--physical-report=${paths.physical}`,
      `--release-archive=${paths.archive}`,
      `--payload=${paths.payload}`,
      `--signature=${paths.signature}`,
      `--trusted-public-key=${paths.publicKey}`,
      `--expected-repository=${REPOSITORY}`,
      `--expected-revision=${'b'.repeat(40)}`,
      `--output=${paths.mismatchOutput}`,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(sourceMismatch.status, 0);
  assert.match(sourceMismatch.stderr, /payload did not match/);
  assert.equal(fs.existsSync(paths.mismatchOutput), false);

  const noReplace = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      'finalize',
      `--physical-report=${paths.physical}`,
      `--release-archive=${paths.archive}`,
      `--payload=${paths.payload}`,
      `--signature=${paths.signature}`,
      `--trusted-public-key=${paths.publicKey}`,
      `--expected-repository=${REPOSITORY}`,
      `--expected-revision=${REVISION}`,
      `--output=${paths.output}`,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(noReplace.status, 0);
  assert.match(noReplace.stderr, /EEXIST/);

  fs.chmodSync(paths.archive, 0o644);
  fs.appendFileSync(paths.archive, 'tampered');
  fs.chmodSync(paths.archive, 0o444);
  const tampered = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      'finalize',
      `--physical-report=${paths.physical}`,
      `--release-archive=${paths.archive}`,
      `--payload=${paths.payload}`,
      `--signature=${paths.signature}`,
      `--trusted-public-key=${paths.publicKey}`,
      `--expected-repository=${REPOSITORY}`,
      `--expected-revision=${REVISION}`,
      `--output=${paths.tamperedOutput}`,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /payload did not match/);
  assert.equal(fs.existsSync(paths.tamperedOutput), false);
});
