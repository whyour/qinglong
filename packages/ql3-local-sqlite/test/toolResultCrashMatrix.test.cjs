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
} = require('./fixtures/toolResultCrashMatrixFixture.cjs');

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'toolResultCrashMatrixFixture.cjs',
);

test(
  'survives the Tool Result completion and key lifecycle crash matrix',
  { timeout: 180_000 },
  async (context) => {
    const reports = [];
    for (const profile of ['edge', 'standalone']) {
      for (const [pointName, point] of Object.entries(CRASH_POINTS)) {
        const directory = fs.mkdtempSync(
          path.join(os.tmpdir(), `ql3-tool-result-${profile}-`),
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
        assert.deepEqual(
          JSON.parse(fs.readFileSync(markerPath, 'utf8')),
          {
            schema: 'qinglong/sqlite-tool-result-crash-marker@v1',
            point: pointName,
            pid: JSON.parse(
              fs.readFileSync(markerPath, 'utf8'),
            ).pid,
          },
        );
        reports.push(
          await verifyScenario({
            databasePath,
            statePath,
            pointName,
          }),
        );
      }
    }
    assert.equal(reports.length, 20);
    assert.equal(
      reports.filter((report) => report.crashBeforeCommit).length,
      12,
    );
    assert.equal(
      reports.filter((report) => report.durableAfterCrash).length,
      8,
    );
    assert.deepEqual(
      [...new Set(reports.map((report) => report.journalMode))].sort(),
      ['delete', 'wal'],
    );
    assert.ok(
      reports.every((report) => report.integrityCheck === 'ok'),
    );
  },
);
