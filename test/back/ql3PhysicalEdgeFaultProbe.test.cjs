const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildFaultEvidenceReport,
  normalizeFaultManifest,
  parseArguments,
  validateFaultEnvelope,
} = require('../../scripts/ql3-physical-edge-fault-probe.cjs');

function manifest(fault, overrides = {}) {
  return normalizeFaultManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_fault_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    fault,
    probePath: '/mnt/ql3-fault',
    expectedFilesystem: 'ext4',
    maximumFilesystemBytes: 64 * 1024 * 1024,
    ...overrides,
  });
}

function observed(overrides = {}) {
  return {
    platform: 'linux',
    architecture: 'arm64',
    node: 'v24.18.0',
    bootId: '019f0000-0000-7000-8000-000000000001',
    processUid: 1000,
    probePath: '/mnt/ql3-fault',
    mountPath: '/mnt/ql3-fault',
    filesystem: 'ext4',
    mountOptions: ['rw', 'nosuid', 'nodev'],
    totalBytes: 32 * 1024 * 1024,
    availableBytes: 0,
    expectedErrorCode: 'ENOSPC',
    probeEntryCreated: false,
    probeEntryRemained: false,
    ...overrides,
  };
}

test('normalizes only bounded dedicated fault filesystem manifests', () => {
  assert.equal(manifest('enospc_filesystem').fault, 'enospc_filesystem');
  assert.throws(() => manifest('disk_full'), /fault must be one of/);
  assert.throws(
    () => manifest('enospc_filesystem', { probePath: '/' }),
    /absolute non-root path/,
  );
  assert.throws(
    () =>
      manifest('enospc_filesystem', {
        maximumFilesystemBytes: 257 * 1024 * 1024,
      }),
    /between 1 and 256 MiB/,
  );
  assert.throws(
    () => manifest('enospc_filesystem', { extra: true }),
    /keys must be exactly/,
  );
});

test('accepts exact non-root ENOSPC and read-only errno evidence', () => {
  assert.deepEqual(
    validateFaultEnvelope(manifest('enospc_filesystem'), observed()),
    [],
  );
  assert.deepEqual(
    validateFaultEnvelope(
      manifest('read_only_filesystem'),
      observed({
        mountOptions: ['ro', 'nosuid', 'nodev'],
        availableBytes: 8 * 1024 * 1024,
        expectedErrorCode: 'EROFS',
      }),
    ),
    [],
  );
});

test('fails widened mounts, capacity, root and wrong errno', () => {
  assert.deepEqual(
    validateFaultEnvelope(
      manifest('enospc_filesystem'),
      observed({
        mountPath: '/',
        filesystem: 'tmpfs',
        totalBytes: 128 * 1024 * 1024,
        availableBytes: 4096,
        processUid: 0,
        expectedErrorCode: 'EACCES',
        probeEntryRemained: true,
      }),
    ),
    [
      'probe path must be a dedicated mount point',
      'filesystem tmpfs did not equal ext4',
      'fault filesystem exceeded its declared capacity',
      'fault filesystem still had available blocks',
      'ENOSPC probe must run as non-root',
      'write probe did not return ENOSPC',
      'fault probe entry was not cleaned up',
    ],
  );
});

test('builds digest-bound candidate evidence with explicit exclusions', () => {
  const report = buildFaultEvidenceReport({
    manifest: manifest('read_only_filesystem'),
    observed: observed({
      mountOptions: ['ro'],
      expectedErrorCode: 'EROFS',
    }),
    generatedAt: '2026-07-22T00:00:00.000Z',
  });
  assert.equal(report.supported, false);
  assert.equal(report.qualification.passed, true);
  assert.ok(
    report.qualification.doesNotProve.includes('application_level_recovery'),
  );
  assert.equal(report.sha256.length, 64);
});

test('requires absolute durable manifest and output paths', () => {
  assert.deepEqual(
    parseArguments([
      '--',
      '--manifest=/etc/qinglong/enospc.json',
      '--output=/var/lib/qinglong/evidence/enospc.json',
      '--json',
    ]),
    {
      manifestPath: '/etc/qinglong/enospc.json',
      outputPath: '/var/lib/qinglong/evidence/enospc.json',
      json: true,
    },
  );
  assert.throws(
    () => parseArguments(['--manifest=fault.json', '--output=/tmp/out.json']),
    /manifestPath must be absolute/,
  );
});
