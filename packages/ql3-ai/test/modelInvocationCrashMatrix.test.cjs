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
} = require('./fixtures/modelInvocationCrashFixture.cjs');

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'modelInvocationCrashFixture.cjs',
);

test(
  'survives the SQLite ModelInvocation start and completion crash matrix',
  { timeout: 120_000 },
  async (context) => {
    const reports = [];
    for (const profile of ['edge', 'standalone']) {
      for (const [pointName, point] of Object.entries(CRASH_POINTS)) {
        const directory = fs.mkdtempSync(
          path.join(os.tmpdir(), `ql3-model-invocation-${profile}-`),
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
            timeout: 20_000,
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
          schema: 'qinglong/sqlite-model-invocation-crash-marker@v1',
          point: pointName,
          pid: marker.pid,
        });
        reports.push(
          await verifyScenario({ databasePath, statePath, pointName }),
        );
      }
    }
    assert.equal(reports.length, 14);
    assert.equal(
      reports.filter((report) => report.crashBeforeCommit).length,
      10,
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
  },
);
