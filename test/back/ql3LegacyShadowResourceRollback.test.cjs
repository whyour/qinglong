const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const {
  EXCLUSIONS,
  MEASURES,
  PROFILES,
  parseArguments,
  percentile,
} = require('../../scripts/ql3-legacy-shadow-resource-rollback.cjs');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(
  REPOSITORY_ROOT,
  'scripts/ql3-legacy-shadow-resource-rollback.cjs',
);
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const RESOURCE_EVIDENCE_WATCHDOG_MS = 120_000;

function execute(profile, mode, samples) {
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      `--profile=${profile}`,
      `--mode=${mode}`,
      `--samples=${samples}`,
      '--max-audit-p95-ms=10000',
      '--max-rss-delta-mb=512',
      '--json',
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      timeout: RESOURCE_EVIDENCE_WATCHDOG_MS,
      maxBuffer: 128 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('normalizes only bounded resource and rollback gate options', () => {
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  );
  const buildSource = fs.readFileSync(
    path.join(REPOSITORY_ROOT, 'scripts/ql3-build-back.cjs'),
    'utf8',
  );
  assert.equal(
    packageManifest.scripts['build:back'],
    'node scripts/ql3-build-back.cjs',
  );
  assert.match(buildSource, /path\.join\(output, 'back'\)/);
  assert.match(buildSource, /fs\.renameSync\(compiledBackend, TARGET\)/);
  assert.match(buildSource, /rewriteSourceMaps\(maps\)/);
  assert.doesNotMatch(buildSource, /shell:\s*true/);
  assert.deepEqual(
    parseArguments([
      '--profile=standalone',
      '--mode=audit-only',
      '--samples=3',
      '--max-audit-p95-ms=2500',
      '--max-rss-delta-mb=48',
      '--require-compiled',
      '--json',
    ]),
    {
      profile: 'standalone',
      mode: 'audit-only',
      samples: 3,
      maxAuditP95Ms: 2_500,
      maxRssDeltaBytes: 48 * 1024 * 1024,
      requireCompiled: true,
      json: true,
    },
  );
  assert.throws(
    () => parseArguments(['--profile=cluster']),
    /profile must be edge or standalone/,
  );
  assert.throws(
    () => parseArguments(['--mode=rollback-only']),
    /mode must be audit-only or full/,
  );
  assert.throws(
    () => parseArguments(['--samples=33']),
    /samples must be between 1 and 32/,
  );
  assert.throws(
    () => parseArguments(['--database=/private/data.sqlite']),
    /unsupported argument/,
  );
  assert.equal(PROFILES.edge.candidates, 8);
  assert.equal(PROFILES.standalone.candidates, 128);
  assert.deepEqual(MEASURES.slice(0, 4), [
    'real_sequelize_sqlite_shadow_terminal_audit',
    'profile_maximum_closed_window_candidate_count',
    'bounded_candidate_and_evidence_query_count',
    'read_only_database_storage_stability',
  ]);
  assert.ok(EXCLUSIONS.includes('primary_execution_eligibility'));
});

test('calculates deterministic nearest-rank latency percentiles', () => {
  assert.equal(percentile([9, 1, 7, 3], 0.5), 3);
  assert.equal(percentile([9, 1, 7, 3], 0.95), 9);
});

test(
  'proves a real enabled-to-off process restart without stopping Legacy execution',
  { skip: NODE_MAJOR < 24 ? 'resource evidence requires Node 24' : false },
  () => {
    const report = execute('edge', 'full', 2);

    assert.equal(report.schemaVersion, 1);
    assert.equal(
      report.fixture,
      'qinglong/legacy-shadow-resource-rollback-evidence@v1',
    );
    assert.equal(report.profile, 'edge');
    assert.deepEqual(
      {
        mode: report.workload.mode,
        candidates: report.workload.candidates,
        pageSize: report.workload.pageSize,
        maxPages: report.workload.maxPages,
        samples: report.workload.samples,
      },
      { mode: 'full', candidates: 8, pageSize: 8, maxPages: 1, samples: 2 },
    );
    assert.ok(
      ['compiled_backend', 'typescript_fallback'].includes(
        report.workload.runtime,
      ),
    );
    assert.equal(report.audit.scanned, 16);
    assert.equal(report.audit.queryCount, 4);
    assert.equal(report.audit.expectedQueryCount, 4);
    assert.equal(report.audit.readOnlyStorageStable, true);
    assert.equal(report.rollback.performed, true);
    assert.deepEqual(report.rollback.enabled.configuredOrigins, ['system']);
    assert.equal(report.rollback.enabled.legacyExitCode, 0);
    assert.equal(report.rollback.enabled.runDelta, 1);
    assert.equal(report.rollback.enabled.defaultObserverLoaded, true);
    assert.equal(report.rollback.enabled.repositoryLoaded, true);
    assert.equal(report.rollback.enabled.capture.assessment, 'captured');
    assert.equal(report.rollback.enabled.capture.totals.admitted, 1);
    assert.equal(report.rollback.enabled.capture.totals.captured, 1);
    assert.equal(report.rollback.enabled.capture.totals.failed, 0);
    assert.equal(report.rollback.enabled.capture.totals.pending, 0);
    assert.equal(report.rollback.enabled.capture.byOrigin[0].origin, 'system');
    assert.deepEqual(report.rollback.off.configuredOrigins, []);
    assert.equal(report.rollback.off.legacyExitCode, 0);
    assert.equal(report.rollback.off.runDelta, 0);
    assert.equal(report.rollback.off.shortCircuitFactCalls, 0);
    assert.equal(report.rollback.off.defaultObserverLoaded, false);
    assert.equal(report.rollback.off.repositoryLoaded, false);
    assert.equal(report.rollback.legacyContinued, true);
    assert.equal(report.rollback.shadowWritesStopped, true);
    assert.equal(report.rollback.databaseIntegrity, 'ok');
    assert.equal(report.rollback.physicalPowerLossProven, false);
    assert.equal(report.qualification.passed, true);
    assert.deepEqual(report.qualification.violations, []);
    assert.deepEqual(report.qualification.measures, MEASURES);
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      'database.sqlite',
      'opaque-resource-rollback',
      'process.exit',
      'legacy-resource:',
      'resource/0.log',
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  },
);

test(
  'exercises the full Standalone page budget without claiming rollback twice',
  { skip: NODE_MAJOR < 24 ? 'resource evidence requires Node 24' : false },
  () => {
    const report = execute('standalone', 'audit-only', 1);

    assert.deepEqual(report.workload, {
      mode: 'audit-only',
      runtime: report.workload.runtime,
      candidates: 128,
      pageSize: 32,
      maxPages: 4,
      samples: 1,
    });
    assert.equal(report.audit.pages, 4);
    assert.equal(report.audit.scanned, 128);
    assert.equal(report.audit.queryCount, 8);
    assert.equal(report.audit.expectedQueryCount, 8);
    assert.equal(report.audit.readOnlyStorageStable, true);
    assert.deepEqual(report.rollback, {
      performed: false,
      reason: 'separate_release_gate',
      finalRunCount: 128,
      databaseIntegrity: 'ok',
    });
    assert.ok(
      report.qualification.doesNotProve.includes(
        'shadow_off_process_restart_rollback',
      ),
    );
    assert.equal(report.qualification.passed, true);
  },
);
