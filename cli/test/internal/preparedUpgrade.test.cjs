const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  manualUpgradeFixture,
} = require('../../../test/helpers/manual-upgrade-fixture.cjs');
const { createContext } = require('../../dist/internal/runtime/context');
const { reloadPanel } = require('../../dist/internal/maintenance/upgrade');
const operator = require('../../dist/internal/maintenance/operator');
const artifacts = require('../../dist/internal/maintenance/upgradeArtifacts.cjs');

for (const status of ['ready', 'failed', 'completed', 'absent'])
  for (const wrongVersion of [false, true])
    test(`CLI validates and records manual reload after ${status}; wrong version=${wrongVersion}`, async (t) => {
      const f = await manualUpgradeFixture(t, wrongVersion);
      await fs.writeFile(
        path.join(f.root, 'package.json'),
        '{"qinglongUpgradeFormat":2}',
      );
      const file = path.join(f.tmp, 'panel-upgrade.json');
      if (status === 'absent') await fs.unlink(file);
      else
        await fs.writeFile(
          file,
          JSON.stringify({
            ...(await f.state()),
            status,
            error: 'old error',
            version: '9.9.9',
            sourceCommit: 'f'.repeat(40),
          }),
        );
      t.mock.method(operator, 'stopPanel', async () => {});
      t.mock.method(operator, 'startPanel', async () => ({
        manager: 'fixture',
      }));
      t.mock.method(artifacts, 'waitForHealth', async () => {});
      const operation = reloadPanel(
        createContext({ root: f.root }, f.env),
        'system',
      );
      if (wrongVersion)
        await assert.rejects(operation, /启动版本与更新包不一致/);
      else await operation;
      const state = await f.state();
      assert.equal(state.status, wrongVersion ? 'failed' : 'completed');
      assert.equal(state.sourceCommit, f.expected.sourceCommit);
      assert.equal(state.version, f.expected.version);
      assert.notEqual(state.error, 'old error');
      assert.equal(
        await fs.readFile(path.join(f.root, 'static/build/app.js'), 'utf8'),
        wrongVersion ? 'old backend' : 'new backend',
      );
      assert.equal(
        await fs.readFile(path.join(f.root, 'data/keep'), 'utf8'),
        'preserve data',
      );
    });

for (const wrongVersion of [false, true]) {
  test(`operational CLI synchronizes prepared jobs and verifies startup before committing; wrong version=${wrongVersion}`, async (t) => {
    const f = await manualUpgradeFixture(t, wrongVersion);
    const context = createContext({ root: f.root }, f.env);
    const timeouts = [];
    t.mock.method(artifacts, 'waitForHealth', async (_env, timeout) => {
      timeouts.push(timeout);
    });
    t.mock.method(operator, 'stopPanel', async () => {
      assert.equal((await f.state()).status, 'restarting');
    });
    t.mock.method(operator, 'startPanel', async () => ({ manager: 'fixture' }));
    const operation = reloadPanel(context, 'system');
    if (wrongVersion) await assert.rejects(operation, /启动版本与更新包不一致/);
    else await operation;
    assert.ok(timeouts.length > 0);
    assert.ok(
      timeouts.every((timeout) => timeout === undefined),
      'use the shared ARMv6/default startup deadline',
    );
    assert.equal(
      (await f.state()).status,
      wrongVersion ? 'failed' : 'completed',
    );
    assert.equal(
      await fs.readFile(path.join(f.root, 'static/build/app.js'), 'utf8'),
      wrongVersion ? 'old backend' : 'new backend',
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
  });
}
