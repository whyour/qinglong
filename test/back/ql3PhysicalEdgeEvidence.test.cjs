const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  assertPrivateEvidenceFile,
  buildEvidenceReport,
  mountForPath,
  normalizeManifest,
  parseArguments,
  parseMountTable,
  parseOsRelease,
  readFaultEvidence,
  readIdleEvidence,
  readAdoptionScaleEvidence,
  readApplicationStartEvidence,
  readComposeStorageEvidence,
  validateAdoptionScaleEvidenceReport,
  validateApplicationStartEvidenceReport,
  validateComposeStorageEvidenceReport,
  validateFaultEvidenceReport,
  validateIdleEvidenceReport,
  validateObservedPlatform,
  writeNoReplace,
} = require('../../scripts/ql3-physical-edge-evidence.cjs');
const {
  buildReport: buildAdoptionScaleReport,
  normalizeManifest: normalizeAdoptionScaleManifest,
} = require('../../scripts/ql3-physical-edge-adoption-scale.cjs');
const {
  buildComposeStorageReport,
  normalizeComposeStorageManifest,
} = require('../../scripts/ql3-physical-edge-compose-storage.cjs');
const {
  buildApplicationStartReport,
  normalizeApplicationStartManifest,
} = require('../../scripts/ql3-physical-edge-application-start.cjs');

test('rejects relative fault evidence paths and foreign-owned reports', () => {
  assert.throws(
    () =>
      parseArguments([
        '--manifest=/etc/ql3/device.json',
        '--data-path=/data',
        '--fault-evidence=relative.json',
      ]),
    /faultEvidencePath must be absolute/,
  );
  const effectiveUserId = process.geteuid();
  const privateFile = {
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o100600,
    uid: effectiveUserId,
  };
  assert.doesNotThrow(() =>
    assertPrivateEvidenceFile(privateFile, 'supplemental evidence'),
  );
  assert.throws(
    () =>
      assertPrivateEvidenceFile(
        { ...privateFile, uid: effectiveUserId + 1 },
        'supplemental evidence',
      ),
    /current-user-owned private regular file/,
  );
});

function manifest(overrides = {}) {
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
      minimum: 240 * 1024 * 1024,
      maximum: 320 * 1024 * 1024,
    },
    expectedFilesystem: 'ext4',
    ...overrides,
  });
}

function observed(overrides = {}) {
  return {
    platform: 'linux',
    architecture: 'arm64',
    node: 'v24.18.0',
    bootId: '019f0000-0000-7000-8000-000000000001',
    kernel: '6.6.0',
    distribution: { id: 'openwrt', versionId: '24.10' },
    libc: 'musl-ld-musl-aarch64.so.1',
    cpuModel: 'Example CPU',
    cpuCount: 1,
    totalMemoryBytes: 256 * 1024 * 1024,
    observedModel: 'Example Router A1',
    dataPath: '/opt/qinglong/data',
    dataFilesystem: 'ext4',
    dataMountOptions: ['rw', 'noatime'],
    dataBytes: 4 * 1024 * 1024 * 1024,
    dataAvailableBytes: 2 * 1024 * 1024 * 1024,
    virtualizationIndicators: [],
    ...overrides,
  };
}

test('accepts one exact physical Edge device manifest', () => {
  const value = manifest();
  assert.equal(value.deviceId, 'router-a1');
  assert.equal(value.profile, 'edge');
  assert.equal(value.memoryBytes.minimum, 240 * 1024 * 1024);
});

test('rejects widened, virtual and under-specified manifests', () => {
  assert.throws(
    () => manifest({ extra: true }),
    /manifest keys must be exactly/,
  );
  assert.throws(
    () => manifest({ storageMedium: 'virtual' }),
    /storageMedium must be one of/,
  );
  assert.throws(
    () =>
      manifest({
        memoryBytes: { minimum: 64 * 1024 * 1024, maximum: 128 * 1024 * 1024 },
      }),
    /128 MiB to 64 GiB/,
  );
});

test('finds the most specific data mount and parses OS identity', () => {
  const mounts = parseMountTable(
    'root / ext4 rw,noatime 0 0\ndata /opt/qinglong ext4 rw,nodev 0 0\ntmp /tmp tmpfs rw,nosuid 0 0\n',
  );
  assert.equal(
    mountForPath(mounts, '/opt/qinglong/data').path,
    '/opt/qinglong',
  );
  assert.deepEqual(parseOsRelease('ID=openwrt\nVERSION_ID="24.10"\n'), {
    id: 'openwrt',
    versionId: '24.10',
  });
});

test('fails closed on architecture, memory, filesystem and virtualization drift', () => {
  assert.deepEqual(
    validateObservedPlatform(
      manifest(),
      observed({
        architecture: 'x64',
        totalMemoryBytes: 512 * 1024 * 1024,
        dataFilesystem: 'overlay',
        virtualizationIndicators: ['DMI'],
      }),
    ),
    [
      'architecture x64 did not equal arm64',
      'observed memory is outside the declared device range',
      'filesystem overlay did not equal ext4',
      'virtualization indicators found: DMI',
    ],
  );
});

test('produces digest-bound candidate evidence but never supported status', () => {
  const report = buildEvidenceReport({
    manifest: manifest(),
    observed: observed(),
    workloads: [{ name: 'edge-executor', report: { gates: { passed: true } } }],
    generatedAt: '2026-07-22T00:00:00.000Z',
  });
  assert.equal(report.supported, false);
  assert.equal(report.qualification.physicalCandidate, true);
  assert.equal(report.sha256.length, 64);
  const changed = buildEvidenceReport({
    manifest: manifest({ deviceId: 'router-a2' }),
    observed: observed(),
    workloads: [],
    generatedAt: '2026-07-22T00:00:00.000Z',
  });
  assert.notEqual(changed.sha256, report.sha256);
});

test('requires canonical absolute input paths', () => {
  assert.deepEqual(
    parseArguments([
      '--',
      '--manifest=/etc/ql3/device.json',
      '--data-path=/opt/qinglong/data',
      '--output=/opt/qinglong/evidence.json',
      '--idle-evidence=/opt/qinglong/idle.json',
      '--adoption-scale-evidence=/opt/qinglong/adoption.json',
      '--compose-storage-evidence=/opt/qinglong/compose-storage.json',
      '--application-start-evidence=/opt/qinglong/application-start.json',
      '--fault-evidence=/opt/qinglong/enospc.json',
      '--fault-evidence=/opt/qinglong/readonly.json',
      '--json',
    ]),
    {
      manifestPath: '/etc/ql3/device.json',
      dataPath: '/opt/qinglong/data',
      outputPath: '/opt/qinglong/evidence.json',
      idleEvidencePath: '/opt/qinglong/idle.json',
      adoptionScaleEvidencePath: '/opt/qinglong/adoption.json',
      composeStorageEvidencePath: '/opt/qinglong/compose-storage.json',
      applicationStartEvidencePath: '/opt/qinglong/application-start.json',
      faultEvidencePaths: [
        '/opt/qinglong/enospc.json',
        '/opt/qinglong/readonly.json',
      ],
      json: true,
    },
  );
  assert.throws(
    () => parseArguments(['--manifest=device.json', '--data-path=/data']),
    /manifestPath must be absolute/,
  );
  assert.throws(
    () =>
      parseArguments([
        '--',
        '--',
        '--manifest=/etc/ql3/device.json',
        '--data-path=/data',
      ]),
    /unsupported argument --/,
  );
});

test('imports exact same-boot ENOSPC and read-only evidence independently', (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-fault-import-test-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const createFault = (fault) => {
    const errorCode = fault === 'enospc_filesystem' ? 'ENOSPC' : 'EROFS';
    const body = {
      schemaVersion: 1,
      evidenceClass: 'physical_edge_fault_candidate',
      supported: false,
      generatedAt: '2026-07-22T00:00:00.000Z',
      manifest: {
        schemaVersion: 1,
        evidenceClass: 'physical_edge_fault_candidate',
        profile: 'edge',
        deviceId: 'router-a1',
        fault,
        probePath: `/mnt/${fault}`,
        expectedFilesystem: 'ext4',
        maximumFilesystemBytes: 64 * 1024 * 1024,
      },
      observed: {
        platform: 'linux',
        architecture: 'arm64',
        node: 'v24.18.0',
        bootId: observed().bootId,
        processUid: 1000,
        probePath: `/mnt/${fault}`,
        mountPath: `/mnt/${fault}`,
        filesystem: 'ext4',
        mountOptions: [fault === 'enospc_filesystem' ? 'rw' : 'ro', 'nodev'],
        totalBytes: 32 * 1024 * 1024,
        availableBytes: fault === 'enospc_filesystem' ? 0 : 4096,
        expectedErrorCode: errorCode,
        probeEntryCreated: false,
        probeEntryRemained: false,
      },
      qualification: {
        passed: true,
        violations: [],
        scope: fault,
        doesNotProve: [
          'main_data_filesystem_fault',
          'application_level_recovery',
          'power_loss_survival',
        ],
      },
    };
    return {
      ...body,
      sha256: require('node:crypto')
        .createHash('sha256')
        .update(JSON.stringify(body))
        .digest('hex'),
    };
  };
  const enospc = createFault('enospc_filesystem');
  const readonly = createFault('read_only_filesystem');
  assert.deepEqual(
    validateFaultEvidenceReport(enospc, manifest(), observed()),
    [],
  );
  const enospcPath = path.join(directory, 'enospc.json');
  writeNoReplace(enospcPath, `${JSON.stringify(enospc)}\n`);
  assert.equal(
    readFaultEvidence(enospcPath, manifest(), observed()).manifest.fault,
    'enospc_filesystem',
  );
  const report = buildEvidenceReport({
    manifest: manifest(),
    observed: observed(),
    workloads: [],
    supplementalEvidence: [enospc, readonly],
    generatedAt: '2026-07-22T00:01:00.000Z',
  });
  assert.ok(
    report.qualification.collectedEvidence.includes('real_enospc_filesystem'),
  );
  assert.ok(
    report.qualification.collectedEvidence.includes('read_only_filesystem'),
  );
  assert.ok(
    !report.qualification.remainingRequiredEvidence.includes(
      'real_enospc_filesystem',
    ),
  );
  assert.ok(
    !report.qualification.remainingRequiredEvidence.includes(
      'read_only_filesystem',
    ),
  );
  const widened = {
    ...enospc,
    observed: { ...enospc.observed, availableBytes: 4096 },
  };
  assert.match(
    validateFaultEvidenceReport(widened, manifest(), observed()).join('; '),
    /SHA-256 did not match.*ENOSPC evidence did not prove/,
  );
});

test('imports one same-device 100000-row adoption report into aggregate evidence', (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-adoption-import-test-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const adoptionManifest = normalizeAdoptionScaleManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_adoption_scale_candidate',
    profile: 'edge',
    deviceId: manifest().deviceId,
    expectedArchitecture: manifest().expectedArchitecture,
    expectedFilesystem: manifest().expectedFilesystem,
    rowCount: 100_000,
    maxReviewFileBytes: 32 * 1024 * 1024,
  });
  const measurement = {
    durationMs: 100,
    peakRssBytes: 30_000_000,
    sampleCount: 10,
    readBytes: 4096,
    writeBytes: 8192,
    cancelledWriteBytes: 0,
    exitCode: 0,
  };
  const adoption = buildAdoptionScaleReport({
    manifest: adoptionManifest,
    observed: observed(),
    preflight: {
      sourceRowCount: 100_000,
      reviewFileBytes: 20_000_000,
      targetLedgerCount: 0,
      targetStorage: {
        logicalBytes: 4096,
        allocatedBytes: 4096,
        files: [],
      },
    },
    issue: measurement,
    commit: measurement,
    final: {
      ledgerCount: 1,
      adoptedTaskCount: 100_000,
      adoptedTriggerCount: 100_000,
      targetStorage: {
        logicalBytes: 8192,
        allocatedBytes: 8192,
        files: [],
      },
    },
    generatedAt: '2026-07-22T00:00:00.000Z',
  });
  assert.deepEqual(
    validateAdoptionScaleEvidenceReport(adoption, manifest(), observed()),
    [],
  );
  const evidencePath = path.join(directory, 'adoption.json');
  writeNoReplace(evidencePath, `${JSON.stringify(adoption)}\n`);
  assert.equal(
    readAdoptionScaleEvidence(evidencePath, manifest(), observed()).sha256,
    adoption.sha256,
  );
  const aggregate = buildEvidenceReport({
    manifest: manifest(),
    observed: observed(),
    workloads: [],
    supplementalEvidence: [adoption],
    generatedAt: '2026-07-22T00:01:00.000Z',
  });
  assert.ok(
    aggregate.qualification.collectedEvidence.includes(
      'legacy_adoption_100000_row_scaling',
    ),
  );
  assert.ok(
    !aggregate.qualification.remainingRequiredEvidence.includes(
      'legacy_adoption_100000_row_scaling',
    ),
  );
  assert.match(
    validateAdoptionScaleEvidenceReport(
      { ...adoption, sha256: '0'.repeat(64) },
      manifest(),
      observed(),
    ).join('; '),
    /SHA-256/,
  );
});

test('imports only private digest-bound idle evidence from the same device boot', (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-idle-import-test-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const idleManifest = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_idle_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    processId: 123,
    expectedExecutable: '/usr/bin/node',
    durationSeconds: 30,
    sampleIntervalMs: 10_000,
  };
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_idle_candidate',
    supported: false,
    generatedAt: '2026-07-22T00:00:00.000Z',
    manifest: idleManifest,
    identity: {
      platform: 'linux',
      architecture: 'arm64',
      node: 'v24.18.0',
      bootId: observed().bootId,
      processId: 123,
      processUid: 1000,
      executable: '/usr/bin/node',
      commandSha256: 'a'.repeat(64),
      startTicks: 100,
    },
    summary: { sampleCount: 4, actualDurationMs: 30_000 },
    qualification: {
      passed: true,
      violations: [],
      measures: [
        'process_rss',
        'process_cpu_ticks',
        'process_context_switches',
        'process_io',
      ],
      doesNotProve: [
        'whole_device_cpu_wakeups',
        'whole_device_flash_write_amplification',
        'cold_start_or_first_ready',
      ],
    },
  };
  const idle = {
    ...body,
    sha256: require('node:crypto')
      .createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex'),
  };
  assert.deepEqual(
    validateIdleEvidenceReport(idle, manifest(), observed()),
    [],
  );
  const idlePath = path.join(directory, 'idle.json');
  writeNoReplace(idlePath, `${JSON.stringify(idle)}\n`);
  assert.equal(
    readIdleEvidence(idlePath, manifest(), observed()).sha256,
    idle.sha256,
  );
  const report = buildEvidenceReport({
    manifest: manifest(),
    observed: observed(),
    workloads: [],
    supplementalEvidence: [idle],
    generatedAt: '2026-07-22T00:01:00.000Z',
  });
  assert.deepEqual(report.qualification.collectedEvidence, [
    'idle_process_rss_cpu_ticks_context_switches_and_io',
  ]);
  assert.ok(
    !report.qualification.remainingRequiredEvidence.includes(
      'idle_process_rss_cpu_ticks_context_switches_and_io',
    ),
  );
  assert.ok(
    report.qualification.remainingRequiredEvidence.includes(
      'whole_device_cpu_wakeups_and_flash_write_amplification',
    ),
  );
  const drifted = {
    ...idle,
    identity: { ...idle.identity, bootId: 'different' },
  };
  assert.match(
    validateIdleEvidenceReport(drifted, manifest(), observed()).join('; '),
    /SHA-256 did not match.*runtime identity did not match/,
  );
});

test('publishes private evidence without replacing an existing record', (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-evidence-test-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, 'evidence.json');
  writeNoReplace(outputPath, '{"schemaVersion":1}\n');
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), '{"schemaVersion":1}\n');
  assert.throws(
    () => writeNoReplace(outputPath, 'replacement'),
    (error) => error?.code === 'EEXIST',
  );
});

test('imports a different-boot Compose collection storage candidate without widening power-loss claims', (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-compose-storage-import-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const supplementalManifest = normalizeComposeStorageManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_compose_storage_candidate',
    profile: 'edge',
    deviceId: manifest().deviceId,
    expectedArchitecture: manifest().expectedArchitecture,
    expectedFilesystem: manifest().expectedFilesystem,
    snapshotCount: 3,
    databasePayloadBytes: 4 * 1024 * 1024,
    maximumPrepareWriteAmplificationPermille: 50_000,
    maximumResumeWriteAmplificationPermille: 50_000,
  });
  const targetSnapshot = {
    contractVersion: 44,
    sha256: 'a'.repeat(64),
    bytes: 4_000_000,
    pageCount: 1000,
    pageSize: 4096,
  };
  const before = {
    platform: 'linux',
    architecture: 'arm64',
    bootId: '019f0000-0000-4000-8000-000000000001',
    mountPath: observed().dataPath,
    filesystem: 'ext4',
    mountOptions: ['rw', 'noatime'],
    blockDevice: '/dev/mmcblk0p3',
    sectorsWritten: 10_000,
  };
  const afterStart = {
    ...before,
    bootId: observed().bootId,
    sectorsWritten: 200,
  };
  const after = { ...afterStart, sectorsWritten: 220 };
  const session = {
    sessionId: '019f0000-0000-4000-8000-000000000010',
    sha256: 'b'.repeat(64),
    preparedAt: '2026-07-29T00:00:00.000Z',
    dataPath: observed().dataPath,
    collection: {
      target: {
        rolloutId: '019f0000-0000-4000-8000-000000000011',
        snapshot: targetSnapshot,
      },
    },
  };
  const composeStorage = buildComposeStorageReport({
    manifest: supplementalManifest,
    session,
    observed: { before, afterStart, after },
    measurements: {
      logicalSnapshotBytes: 12_000_000,
      collectedSnapshotBytes: 4_000_000,
      prepareDeviceBytesWritten: 24_000_000,
      resumeDeviceBytesWritten: 10_240,
      prepareWriteAmplificationPermille: 2000,
      resumeWriteAmplificationPermille: 3,
      barrierAllocatedBytes: 20_500_000,
      finalAllocatedBytes: 16_400_000,
      reclaimedAllocatedBytes: 4_100_000,
    },
    outcomes: {
      commitStatus: 'collected',
      replayStatus: 'existing',
      sqliteIntegrity: 'ok',
      stageRemoved: true,
      tombstonePresent: true,
      retainedSnapshots: 2,
    },
    generatedAt: '2026-07-29T00:01:00.000Z',
  });
  assert.deepEqual(
    validateComposeStorageEvidenceReport(
      composeStorage,
      manifest(),
      observed(),
    ),
    [],
  );
  const evidencePath = path.join(directory, 'compose-storage.json');
  writeNoReplace(evidencePath, `${JSON.stringify(composeStorage)}\n`);
  assert.equal(
    readComposeStorageEvidence(evidencePath, manifest(), observed()).sha256,
    composeStorage.sha256,
  );
  const aggregate = buildEvidenceReport({
    manifest: manifest(),
    observed: observed(),
    workloads: [],
    supplementalEvidence: [composeStorage],
    generatedAt: '2026-07-29T00:02:00.000Z',
  });
  assert.ok(
    aggregate.qualification.collectedEvidence.includes(
      'compose_sqlite_collection_reboot_and_partition_write_upper_bound',
    ),
  );
  assert.ok(
    !aggregate.qualification.remainingRequiredEvidence.includes(
      'compose_sqlite_collection_reboot_and_partition_write_upper_bound',
    ),
  );
  assert.ok(
    aggregate.qualification.remainingRequiredEvidence.includes(
      'power_loss_restart',
    ),
  );
  assert.ok(
    composeStorage.qualification.doesNotProve.includes(
      'abrupt_power_interruption_provenance',
    ),
  );
});

test('imports post-reboot warm-Node native application activation while retaining the full cold-start gate', (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-application-start-import-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const artifact = {
    artifactSha256: 'a'.repeat(64),
    artifactMetadataSha256: 'e'.repeat(64),
    artifactFiles: 320,
    artifactBytes: 2_000_000,
    entrypointSha256: 'b'.repeat(64),
    packages: [
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
    ],
  };
  const applicationManifest = normalizeApplicationStartManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_application_start_candidate',
    profile: 'edge',
    deviceId: manifest().deviceId,
    expectedArchitecture: manifest().expectedArchitecture,
    expectedFilesystem: manifest().expectedFilesystem,
    expectedArtifactSha256: artifact.artifactSha256,
    expectedArtifactFiles: artifact.artifactFiles,
    expectedArtifactBytes: artifact.artifactBytes,
    expectedNodeSha256: 'c'.repeat(64),
    maximumBootAgeMs: 180_000,
    maximumFirstActiveMs: 30_000,
    maximumSampledRssBytes: 256 * 1024 * 1024,
    sampleIntervalMs: 10,
  });
  const previousBoot = {
    platform: 'linux',
    architecture: 'arm64',
    bootId: '019f0000-0000-4000-8000-000000000001',
    dataFilesystem: 'ext4',
    nodeExecutable: '/usr/bin/node',
    nodeSha256: 'c'.repeat(64),
    nodeVersion: 'v24.18.0',
    bootAgeMs: 50_000,
  };
  const currentBoot = {
    ...previousBoot,
    bootId: observed().bootId,
    bootAgeMs: 5_000,
  };
  const session = {
    sessionId: '019f0000-0000-4000-8000-000000000010',
    sha256: 'd'.repeat(64),
    preparedAt: '2026-07-29T00:00:00.000Z',
    artifact,
    paths: { dataPath: observed().dataPath },
  };
  const applicationStart = buildApplicationStartReport({
    manifest: applicationManifest,
    session,
    observed: {
      before: previousBoot,
      after: currentBoot,
      artifact,
    },
    measurements: {
      firstActiveMs: 1200,
      maximumSampledRssBytes: 80 * 1024 * 1024,
      processReadBytes: 4096,
      processWriteBytes: 8192,
      sampleCount: 20,
      eventCount: 5,
    },
    outcomes: {
      activeEventCount: 1,
      aiStatus: 'deployment_excluded',
      gracefulStop: true,
      exitCode: 0,
      exitSignal: null,
      stderrBytes: 0,
      sqliteContractVersion: 41,
    },
    generatedAt: '2026-07-29T00:01:00.000Z',
  });
  assert.deepEqual(
    validateApplicationStartEvidenceReport(
      applicationStart,
      manifest(),
      observed(),
    ),
    [],
  );
  const evidencePath = path.join(directory, 'application-start.json');
  writeNoReplace(evidencePath, `${JSON.stringify(applicationStart)}\n`);
  assert.equal(
    readApplicationStartEvidence(evidencePath, manifest(), observed()).sha256,
    applicationStart.sha256,
  );
  const aggregate = buildEvidenceReport({
    manifest: manifest(),
    observed: observed(),
    workloads: [],
    supplementalEvidence: [applicationStart],
    generatedAt: '2026-07-29T00:02:00.000Z',
  });
  assert.ok(
    aggregate.qualification.collectedEvidence.includes(
      'post_reboot_warm_node_native_application_start_to_active',
    ),
  );
  assert.ok(
    !aggregate.qualification.remainingRequiredEvidence.includes(
      'cold_start_and_first_ready',
    ),
  );
  assert.ok(
    aggregate.qualification.remainingRequiredEvidence.includes(
      'power_on_cold_node_and_service_manager_start_to_first_ready',
    ),
  );
  assert.ok(
    aggregate.qualification.remainingRequiredEvidence.includes(
      'power_loss_restart',
    ),
  );
});
