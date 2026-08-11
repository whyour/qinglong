const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  buildIdleEvidenceReport,
  normalizeIdleManifest,
  parseArguments,
  parseProcIo,
  parseProcStat,
  parseProcStatus,
  summarizeSnapshots,
  validateSnapshotSeries,
} = require('../../scripts/ql3-physical-edge-idle-sampler.cjs');

function manifest(overrides = {}) {
  return normalizeIdleManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_idle_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    processId: 123,
    expectedExecutable: '/usr/bin/node',
    durationSeconds: 30,
    sampleIntervalMs: 10_000,
    ...overrides,
  });
}

function snapshot(index, overrides = {}) {
  return {
    monotonicMs: index * 10_000,
    wallTimeMs: 1_700_000_000_000 + index * 10_000,
    bootId: '019f0000-0000-7000-8000-000000000001',
    executable: '/usr/bin/node',
    commandSha256: 'a'.repeat(64),
    processId: 123,
    state: 'S',
    uid: 1000,
    startTicks: 100,
    minorFaults: 10 + index,
    majorFaults: index,
    userTicks: 20 + index,
    systemTicks: 5 + index,
    threadCount: 4,
    rssPages: 1000 + index,
    rssBytes: (40 + index) * 1024 * 1024,
    voluntaryContextSwitches: 100 + index * 2,
    involuntaryContextSwitches: 5 + index,
    readBytes: 4096 + index * 4096,
    writeBytes: 8192 + index * 8192,
    readSyscalls: 10 + index,
    writeSyscalls: 20 + index,
    ...overrides,
  };
}

test('normalizes one bounded idle sampling manifest', () => {
  assert.deepEqual(manifest(), {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_idle_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    processId: 123,
    expectedExecutable: '/usr/bin/node',
    durationSeconds: 30,
    sampleIntervalMs: 10_000,
  });
  assert.throws(
    () => manifest({ durationSeconds: 29 }),
    /durationSeconds must be between 30 and 3600/,
  );
  assert.throws(
    () => manifest({ sampleIntervalMs: 7000 }),
    /sampleIntervalMs must divide the duration/,
  );
  assert.throws(() => manifest({ extra: true }), /keys must be exactly/);
});

test('parses Linux proc stat, status and I/O without exposing command text', () => {
  const stat = parseProcStat(
    '123 (qinglong worker) S 1 123 123 0 -1 4194560 10 0 2 0 20 5 0 0 20 0 4 0 100 1000000 1000 0',
  );
  assert.deepEqual(stat, {
    processId: 123,
    state: 'S',
    minorFaults: 10,
    majorFaults: 2,
    userTicks: 20,
    systemTicks: 5,
    threadCount: 4,
    startTicks: 100,
    rssPages: 1000,
  });
  assert.deepEqual(
    parseProcStatus(
      'Uid:\t1000\t1000\t1000\t1000\nVmRSS:\t40960 kB\nThreads:\t4\nvoluntary_ctxt_switches:\t10\nnonvoluntary_ctxt_switches:\t2\n',
    ),
    {
      uid: 1000,
      rssBytes: 40 * 1024 * 1024,
      threadCount: 4,
      voluntaryContextSwitches: 10,
      involuntaryContextSwitches: 2,
    },
  );
  assert.deepEqual(
    parseProcIo('syscr: 10\nsyscw: 20\nread_bytes: 4096\nwrite_bytes: 8192\n'),
    {
      readBytes: 4096,
      writeBytes: 8192,
      readSyscalls: 10,
      writeSyscalls: 20,
    },
  );
});

test('summarizes bounded process deltas and RSS percentiles', () => {
  const samples = [0, 1, 2, 3].map((index) => snapshot(index));
  const violations = [];
  assert.deepEqual(summarizeSnapshots(samples, violations), {
    sampleCount: 4,
    actualDurationMs: 30_000,
    rssBytes: {
      minimum: 40 * 1024 * 1024,
      p50: 41 * 1024 * 1024,
      p95: 43 * 1024 * 1024,
      maximum: 43 * 1024 * 1024,
      final: 43 * 1024 * 1024,
    },
    threadCountMaximum: 4,
    cpuTicks: { user: 3, system: 3 },
    faults: { minor: 3, major: 3 },
    contextSwitches: { voluntary: 6, involuntary: 3 },
    io: {
      readBytes: 12_288,
      writeBytes: 24_576,
      readSyscalls: 3,
      writeSyscalls: 3,
    },
  });
  assert.deepEqual(violations, []);
});

test('fails closed when the sampled process or boot generation changes', () => {
  const samples = [
    snapshot(0),
    snapshot(1, { startTicks: 101, commandSha256: 'b'.repeat(64) }),
    snapshot(2, { bootId: 'different', executable: '/tmp/node' }),
    snapshot(3, { state: 'Z' }),
  ];
  assert.deepEqual(validateSnapshotSeries(manifest(), samples), [
    'sample 1 process generation changed',
    'sample 1 command identity changed',
    'sample 2 executable changed',
    'sample 2 boot identity changed',
    'sample 3 process was not live',
  ]);
});

test('builds digest-bound candidate evidence without overstating wakeups', () => {
  const report = buildIdleEvidenceReport({
    manifest: manifest(),
    snapshots: [0, 1, 2, 3].map((index) => snapshot(index)),
    generatedAt: '2026-07-22T00:00:00.000Z',
  });
  assert.equal(report.supported, false);
  assert.equal(report.qualification.passed, true);
  assert.ok(
    report.qualification.doesNotProve.includes('whole_device_cpu_wakeups'),
  );
  assert.equal(report.sha256.length, 64);
});

test('requires durable absolute manifest and output paths', () => {
  assert.deepEqual(
    parseArguments([
      '--',
      '--manifest=/etc/qinglong/idle.json',
      '--output=/var/lib/qinglong/evidence/idle.json',
      '--json',
    ]),
    {
      manifestPath: '/etc/qinglong/idle.json',
      outputPath: '/var/lib/qinglong/evidence/idle.json',
      json: true,
    },
  );
  assert.throws(
    () => parseArguments(['--manifest=idle.json', '--output=/tmp/out.json']),
    /manifestPath must be absolute/,
  );
});
