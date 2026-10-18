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

for (const previousStatus of ['ready', 'failed', 'completed', 'idle', 'absent'])
  for (const wrongVersion of [false, true])
    test(`manual application records the selected package after ${previousStatus}; wrong version=${wrongVersion}`, async (t) => {
      const f = await manualUpgradeFixture(t, wrongVersion);
      await fs.writeFile(
        path.join(f.root, 'package.json'),
        '{"qinglongUpgradeFormat":2}',
      );
      const file = path.join(f.tmp, 'panel-upgrade.json');
      if (previousStatus === 'absent') await fs.unlink(file);
      else
        await fs.writeFile(
          file,
          JSON.stringify({
            ...(await f.state()),
            status: previousStatus,
            error: 'previous preparation failed',
            version: '9.9.9',
            sourceCommit: 'f'.repeat(40),
            backendSha256: 'f'.repeat(64),
            stageDirectory: 'upgrade-other',
          }),
        );
      const operation = execute(
        process.execPath,
        [path.resolve('shell/upgrade.cjs'), 'reload'],
        { env: f.env, timeout: 15000 },
      );
      if (wrongVersion)
        await assert.rejects(operation, /启动版本与更新包不一致/);
      else await operation;
      const state = await f.state();
      assert.equal(state.status, wrongVersion ? 'failed' : 'completed');
      assert.equal(state.sourceCommit, f.expected.sourceCommit);
      assert.equal(state.stageDirectory, f.expected.stageDirectory);
      assert.equal(state.version, f.expected.version);
      assert.notEqual(state.id, 'offline-prepared');
      assert.equal(state.action, 'apply');
      assert.notEqual(state.error, 'previous preparation failed');
      if (!wrongVersion) assert.equal(state.error, undefined);
      assert.equal(
        await fs.readFile(path.join(f.root, 'static/build/app.js'), 'utf8'),
        wrongVersion ? 'old backend' : 'new backend',
      );
      assert.equal(
        await fs.readFile(path.join(f.root, 'data/keep'), 'utf8'),
        'preserve data',
      );
    });

test('manual application rejects a selection that no longer matches the ready pointer', async (t) => {
  const f = await manualUpgradeFixture(t);
  let called = false;
  await assert.rejects(
    jobs.withPreparedJob(
      f.tmp,
      f.env,
      { ...f.selected, source: f.selected.source + '-stale' },
      async () => {
        called = true;
      },
    ),
    /暂存更新已变化/,
  );
  assert.equal(called, false);
  assert.equal((await f.state()).status, 'ready');
});

test('legacy manual reload without a job or bundle capability stays self-contained', async (t) => {
  const f = await manualUpgradeFixture(t);
  await fs.unlink(path.join(f.tmp, 'panel-upgrade.json'));
  await fs.unlink(path.join(f.tmp, 'upgrade-ready-develop.json'));
  const result = await jobs.withPreparedJob(
    f.tmp,
    f.env,
    f.selected,
    async (job) => {
      assert.equal(job, undefined);
      return 'legacy';
    },
  );
  assert.equal(result, 'legacy');
  await assert.rejects(fs.access(path.join(f.tmp, 'panel-upgrade.json')), {
    code: 'ENOENT',
  });
});

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
