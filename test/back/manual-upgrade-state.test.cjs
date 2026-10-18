const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const {
  manualUpgradeFixture,
} = require('../helpers/manual-upgrade-fixture.cjs');
const jobs = require('../../cli/src/internal/maintenance/panelUpgrade.cjs');

for (const wrongVersion of [false, true]) {
  test(`Bash reload consumes offline readiness and records the actual result; wrong version=${wrongVersion}`, async (t) => {
    const f = await manualUpgradeFixture(t, wrongVersion);
    const operation = execute(
      process.execPath,
      [path.resolve('shell/upgrade.cjs'), 'reload'],
      { env: f.env, timeout: 15000 },
    );
    if (wrongVersion) await assert.rejects(operation, /启动版本与更新包不一致/);
    else await operation;
    const state = await f.state();
    assert.equal(state.status, wrongVersion ? 'failed' : 'completed');
    assert.equal(state.action, 'apply');
    assert.notEqual(state.id, 'offline-prepared');
    assert.equal(
      await fs.readFile(path.join(f.root, 'static/build/app.js'), 'utf8'),
      wrongVersion ? 'old backend' : 'new backend',
    );
    assert.equal(
      await fs.readFile(path.join(f.root, '.env'), 'utf8'),
      'preserve configuration',
    );
    assert.equal(
      await fs.readFile(path.join(f.root, 'data/keep'), 'utf8'),
      'preserve data',
    );
    if (wrongVersion)
      assert.equal(
        await fs.readFile(path.join(f.root, 'node_modules/old'), 'utf8'),
        'old dependency',
      );
    else
      await assert.rejects(
        fs.access(path.join(f.tmp, 'upgrade-ready-develop.json')),
      );
  });
}

test('manual application holds the launch lock and does not allow a competing panel job', async (t) => {
  const f = await manualUpgradeFixture(t);
  await assert.rejects(
    jobs.withPreparedJob(f.tmp, f.env, f.selected, async (job) => {
      assert.equal((await f.state()).status, 'running');
      await assert.rejects(
        jobs.startJob({ root: f.root, tmp: f.tmp, env: f.env }, 'apply'),
        /已有更新/,
      );
      await job.onStop();
      assert.equal((await f.state()).status, 'restarting');
      throw new Error('cancel manual operation');
    }),
    /cancel manual operation/,
  );
  assert.equal((await f.state()).status, 'failed');
  await assert.rejects(
    fs.access(path.join(f.tmp, 'panel-job-launch/upgrade.lock')),
  );
});
