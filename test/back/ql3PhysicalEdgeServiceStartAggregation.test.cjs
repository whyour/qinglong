const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  buildEvidenceReport,
  canonicalDigest,
  normalizeManifest,
  parseArguments,
  validateServiceStartEvidenceReport,
} = require('../../scripts/ql3-physical-edge-evidence.cjs');
const {
  buildServiceStartReport,
  normalizeServiceStartManifest,
  normalizeSession,
} = require('../../scripts/ql3-physical-edge-service-start.cjs');

const deviceBootId = '019f0000-0000-4000-8000-000000000002';
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

function observed() {
  return {
    platform: 'linux',
    architecture: 'arm64',
    bootId: deviceBootId,
    bootAgeMs: 15_000,
    dataFilesystem: 'ext4',
    nodeExecutable: '/usr/bin/node',
    nodeSha256: 'd'.repeat(64),
    nodeVersion: 'v24.18.0',
    virtualizationIndicators: [],
  };
}

function physicalObserved() {
  return {
    platform: 'linux',
    architecture: 'arm64',
    node: 'v24.18.0',
    bootId: deviceBootId,
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

function serviceManifest() {
  return normalizeServiceStartManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_service_start_candidate',
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
  });
}

function serviceReport() {
  const sessionId = '019f0000-0000-4000-8000-000000000020';
  const dataPath = '/mnt/ql3-evidence';
  const deploymentRoot = `${dataPath}/.ql3-service-start-deployment-${sessionId}`;
  const toolRoot = `${deploymentRoot}/physical-service-start`;
  const serviceName = 'qinglong3-physical-019f0000';
  const sessionBody = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_service_start_session',
    sessionId,
    manifestDigest: canonicalDigest(serviceManifest()),
    uid: 1000,
    preparedAt: '2026-07-29T08:00:00.000Z',
    artifact: artifact(),
    environment: {
      ...observed(),
      bootId: '019f0000-0000-4000-8000-000000000001',
    },
    paths: {
      dataPath,
      toolRoot,
      deploymentRoot,
      artifactRoot: '/opt/qinglong3-release',
      applicationEntrypoint:
        '/opt/qinglong3-release/node_modules/@qinglong/local-application/dist/cli.js',
      applicationConfig: `${deploymentRoot}/local-application.json`,
      wrapper: `${toolRoot}/boot-probe.sh`,
      wrapperStartRecord: `${toolRoot}/wrapper-start.record`,
      nodeRecord: `${toolRoot}/node.record`,
      activeRecord: `${toolRoot}/active.record`,
      eventLog: `${toolRoot}/events.jsonl`,
      stderrLog: `${toolRoot}/stderr.log`,
      fifo: `${toolRoot}/events.fifo`,
    },
    service: {
      kind: 'systemd',
      serviceName,
      managerExecutable: '/usr/bin/systemctl',
      managerSha256: 'e'.repeat(64),
      enableExecutable: '/usr/bin/systemctl',
      enableSha256: 'e'.repeat(64),
      descriptorSource: `${deploymentRoot}/service/qinglong3.service`,
      descriptorDestination: `/etc/systemd/system/${serviceName}.service`,
      descriptorMode: 0o644,
      descriptorSha256: 'f'.repeat(64),
      wrapperSha256: '1'.repeat(64),
      installArguments: [
        '-o',
        'root',
        '-g',
        'root',
        '-m',
        '644',
        `${deploymentRoot}/service/qinglong3.service`,
        `/etc/systemd/system/${serviceName}.service`,
      ],
      enableArguments: ['enable', serviceName],
    },
  };
  const session = normalizeSession({
    ...sessionBody,
    sha256: canonicalDigest(sessionBody),
  });
  return buildServiceStartReport({
    manifest: serviceManifest(),
    session,
    observed: {
      after: observed(),
      artifact: artifact(),
      process: {
        bootId: deviceBootId,
        wrapperPid: 101,
        wrapperStartTicks: 1200,
        nodePid: 102,
        nodeStartTicks: 1201,
      },
      service: {
        kind: 'systemd',
        serviceName,
        managerExecutable: '/usr/bin/systemctl',
        managerSha256: 'e'.repeat(64),
        descriptorSha256: 'f'.repeat(64),
        mainPid: 101,
      },
    },
    measurements: {
      serviceStartBootAgeMs: 12_000,
      activeBootAgeMs: 13_250,
      bootToActiveMs: 13_250,
      serviceStartToActiveMs: 1_250,
      activeEventOrdinal: 2,
    },
    outcomes: {
      activeEventCount: 1,
      aiStatus: 'deployment_excluded',
      descriptorInstalled: true,
      serviceActive: true,
      serviceEnabled: true,
      wrapperProcessIdentityMatched: true,
      nodeProcessIdentityMatched: true,
      stderrBytes: 0,
    },
    generatedAt: '2026-07-29T08:01:00.000Z',
  });
}

test('accepts the service-start importer path', () => {
  assert.equal(
    parseArguments([
      '--manifest=/mnt/data/manifest.json',
      '--data-path=/mnt/data',
      '--service-start-evidence=/mnt/data/service-start.json',
    ]).serviceStartEvidencePath,
    '/mnt/data/service-start.json',
  );
  assert.throws(
    () =>
      parseArguments([
        '--manifest=/mnt/data/manifest.json',
        '--data-path=/mnt/data',
        '--service-start-evidence=service-start.json',
      ]),
    /serviceStartEvidencePath must be absolute/,
  );
});

test('validates same-device current-boot service evidence', () => {
  assert.deepEqual(
    validateServiceStartEvidenceReport(
      serviceReport(),
      baseManifest(),
      observed(),
    ),
    [],
  );
  assert.notDeepEqual(
    validateServiceStartEvidenceReport(serviceReport(), baseManifest(), {
      ...observed(),
      bootId: '019f0000-0000-4000-8000-000000000099',
    }),
    [],
  );
});

test('refines but does not erase the broad power-on startup gate', () => {
  const report = buildEvidenceReport({
    manifest: baseManifest(),
    observed: physicalObserved(),
    workloads: {},
    supplementalEvidence: [serviceReport()],
    generatedAt: '2026-07-29T08:02:00.000Z',
  });
  assert.ok(
    report.qualification.collectedEvidence.includes(
      'kernel_boot_to_init_managed_native_application_active',
    ),
  );
  assert.ok(
    report.qualification.remainingRequiredEvidence.includes(
      'firmware_and_bootloader_power_on_to_linux_kernel_clock',
    ),
  );
  assert.ok(
    report.qualification.remainingRequiredEvidence.includes(
      'direct_release_unit_without_evidence_wrapper',
    ),
  );
  assert.equal(
    report.qualification.remainingRequiredEvidence.includes(
      'cold_start_and_first_ready',
    ),
    false,
  );
  assert.equal(report.supported, false);
});
