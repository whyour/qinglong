const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const {
  CRASH_POINTS,
  setupScenario,
  verifyScenario,
} = require('./fixtures/pluginPackagePromptCrashFixture.cjs');

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'pluginPackagePromptCrashFixture.cjs',
);

test(
  'survives the SQLite Package Prompt admission and finalization crash matrix',
  { timeout: 180_000 },
  async (context) => {
    const reports = [];
    for (const profile of ['edge', 'standalone']) {
      for (const [pointName, point] of Object.entries(CRASH_POINTS)) {
        const directory = fs.mkdtempSync(
          path.join(os.tmpdir(), `ql3-package-prompt-${profile}-`),
        );
        context.after(() => {
          fs.rmSync(directory, { recursive: true, force: true });
        });
        const databasePath = path.join(directory, 'runtime.sqlite');
        const statePath = path.join(directory, 'state.json');
        const markerPath = path.join(directory, 'crash-marker.json');
        await setupScenario({
          databasePath,
          statePath,
          profile,
          operation: point.operation,
        });
        const crashed = spawnSync(
          process.execPath,
          [
            FIXTURE_PATH,
            'crash',
            databasePath,
            statePath,
            markerPath,
            pointName,
          ],
          {
            encoding: 'utf8',
            timeout: 30_000,
          },
        );
        assert.equal(
          crashed.error,
          undefined,
          `${profile}/${pointName}: ${crashed.error?.message}`,
        );
        assert.equal(
          crashed.signal,
          'SIGKILL',
          `${profile}/${pointName}: status=${crashed.status}, stderr=${crashed.stderr}`,
        );
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        assert.deepEqual(marker, {
          schema: 'qinglong/sqlite-plugin-package-prompt-crash-marker@v1',
          point: pointName,
          pid: marker.pid,
        });
        reports.push(
          await verifyScenario({ databasePath, statePath, pointName }),
        );
      }
    }

    assert.equal(reports.length, 20);
    assert.equal(
      reports.filter((report) => report.operation === 'admission').length,
      10,
    );
    assert.equal(
      reports.filter((report) => report.operation === 'finalization').length,
      10,
    );
    assert.equal(
      reports.filter((report) => report.crashBeforeCommit).length,
      16,
    );
    assert.equal(
      reports.filter((report) => report.durableAfterCrash).length,
      4,
    );
    assert.deepEqual(
      [...new Set(reports.map((report) => report.journalMode))].sort(),
      ['delete', 'wal'],
    );
    assert.ok(reports.every((report) => report.integrityCheck === 'ok'));
    assert.ok(reports.every((report) => report.foreignKeyCheck === 'ok'));
    assert.ok(reports.every((report) => report.exactReplay));
    assert.ok(reports.every((report) => report.contentFree));
    assert.ok(reports.every((report) => !report.physicalPowerLossProven));
    context.diagnostic(
      `QL3_RESOURCE_EVIDENCE=${JSON.stringify({
        schemaVersion: 1,
        workload: 'plugin_package_prompt_outer_transaction_crash_matrix',
        profiles: ['edge', 'standalone'],
        operations: ['admission', 'finalization'],
        crashPointsPerProfile: 10,
        scenarios: reports.length,
        crashBeforeCommit: 16,
        durableAfterCrash: 4,
        exactReplay: true,
        contentFree: true,
        integrityCheck: 'ok',
        foreignKeyCheck: 'ok',
        promptAdmissionFinalizationCrashProven: true,
        physicalPowerLossProven: false,
      })}`,
    );
  },
);
