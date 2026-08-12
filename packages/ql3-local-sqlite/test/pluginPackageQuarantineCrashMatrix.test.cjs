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
} = require('./fixtures/pluginPackageQuarantineCrashMatrixFixture.cjs');

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'pluginPackageQuarantineCrashMatrixFixture.cjs',
);

test(
  'survives the Plugin Package quarantine withdrawal crash matrix',
  { timeout: 120_000 },
  async (context) => {
    const reports = [];
    for (const profile of ['edge', 'standalone']) {
      for (const [pointName, point] of Object.entries(CRASH_POINTS)) {
        const directory = fs.mkdtempSync(
          path.join(os.tmpdir(), `ql3-package-quarantine-${profile}-`),
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
          schema: 'qinglong/sqlite-plugin-package-quarantine-crash-marker@v1',
          point: pointName,
          pid: marker.pid,
        });
        reports.push(
          await verifyScenario({ databasePath, pointName, profile }),
        );
        assert.equal(reports.at(-1).durableAfterCrash, point.durable);
      }
    }
    assert.equal(reports.length, 12);
    assert.equal(
      reports.filter(({ crashBeforeCommit }) => crashBeforeCommit).length,
      10,
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
        ({ integrityCheck, foreignKeyCheck }) =>
          integrityCheck === 'ok' && foreignKeyCheck === 'ok',
      ),
    );
  },
);
