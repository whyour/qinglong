const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  amplificationPermille,
  buildComposeStorageReport,
  normalizeComposeStorageManifest,
  normalizeSession,
  parseArguments,
  parseSectorsWritten,
  validateComposeStorageReport,
  validateStorageIdentity,
} = require('../../scripts/ql3-physical-edge-compose-storage.cjs');
const {
  canonicalDigest,
} = require('../../scripts/ql3-physical-edge-evidence.cjs');

function manifest(overrides = {}) {
  return normalizeComposeStorageManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_compose_storage_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    expectedArchitecture: 'arm64',
    expectedFilesystem: 'ext4',
    snapshotCount: 3,
    databasePayloadBytes: 4 * 1024 * 1024,
    maximumPrepareWriteAmplificationPermille: 50_000,
    maximumResumeWriteAmplificationPermille: 50_000,
    ...overrides,
  });
}

function identity(bootId, sectorsWritten, overrides = {}) {
  return {
    platform: 'linux',
    architecture: 'arm64',
    bootId,
    mountPath: '/mnt/ql3-evidence',
    filesystem: 'ext4',
    mountOptions: ['rw', 'noatime'],
    blockDevice: '/dev/mmcblk0p3',
    sectorsWritten,
    ...overrides,
  };
}

function sessionFixture(overrides = {}) {
  const before = identity('019f0000-0000-4000-8000-000000000001', 10_000);
  const deploymentRoot =
    '/mnt/ql3-evidence/.ql3-compose-storage-019f0000-0000-4000-8000-000000000010';
  const rolloutId = '019f0000-0000-4000-8000-000000000011';
  const collectionId = '019f0000-0000-4000-8000-000000000012';
  const options = {
    deploymentRoot,
    allowRootService: false,
  };
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_compose_storage_session',
    sessionId: '019f0000-0000-4000-8000-000000000010',
    manifestDigest: canonicalDigest(manifest()),
    uid: 1000,
    preparedAt: '2026-07-29T00:00:00.000Z',
    dataPath: '/mnt/ql3-evidence',
    deploymentRoot,
    barrier: {
      identity: before,
      sectorsWritten: before.sectorsWritten,
      tree: {
        entries: 40,
        regularFiles: 20,
        directories: 20,
        logicalBytes: 20_000_000,
        allocatedBytes: 20_500_000,
      },
    },
    prepareMeasurement: {
      logicalSnapshotBytes: 12_000_000,
      deviceBytesWritten: 24_000_000,
      writeAmplificationPermille: 2000,
    },
    collection: {
      snapshotCount: 3,
      prepareCommand: {
        schemaVersion: 1,
        operation: 'local.deployment.compose.evidence-collection.prepare',
        options,
        request: {
          expectedGeneration: 4,
          collectionId,
          rolloutIds: [rolloutId],
          restoreIds: [],
          preparedAtMs: 1785283200100,
        },
      },
      commitCommand: {
        schemaVersion: 1,
        operation: 'local.deployment.compose.evidence-collection.commit',
        options,
        request: {
          expectedGeneration: 4,
          collectionId,
          committedAtMs: 1785283200101,
        },
      },
      target: {
        rolloutId,
        snapshot: {
          contractVersion: 43,
          sha256: 'a'.repeat(64),
          bytes: 4_000_000,
          pageCount: 1000,
          pageSize: 4096,
        },
      },
      targetPath:
        '/mnt/ql3-evidence/.ql3-compose-storage-019f0000-0000-4000-8000-000000000010/service/rollout-backups/019f0000-0000-4000-8000-000000000011.sqlite',
      stagePath:
        '/mnt/ql3-evidence/.ql3-compose-storage-019f0000-0000-4000-8000-000000000010/service/rollout-backups/.019f0000-0000-4000-8000-000000000011.sqlite.ql3-collection-stage',
    },
    ...overrides,
  };
  return { ...body, sha256: canonicalDigest(body) };
}

function reportFixture(overrides = {}) {
  const session = normalizeSession(sessionFixture());
  const before = session.barrier.identity;
  const afterStart = identity('019f0000-0000-4000-8000-000000000002', 200);
  const after = identity(afterStart.bootId, 220);
  return buildComposeStorageReport({
    manifest: manifest(),
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
    ...overrides,
  });
}

test('normalizes a bounded Edge-only Compose storage manifest', () => {
  assert.equal(manifest().snapshotCount, 3);
  assert.throws(
    () => manifest({ snapshotCount: 4 }),
    /snapshotCount must be 3/,
  );
  assert.throws(
    () => manifest({ databasePayloadBytes: 512 * 1024 }),
    /between 1 and 64 MiB/,
  );
  assert.throws(
    () => manifest({ maximumResumeWriteAmplificationPermille: 999 }),
    /between 1000 and 1000000/,
  );
});

test('requires explicit prepare/resume files and absolute paths', () => {
  assert.deepEqual(
    parseArguments([
      'prepare',
      '--manifest=/etc/qinglong/compose-storage.json',
      '--data-path=/mnt/ql3-evidence',
      '--session=/mnt/ql3-evidence/evidence/session.json',
      '--json',
    ]),
    {
      phase: 'prepare',
      manifestPath: '/etc/qinglong/compose-storage.json',
      dataPath: '/mnt/ql3-evidence',
      sessionPath: '/mnt/ql3-evidence/evidence/session.json',
      json: true,
    },
  );
  assert.deepEqual(
    parseArguments([
      'resume',
      '--manifest=/etc/qinglong/compose-storage.json',
      '--session=/mnt/ql3-evidence/evidence/session.json',
      '--output=/mnt/ql3-evidence/evidence/report.json',
    ]),
    {
      phase: 'resume',
      manifestPath: '/etc/qinglong/compose-storage.json',
      sessionPath: '/mnt/ql3-evidence/evidence/session.json',
      outputPath: '/mnt/ql3-evidence/evidence/report.json',
      json: false,
    },
  );
  assert.throws(
    () =>
      parseArguments([
        'resume',
        '--manifest=manifest.json',
        '--session=/data/session.json',
        '--output=/data/report.json',
      ]),
    /manifestPath must be absolute/,
  );
});

test('parses Linux partition writes and computes integer upper bounds', () => {
  assert.equal(parseSectorsWritten('1 2 3 4 5 6 700 8 9 10 11\n'), 700);
  assert.equal(amplificationPermille(8192, 4096), 2000);
  assert.equal(amplificationPermille(-1, 4096), null);
  assert.throws(() => parseSectorsWritten('1 2 3'), /statistics are invalid/);
});

test('binds the durable pre-reboot session digest and exact stage facts', () => {
  const session = normalizeSession(sessionFixture());
  assert.equal(session.collection.snapshotCount, 3);
  assert.throws(
    () =>
      normalizeSession({
        ...session,
        collection: { ...session.collection, snapshotCount: 2 },
      }),
    /session is invalid or drifted/,
  );
  const escapedRoot = '/opt/qinglong3';
  const escaped = sessionFixture({
    deploymentRoot: escapedRoot,
  });
  assert.throws(
    () => normalizeSession(escaped),
    /session is invalid or drifted/,
  );
  const widenedCommand = sessionFixture();
  widenedCommand.collection.commitCommand.options.deploymentRoot = escapedRoot;
  const { sha256: ignored, ...widenedBody } = widenedCommand;
  assert.throws(
    () =>
      normalizeSession({
        ...widenedBody,
        sha256: canonicalDigest(widenedBody),
      }),
    /session is invalid or drifted/,
  );
  assert.throws(
    () => normalizeSession({ ...session, unexpected: true }),
    /session keys must be exactly/,
  );
});

test('accepts only a different-boot exact recovery with bounded writes', () => {
  const report = reportFixture();
  assert.equal(report.supported, false);
  assert.equal(report.qualification.passed, true);
  assert.ok(
    report.qualification.doesNotProve.includes(
      'abrupt_power_interruption_provenance',
    ),
  );
  const currentObserved = {
    bootId: report.observed.after.bootId,
    architecture: 'arm64',
    dataFilesystem: 'ext4',
    dataPath: '/mnt/ql3-evidence',
  };
  assert.deepEqual(
    validateComposeStorageReport(report, manifest(), currentObserved),
    [],
  );
  const tampered = {
    ...report,
    measurements: {
      ...report.measurements,
      reclaimedAllocatedBytes: 0,
    },
  };
  assert.match(
    validateComposeStorageReport(tampered, manifest(), currentObserved).join(
      '; ',
    ),
    /SHA-256 is invalid/,
  );
});

test('fails same-boot, storage drift, outcome drift and write budget overflow', () => {
  const session = normalizeSession(sessionFixture());
  const sameBoot = session.barrier.identity;
  const report = buildComposeStorageReport({
    manifest: manifest(),
    session,
    observed: {
      before: sameBoot,
      afterStart: sameBoot,
      after: sameBoot,
    },
    measurements: {
      collectedSnapshotBytes: 4_000_000,
      prepareWriteAmplificationPermille: 50_001,
      resumeWriteAmplificationPermille: 50_001,
      reclaimedAllocatedBytes: 0,
    },
    outcomes: {
      commitStatus: 'existing',
      replayStatus: 'existing',
      sqliteIntegrity: 'invalid',
      stageRemoved: false,
      tombstonePresent: false,
      retainedSnapshots: 3,
    },
    generatedAt: '2026-07-29T00:01:00.000Z',
  });
  assert.equal(report.qualification.passed, false);
  assert.match(
    report.qualification.violations.join('; '),
    /boot identity.*recovery outcome.*write amplification.*not reclaimed/,
  );
  assert.deepEqual(
    validateStorageIdentity(
      manifest(),
      identity('boot', 1, {
        architecture: 'x64',
        mountPath: '/data',
        filesystem: 'xfs',
        mountOptions: ['ro'],
        blockDevice: 'overlay',
      }),
      '/mnt/ql3-evidence',
    ),
    [
      'architecture did not match manifest',
      'dataPath was not the dedicated mount point',
      'filesystem did not match manifest',
      'dataPath was not mounted read-write',
      'block device identity was invalid',
    ],
  );
});
