const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  manualUpgradeFixture,
} = require('../helpers/manual-upgrade-fixture.cjs');
const artifacts = require('../../cli/src/internal/maintenance/upgradeArtifacts.cjs');
const { installBundle } = require('../../shell/install-bundle.cjs');

for (const scenario of ['cancel-new-start', 'both-starts-fail'])
  test(`offline application restores files and records failure: ${scenario}`, async (t) => {
    const f = await manualUpgradeFixture(t);
    t.mock.method(artifacts, 'stageUpgrade', async () => f.selected);
    const journal = path.join(f.root, 'lifecycle.jsonl');
    await fs.writeFile(
      path.join(f.root, 'lifecycle.cjs'),
      `
      const fs=require('node:fs'),path=require('node:path');
      const root=process.env.QL_DIR,op=process.argv[2];
      const version=fs.readFileSync(path.join(root,'static/build/app.js'),'utf8');
      fs.appendFileSync(${JSON.stringify(
        journal,
      )},JSON.stringify({op,version})+'\\n');
      if(op==='start') {
        if(${JSON.stringify(scenario)}==='both-starts-fail') process.exit(9);
        if(version==='new backend') {
          process.kill(Number(process.env.TEST_INSTALLER_PID),'SIGTERM');
          setTimeout(()=>{},10000);
        }
      }
    `,
    );
    await fs.writeFile(
      path.join(f.root, 'shell/share.sh'),
      `
      import_config(){ :; }
      delete_pm2(){ "$TEST_NODE" "$QL_DIR/lifecycle.cjs" stop; }
      reload_pm2(){ "$TEST_NODE" "$QL_DIR/lifecycle.cjs" start; }
    `,
    );
    await assert.rejects(
      installBundle(
        ['--root', f.root, '--file', path.join(f.root, 'unused.tar.gz')],
        {
          ...f.env,
          TEST_NODE: process.execPath,
          TEST_INSTALLER_PID: String(process.pid),
        },
      ),
      scenario === 'cancel-new-start' ? /离线升级已中断/ : /failed/,
    );
    const calls = (await fs.readFile(journal, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(calls, [
      { op: 'stop', version: 'old backend' },
      { op: 'start', version: 'new backend' },
      { op: 'stop', version: 'new backend' },
      { op: 'start', version: 'old backend' },
    ]);
    assert.equal((await f.state()).status, 'failed');
    assert.equal(
      await fs.readFile(path.join(f.root, 'static/build/app.js'), 'utf8'),
      'old backend',
    );
    assert.equal(
      await fs.readFile(path.join(f.root, 'node_modules/old'), 'utf8'),
      'old dependency',
    );
    assert.equal(
      await fs.readFile(path.join(f.root, '.env'), 'utf8'),
      'preserve configuration',
    );
    assert.equal(
      await fs.readFile(path.join(f.root, 'data/keep'), 'utf8'),
      'preserve data',
    );
    await fs.access(path.join(f.tmp, 'upgrade-ready-develop.json'));
    await assert.rejects(fs.access(path.join(f.tmp, 'upgrade.lock')), {
      code: 'ENOENT',
    });
    await assert.rejects(
      fs.access(path.join(f.tmp, 'panel-job-launch/upgrade.lock')),
      { code: 'ENOENT' },
    );
    assert.ok(
      !(await fs.readdir(f.root)).some((n) => n.includes('.ql-backup-')),
    );
  });
