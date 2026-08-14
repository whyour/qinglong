const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  parseArguments,
  runBenchmark,
  validateReport,
} = require('../../scripts/ql3-plugin-package-recovery-edge-benchmark.cjs');

test('parses bounded failed-upgrade benchmark thresholds', () => {
  assert.deepEqual(
    parseArguments([
      '--json',
      '--max-duration-ms=5000',
      '--max-rss-delta-mb=64',
      '--max-database-growth-bytes=2097152',
    ]),
    {
      json: true,
      maxDatabaseGrowthBytes: 2 * 1024 * 1024,
      maxDurationMs: 5_000,
      maxRssDeltaBytes: 64 * 1024 * 1024,
    },
  );
  assert.throws(
    () => parseArguments(['--max-rss-delta-mb=0']),
    /positive number/,
  );
  assert.throws(() => parseArguments(['--unknown=1']), /unsupported argument/);
});

test('uses real SQLite recovery to reject an invalid upgrade before publication', async () => {
  const report = await runBenchmark({
    maxDatabaseGrowthBytes: 4 * 1024 * 1024,
    maxDurationMs: 10_000,
    maxRssDeltaBytes: 96 * 1024 * 1024,
  });

  assert.deepEqual(validateReport(report), []);
  assert.equal(report.durable.state, 'failed');
  assert.equal(report.durable.activeLockDigestPreserved, true);
  assert.equal(report.database.materializedCandidateRevisions, 0);
  assert.equal(report.calls.publisherPublish, 0);
  assert.equal(report.gates.passed, true);

  assert.deepEqual(validateReport({ ...report, supported: true }), [
    'report identity is invalid',
  ]);
});
