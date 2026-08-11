const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  SAMPLE_COUNTS,
  buildTaskScaleReport,
  fileUsage,
  normalizeTaskScaleManifest,
  parseArguments,
  scanDefinitions,
  taskCommand,
  validateObserved,
} = require('../../scripts/ql3-physical-edge-task-scale.cjs');
const {
  buildEvidenceReport,
  canonicalDigest,
  readTaskScaleEvidence,
  validateTaskScaleEvidenceReport,
  writeNoReplace,
} = require('../../scripts/ql3-physical-edge-evidence.cjs');

function manifest(overrides = {}) {
  return normalizeTaskScaleManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_task_scale_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    expectedArchitecture: 'arm64',
    expectedFilesystem: 'ext4',
    sampleCounts: [100, 1000, 10_000],
    ...overrides,
  });
}

function observed(overrides = {}) {
  return {
    platform: 'linux',
    architecture: 'arm64',
    node: 'v24.18.0',
    bootId: '019f0000-0000-7000-8000-000000000001',
    dataPath: '/opt/qinglong/data',
    dataFilesystem: 'ext4',
    dataMountOptions: ['rw', 'noatime'],
    totalMemoryBytes: 256 * 1024 * 1024,
    virtualizationIndicators: [],
    ...overrides,
  };
}

function workload() {
  return {
    migration: {
      durationMs: 10,
      contractVersion: 14,
      migrationCount: 28,
      storage: { logicalBytes: 4096, allocatedBytes: 4096, files: [] },
    },
    baselineRssBytes: 20_000_000,
    peakRssBytes: 30_000_000,
    cases: SAMPLE_COUNTS.map((count, index) => ({
      count,
      appended: [100, 900, 9000][index],
      appendDurationMs: count,
      cumulativeDurationMs: count,
      scan: {
        count,
        pages: Math.ceil(count / 256),
        durationMs: 1,
        identityDigest: 'a'.repeat(64),
      },
      storage: { logicalBytes: count, allocatedBytes: count, files: [] },
      rssBytes: 25_000_000,
      peakRssBytes: 30_000_000,
    })),
    finalStorage: { logicalBytes: 10_000, allocatedBytes: 12_288, files: [] },
  };
}

test('normalizes only the exact physical TaskDefinition scale manifest', () => {
  assert.deepEqual(manifest().sampleCounts, [100, 1000, 10_000]);
  assert.throws(
    () => manifest({ sampleCounts: [100, 1000] }),
    /exactly 100, 1000 and 10000/,
  );
  assert.throws(() => manifest({ extra: true }), /keys must be exactly/);
  assert.deepEqual(
    parseArguments([
      '--',
      '--manifest=/etc/ql3/task-scale.json',
      '--data-path=/opt/qinglong/data',
      '--output=/opt/qinglong/task-scale-evidence.json',
      '--json',
    ]),
    {
      manifestPath: '/etc/ql3/task-scale.json',
      dataPath: '/opt/qinglong/data',
      outputPath: '/opt/qinglong/task-scale-evidence.json',
      json: true,
    },
  );
  assert.throws(
    () =>
      parseArguments([
        '--manifest=relative.json',
        '--data-path=/data',
        '--output=/evidence.json',
      ]),
    /manifestPath must be absolute/,
  );
});

test('builds a digest-bound report without overstating scheduler evidence', () => {
  const report = buildTaskScaleReport({
    manifest: manifest(),
    observed: observed(),
    workload: workload(),
    generatedAt: '2026-07-22T00:00:00.000Z',
  });
  assert.equal(report.supported, false);
  assert.equal(report.qualification.passed, true);
  assert.ok(
    report.qualification.measures.includes(
      'formal_task_definition_repository_append',
    ),
  );
  assert.ok(
    report.qualification.measures.includes(
      'built_in_command_v1_semantic_validation',
    ),
  );
  assert.ok(
    report.qualification.doesNotProve.includes(
      'production_scheduler_throughput',
    ),
  );
  assert.equal(report.sha256.length, 64);
  assert.deepEqual(
    validateObserved(manifest(), observed({ dataFilesystem: 'overlay' })),
    ['filesystem did not match'],
  );
});

test('uses bounded repository pagination and stable TaskDefinition identities', async () => {
  const definitions = Array.from({ length: 300 }, (_, index) => ({
    taskId: `task-${String(index + 1).padStart(5, '0')}`,
    revision: 1,
  }));
  const repository = {
    async listTaskDefinitions({ limit, after }) {
      const start = after
        ? definitions.findIndex(({ taskId }) => taskId === after.taskId) + 1
        : 0;
      const page = definitions.slice(start, start + limit);
      const truncated = start + limit < definitions.length;
      return {
        definitions: page,
        truncated,
        ...(truncated ? { next: { taskId: page.at(-1).taskId } } : {}),
      };
    },
  };
  const result = await scanDefinitions(repository, 300);
  assert.equal(result.count, 300);
  assert.equal(result.pages, 2);
  assert.equal(result.identityDigest.length, 64);
  assert.equal(taskCommand(10_000).taskId, 'physical-task-10000');
  assert.deepEqual(taskCommand(10_000).spec.config.command, {
    kind: 'argv',
    file: '/bin/echo',
    args: ['10000'],
  });
});

test('reports logical and allocated bytes without following unrelated files', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-usage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'task-scale.sqlite');
  fs.writeFileSync(databasePath, Buffer.alloc(1024));
  fs.writeFileSync(`${databasePath}-journal`, Buffer.alloc(512));
  fs.writeFileSync(path.join(directory, 'unrelated'), Buffer.alloc(4096));
  const usage = fileUsage(databasePath);
  assert.equal(usage.logicalBytes, 1536);
  assert.deepEqual(
    usage.files.map(({ suffix }) => suffix),
    ['database', '-journal'],
  );
});

test('imports only private same-device TaskDefinition scale evidence', (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-scale-import-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scale = buildTaskScaleReport({
    manifest: manifest(),
    observed: observed(),
    workload: workload(),
    generatedAt: '2026-07-22T00:00:00.000Z',
  });
  const baseManifest = {
    deviceId: 'router-a1',
    deviceModel: 'Example Router A1',
    soc: 'Example SoC',
    storageMedium: 'emmc',
    profile: 'edge',
    expectedArchitecture: 'arm64',
    memoryBytes: {
      minimum: 240 * 1024 * 1024,
      maximum: 320 * 1024 * 1024,
    },
    expectedFilesystem: 'ext4',
  };
  assert.deepEqual(
    validateTaskScaleEvidenceReport(scale, baseManifest, observed()),
    [],
  );
  const evidencePath = path.join(directory, 'task-scale.json');
  writeNoReplace(evidencePath, `${JSON.stringify(scale)}\n`);
  assert.equal(
    readTaskScaleEvidence(evidencePath, baseManifest, observed()).sha256,
    scale.sha256,
  );
  const aggregate = buildEvidenceReport({
    manifest: baseManifest,
    observed: observed(),
    workloads: [],
    supplementalEvidence: [scale],
    generatedAt: '2026-07-22T00:01:00.000Z',
  });
  assert.ok(
    aggregate.qualification.collectedEvidence.includes(
      'task_definition_100_1000_10000_scaling',
    ),
  );
  assert.ok(
    !aggregate.qualification.remainingRequiredEvidence.includes(
      'task_definition_100_1000_10000_scaling',
    ),
  );
  const malformed = {
    ...scale,
    workload: { ...scale.workload, cases: null },
  };
  const { sha256: _sha256, ...malformedBody } = malformed;
  malformed.sha256 = canonicalDigest(malformedBody);
  assert.match(
    validateTaskScaleEvidenceReport(malformed, baseManifest, observed()).join(
      '; ',
    ),
    /cases are incomplete/,
  );
});
