const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MAX_REVIEW_BYTES,
  ROW_COUNT,
  buildReport,
  commandFixture,
  normalizeManifest,
  parseArguments,
  validateReport,
} = require('../../scripts/ql3-physical-edge-adoption-scale.cjs');

function manifest(overrides = {}) {
  return normalizeManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_adoption_scale_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    expectedArchitecture: 'arm64',
    expectedFilesystem: 'ext4',
    rowCount: 100_000,
    maxReviewFileBytes: 32 * 1024 * 1024,
    ...overrides,
  });
}

function command(operation, options) {
  return { schemaVersion: 1, operation, options };
}

function storage() {
  return { logicalBytes: 4096, allocatedBytes: 4096, files: [] };
}

test('fixes the physical adoption workload at 100000 reviewed rows', () => {
  assert.equal(manifest().rowCount, ROW_COUNT);
  assert.equal(manifest().maxReviewFileBytes, MAX_REVIEW_BYTES);
  assert.throws(() => manifest({ rowCount: 10_000 }), /fixed workload/);
  assert.deepEqual(
    parseArguments([
      '--manifest=/data/manifest.json',
      '--data-path=/data',
      '--issue-command=/data/issue.json',
      '--commit-command=/data/commit.json',
      '--output=/data/report.json',
      '--json',
    ]),
    {
      manifestPath: '/data/manifest.json',
      dataPath: '/data',
      issueCommandPath: '/data/issue.json',
      commitCommandPath: '/data/commit.json',
      outputPath: '/data/report.json',
      json: true,
    },
  );
});

test('accepts only one contained issue and commit command pair', () => {
  const shared = {
    deploymentRoot: '/data/adoption',
    profile: 'edge',
    sourcePath: '/data/adoption/legacy.sqlite',
    authorizationPath: '/data/adoption/authorization.ndjson',
    credentialFilePath: '/data/adoption/credential.json',
    issuerKeyringPath: '/data/adoption/issuer.json',
    ownerPepperKeyringDirectory: '/data/adoption/pepper',
    expectedPlanDigest: 'a'.repeat(64),
  };
  const issue = command('legacy-crontab.decision.issue', {
    ...shared,
    databasePath: '/data/adoption/target.sqlite',
    reviewFilePath: '/data/adoption/review.ndjson',
    decisionId: '019a2b3c-4d5e-7f60-8123-456789abcdef',
  });
  const commit = command('legacy-crontab.adoption.commit', {
    ...shared,
    targetPath: '/data/adoption/target.sqlite',
    expectedDecisionId: issue.options.decisionId,
  });
  assert.equal(
    commandFixture(issue, commit, '/data').targetPath,
    '/data/adoption/target.sqlite',
  );
  assert.throws(
    () =>
      commandFixture(
        issue,
        {
          ...commit,
          options: { ...commit.options, sourcePath: '/tmp/other.sqlite' },
        },
        '/data',
      ),
    /do not describe one adoption/,
  );
});

test('builds digest-bound evidence without overstating flash or power loss', () => {
  const measurement = {
    durationMs: 100,
    peakRssBytes: 30_000_000,
    sampleCount: 10,
    readBytes: 4096,
    writeBytes: 8192,
    cancelledWriteBytes: 0,
    exitCode: 0,
  };
  const report = buildReport({
    manifest: manifest(),
    observed: {
      platform: 'linux',
      architecture: 'arm64',
      node: 'v24.18.0',
      bootId: 'boot-a',
      dataPath: '/data',
      dataFilesystem: 'ext4',
      dataMountOptions: ['rw'],
      virtualizationIndicators: [],
    },
    preflight: {
      sourceRowCount: 100_000,
      reviewFileBytes: 20_000_000,
      targetLedgerCount: 0,
      targetStorage: storage(),
    },
    issue: measurement,
    commit: measurement,
    final: {
      ledgerCount: 1,
      adoptedTaskCount: 100_000,
      adoptedTriggerCount: 100_000,
      targetStorage: storage(),
    },
    generatedAt: '2026-07-22T00:00:00.000Z',
  });
  assert.equal(report.qualification.passed, true);
  assert.equal(report.supported, false);
  assert.equal(report.sha256.length, 64);
  assert.ok(
    report.qualification.doesNotProve.includes(
      'whole_device_flash_or_nand_write_amplification',
    ),
  );
  assert.deepEqual(
    validateReport(report, manifest(), {
      architecture: 'arm64',
      bootId: 'boot-a',
      dataPath: '/data',
      dataFilesystem: 'ext4',
      dataMountOptions: ['rw'],
    }),
    [],
  );
  const tamperedBody = {
    ...report,
    workload: {
      ...report.workload,
      widened: true,
    },
  };
  const { sha256: _sha256, ...body } = tamperedBody;
  const tampered = {
    ...body,
    sha256: require('node:crypto')
      .createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex'),
  };
  assert.match(
    validateReport(tampered, manifest(), {
      architecture: 'arm64',
      bootId: 'boot-a',
      dataPath: '/data',
      dataFilesystem: 'ext4',
      dataMountOptions: ['rw'],
    }).join('; '),
    /incomplete/,
  );
});
