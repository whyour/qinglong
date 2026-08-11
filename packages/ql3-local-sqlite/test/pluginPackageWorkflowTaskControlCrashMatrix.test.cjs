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
} = require('./fixtures/pluginPackageWorkflowTaskControlCrashMatrixFixture.cjs');

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'pluginPackageWorkflowTaskControlCrashMatrixFixture.cjs',
);

test(
  'survives Workflow Task conclusive-stop and control-terminal crash windows',
  { timeout: 180_000 },
  async (context) => {
    const reports = [];
    for (const profile of ['edge', 'standalone']) {
      for (const [pointName, point] of Object.entries(CRASH_POINTS)) {
        const directory = fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            `ql3-workflow-control-${profile}-${pointName}-`,
          ),
        );
        context.after(() => {
          fs.rmSync(directory, { recursive: true, force: true });
        });
        const databasePath = path.join(directory, 'runtime.sqlite');
        const markerPath = path.join(directory, 'crash-marker.json');
        await setupScenario({ databasePath, profile });
        const crashed = spawnSync(
          process.execPath,
          [FIXTURE_PATH, 'crash', databasePath, markerPath, pointName, profile],
          { encoding: 'utf8', timeout: 30_000 },
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
          schema:
            'qinglong/sqlite-plugin-package-workflow-task-control-crash-marker@v1',
          point: pointName,
          conclusiveStopObserved: true,
          pid: marker.pid,
        });
        const report = await verifyScenario({
          databasePath,
          pointName,
          profile,
        });
        assert.equal(report.durableAfterCrash, point.durable);
        reports.push(report);
      }
    }
    assert.equal(reports.length, 16);
    assert.equal(
      reports.filter(({ crashBeforeCommit }) => crashBeforeCommit).length,
      14,
    );
    assert.equal(
      reports.filter(({ durableAfterCrash }) => durableAfterCrash).length,
      2,
    );
    assert.deepEqual(
      [...new Set(reports.map(({ journalMode }) => journalMode))].sort(),
      ['delete', 'wal'],
    );
    assert.ok(
      reports.every(
        ({
          crashAfterConclusiveStop,
          exactTerminalReplay,
          parentConverged,
          integrityCheck,
          foreignKeyCheck,
        }) =>
          crashAfterConclusiveStop &&
          exactTerminalReplay &&
          parentConverged &&
          integrityCheck === 'ok' &&
          foreignKeyCheck === 'ok',
      ),
    );
  },
);
