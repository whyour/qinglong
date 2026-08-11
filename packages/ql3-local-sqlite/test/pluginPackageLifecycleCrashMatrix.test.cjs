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
} = require('./fixtures/pluginPackageLifecycleCrashMatrixFixture.cjs');

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'pluginPackageLifecycleCrashMatrixFixture.cjs',
);

test(
  'survives the Plugin Package lifecycle crash matrix',
  { timeout: 240_000 },
  async (context) => {
    const reports = [];
    for (const profile of ['edge', 'standalone']) {
      for (const action of ['disable', 'enable']) {
        for (const [pointName, point] of Object.entries(CRASH_POINTS)) {
          const directory = fs.mkdtempSync(
            path.join(
              os.tmpdir(),
              `ql3-package-lifecycle-${profile}-${action}-`,
            ),
          );
          context.after(() => {
            fs.rmSync(directory, { recursive: true, force: true });
          });
          const databasePath = path.join(directory, 'runtime.sqlite');
          const markerPath = path.join(directory, 'crash-marker.json');
          const event = await setupScenario({ action, databasePath, profile });
          const crashed = spawnSync(
            process.execPath,
            [
              FIXTURE_PATH,
              'crash',
              databasePath,
              markerPath,
              pointName,
              profile,
              action,
            ],
            { encoding: 'utf8', timeout: 30_000 },
          );
          assert.equal(
            crashed.error,
            undefined,
            `${profile}/${action}/${pointName}: ${crashed.error?.message}`,
          );
          assert.equal(
            crashed.signal,
            'SIGKILL',
            `${profile}/${action}/${pointName}: status=${crashed.status}, stderr=${crashed.stderr}`,
          );
          const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
          assert.deepEqual(marker, {
            schema:
              'qinglong/sqlite-plugin-package-lifecycle-crash-marker@v1',
            action,
            point: pointName,
            pid: marker.pid,
          });
          reports.push(
            await verifyScenario({
              action,
              databasePath,
              event,
              pointName,
              profile,
            }),
          );
          assert.equal(reports.at(-1).durableAfterCrash, point.durable);
        }
      }
    }
    assert.equal(reports.length, 32);
    assert.equal(
      reports.filter(({ crashBeforeCommit }) => crashBeforeCommit).length,
      28,
    );
    assert.equal(
      reports.filter(({ durableAfterCrash }) => durableAfterCrash).length,
      4,
    );
    assert.deepEqual(
      [...new Set(reports.map(({ journalMode }) => journalMode))].sort(),
      ['delete', 'wal'],
    );
    assert.ok(reports.every(({ synchronous }) => synchronous === 2));
    assert.ok(
      reports.every(
        ({ exactReplay, integrityCheck, foreignKeyCheck }) =>
          exactReplay &&
          integrityCheck === 'ok' &&
          foreignKeyCheck === 'ok',
      ),
    );
  },
);
