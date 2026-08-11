const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  buildDirectServiceStopReport,
  normalizeStopSession,
  parseArguments,
  validateDirectServiceStopReport,
} = require('../../scripts/ql3-physical-edge-direct-service-stop.cjs');
const {
  normalizeDirectServiceStartManifest,
} = require('../../scripts/ql3-physical-edge-direct-service-start.cjs');
const {
  buildEvidenceReport,
  canonicalDigest,
  normalizeManifest,
  parseArguments: parseEvidenceArguments,
  validateDirectServiceStopEvidenceReport,
} = require('../../scripts/ql3-physical-edge-evidence.cjs');

function manifest() {
  return normalizeDirectServiceStartManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_direct_service_start_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    serviceManager: 'systemd',
    expectedArchitecture: 'arm64',
    expectedFilesystem: 'ext4',
    expectedArtifactSha256: 'a'.repeat(64),
    expectedArtifactFiles: 640,
    expectedArtifactBytes: 6_000_000,
    expectedNodeSha256: 'b'.repeat(64),
    maximumBootToActiveMs: 180_000,
    maximumServiceStartBootAgeMs: 60_000,
    maximumServiceStartToActiveMs: 30_000,
  });
}

function directSession() {
  return {
    uid: process.getuid?.() ?? 0,
    sha256: 'c'.repeat(64),
    paths: { deploymentRoot: '/mnt/ql3/direct' },
  };
}

function stopSession() {
  const source = directSession();
  const sessionId = '123e4567-e89b-42d3-a456-426614174031';
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_direct_service_stop_session',
    sessionId,
    uid: source.uid,
    preparedAt: '2026-08-11T12:00:00.000Z',
    manifestDigest: canonicalDigest(manifest()),
    directSessionDigest: source.sha256,
    activeReportDigest: 'd'.repeat(64),
    activeBootId: '12345678-1234-4abc-8def-123456789abc',
    startupReceiptDigest: 'e'.repeat(64),
    processId: 101,
    processStartTicks: '1200',
    bridge: {
      actionId: sessionId,
      controllerRoot: '/var/lib/qinglong3-service-bridge',
      intentDigest: 'f'.repeat(64),
      intentPath: `/mnt/ql3/direct/service/service-manager-intents/${sessionId}.json`,
      outcomePath: `/mnt/ql3/direct/service/service-manager-outcomes/${sessionId}.json`,
    },
  };
  return normalizeStopSession(
    { ...body, sha256: canonicalDigest(body) },
    source,
  );
}

function shutdownReceipt() {
  const body = {
    schemaVersion: 1,
    schema: 'qinglong/local-application-shutdown-receipt@v1',
    instanceId: 'physical-direct-12345678',
    profile: 'edge',
    signal: 'SIGTERM',
    stopResult: 'stopped',
    startupReceiptDigest: 'e'.repeat(64),
    bootId: '12345678-1234-4abc-8def-123456789abc',
    stoppedBootAgeMs: 20_000,
    processId: 101,
    processStartTicks: '1200',
    nodeExecutable: '/usr/bin/node',
    nodeVersion: 'v24.18.0',
  };
  const sha256 = crypto
    .createHash('sha256')
    .update('qinglong.local-application-shutdown-receipt.v1\0', 'utf8')
    .update(JSON.stringify(body), 'utf8')
    .digest('hex');
  return { ...body, sha256 };
}

function observed(overrides = {}) {
  const session = stopSession();
  return {
    currentBootId: session.activeBootId,
    bridge: {
      actionId: session.bridge.actionId,
      intentDigest: session.bridge.intentDigest,
      outcomeDigest: '1'.repeat(64),
      observationDigest: '2'.repeat(64),
      state: 'stopped',
    },
    shutdownReceipt: shutdownReceipt(),
    processIdentityGone: true,
    service: {
      active: false,
      enabled: true,
      fragmentPath: '/etc/systemd/system/qinglong3.service',
      mainPid: 0,
    },
    ...overrides,
  };
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
    memoryBytes: { minimum: 128 * 1024 * 1024, maximum: 512 * 1024 * 1024 },
    expectedFilesystem: 'ext4',
  });
}

function physicalObserved() {
  return {
    platform: 'linux',
    architecture: 'arm64',
    node: 'v24.18.0',
    bootId: stopSession().activeBootId,
    kernel: '6.6.0',
    distribution: { id: 'openwrt', versionId: '24.10' },
    libc: 'musl-ld-musl-aarch64.so.1',
    cpuModel: 'test-cpu',
    cpuCount: 1,
    totalMemoryBytes: 256 * 1024 * 1024,
    observedModel: 'router-a1-model',
    dataPath: '/mnt/ql3',
    dataFilesystem: 'ext4',
    dataMountOptions: ['rw', 'noatime'],
    dataBytes: 4 * 1024 * 1024 * 1024,
    dataAvailableBytes: 2 * 1024 * 1024 * 1024,
    virtualizationIndicators: [],
  };
}

test('requires exact phase-specific stop evidence paths', () => {
  assert.equal(
    parseArguments([
      'prepare',
      '--manifest=/mnt/ql3/manifest.json',
      '--session=/mnt/ql3/session.json',
      '--active-report=/mnt/ql3/active.json',
      '--stop-session=/mnt/ql3/stop-session.json',
      '--root-command-output=/mnt/ql3/stop-root-command.json',
    ]).phase,
    'prepare',
  );
  assert.equal(
    parseArguments([
      'prepare',
      '--manifest=/mnt/ql3/manifest.json',
      '--session=/mnt/ql3/session.json',
      '--active-report=/mnt/ql3/active.json',
      '--stop-session=/mnt/ql3/stop-session.json',
      '--root-command-output=/mnt/ql3/stop-root-command.json',
    ]).rootCommandOutputPath,
    '/mnt/ql3/stop-root-command.json',
  );
  assert.throws(
    () =>
      parseArguments([
        'resume',
        '--manifest=/mnt/ql3/manifest.json',
        '--session=/mnt/ql3/session.json',
        '--active-report=/mnt/ql3/active.json',
        '--stop-session=/mnt/ql3/stop-session.json',
        '--output=/mnt/ql3/stop.json',
        '--root-command-output=/mnt/ql3/stop-root-command.json',
      ]),
    /valid only as a normalized prepare path/,
  );
  assert.throws(
    () =>
      parseArguments([
        'resume',
        '--manifest=manifest.json',
        '--session=/mnt/ql3/session.json',
        '--active-report=/mnt/ql3/active.json',
        '--stop-session=/mnt/ql3/stop-session.json',
        '--output=/mnt/ql3/stop.json',
      ]),
    /manifestPath must be absolute/,
  );
});

test('binds one stop session to the active report and Owner intent', () => {
  const session = stopSession();
  assert.equal(session.bridge.actionId, session.sessionId);
  assert.equal(session.directSessionDigest, directSession().sha256);
  assert.throws(
    () =>
      normalizeStopSession(
        { ...session, activeReportDigest: '0'.repeat(64) },
        directSession(),
      ),
    /invalid or drifted/,
  );
});

test('recomputes a graceful direct service stop report', () => {
  const report = buildDirectServiceStopReport({
    manifest: manifest(),
    stopSession: stopSession(),
    observed: observed(),
    generatedAt: '2026-08-11T12:01:00.000Z',
  });
  assert.equal(report.qualification.passed, true);
  assert.deepEqual(validateDirectServiceStopReport(report, manifest()), []);
});

test('rejects a forged shutdown receipt and a still-live process', () => {
  const valid = shutdownReceipt();
  const report = buildDirectServiceStopReport({
    manifest: manifest(),
    stopSession: stopSession(),
    observed: observed({
      processIdentityGone: false,
      shutdownReceipt: {
        ...valid,
        stoppedBootAgeMs: valid.stoppedBootAgeMs + 1,
      },
    }),
    generatedAt: '2026-08-11T12:01:00.000Z',
  });
  assert.equal(report.qualification.passed, false);
  assert.match(
    report.qualification.violations.join('; '),
    /shutdown receipt binding|stopped state/,
  );
});

test('aggregates graceful stop only when bound to direct start evidence', () => {
  const stopReport = buildDirectServiceStopReport({
    manifest: manifest(),
    stopSession: stopSession(),
    observed: observed(),
    generatedAt: '2026-08-11T12:01:00.000Z',
  });
  const startEvidence = {
    evidenceClass: 'physical_edge_direct_service_start_candidate',
    sha256: stopReport.session.activeReportDigest,
  };
  const aggregate = buildEvidenceReport({
    manifest: baseManifest(),
    observed: physicalObserved(),
    workloads: [],
    supplementalEvidence: [startEvidence, stopReport],
    generatedAt: '2026-08-11T12:02:00.000Z',
  });
  assert.ok(
    aggregate.qualification.collectedEvidence.includes(
      'init_managed_graceful_application_stop',
    ),
  );
  assert.equal(
    aggregate.qualification.remainingRequiredEvidence.includes(
      'init_managed_graceful_application_stop',
    ),
    false,
  );
  assert.equal(
    parseEvidenceArguments([
      '--manifest=/mnt/ql3/manifest.json',
      '--data-path=/mnt/ql3',
      '--direct-service-start-evidence=/mnt/ql3/start.json',
      '--direct-service-stop-evidence=/mnt/ql3/stop.json',
    ]).directServiceStopEvidencePath,
    '/mnt/ql3/stop.json',
  );
  const active = {
    ...startEvidence,
    session: { sessionDigest: stopReport.session.directSessionDigest },
    observed: {
      after: { bootId: stopReport.session.activeBootId },
      receipt: {
        sha256: stopReport.session.startupReceiptDigest,
        processId: stopReport.session.processId,
        processStartTicks: stopReport.session.processStartTicks,
        instanceId: stopReport.observed.shutdownReceipt.instanceId,
        nodeExecutable: stopReport.observed.shutdownReceipt.nodeExecutable,
      },
    },
  };
  assert.deepEqual(
    validateDirectServiceStopEvidenceReport(
      stopReport,
      baseManifest(),
      physicalObserved(),
      active,
    ),
    [],
  );
});

test('documents the exact direct start and graceful stop bridge sequence', () => {
  const runbook = fs.readFileSync(
    path.join(__dirname, '../../docs/operations/ql3-local-deployment.md'),
    'utf8',
  );
  const startPrepare = runbook.indexOf(
    'evidence:physical-edge-direct-service-start -- prepare',
  );
  const startBridge = runbook.indexOf(
    'ql3-service-bridge run --command-file',
    startPrepare,
  );
  const startResume = runbook.indexOf(
    'evidence:physical-edge-direct-service-start -- resume',
    startBridge,
  );
  const stopPrepare = runbook.indexOf(
    'evidence:physical-edge-direct-service-stop -- prepare',
    startResume,
  );
  const stopBridge = runbook.indexOf(
    'ql3-service-bridge run --command-file',
    stopPrepare,
  );
  const stopResume = runbook.indexOf(
    'evidence:physical-edge-direct-service-stop -- resume',
    stopBridge,
  );
  assert.ok(
    startPrepare >= 0 &&
      startPrepare < startBridge &&
      startBridge < startResume &&
      startResume < stopPrepare &&
      stopPrepare < stopBridge &&
      stopBridge < stopResume,
  );
  for (const fragment of [
    '--root-command-output=/opt/qinglong/evidence-scratch/direct-service-start-root-command.json',
    '--active-report=/opt/qinglong/evidence-scratch/direct-service-start-report.json',
    '--stop-session=/opt/qinglong/evidence-scratch/direct-service-stop-session.json',
    '--root-command-output=/opt/qinglong/evidence-scratch/direct-service-stop-root-command.json',
    '--direct-service-stop-evidence=/opt/qinglong/evidence-scratch/direct-service-stop-report.json',
  ]) {
    assert.ok(runbook.includes(fragment), fragment);
  }
});
