const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { registerHostServices } = require('../dist/local/hostServices');
const { createContext } = require('../dist/local/context');

for (const manager of ['openrc', 'systemd', 'missing']) {
  test(`host startup registration uses ${manager} and propagates service failures`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-host-services-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = path.join(root, 'calls');
    const programs =
      manager === 'openrc'
        ? ['rc-update', 'rc-service']
        : manager === 'systemd'
        ? ['apt-get', 'systemctl']
        : [];
    for (const program of [...programs, 'sudo'])
      await fs.writeFile(
        path.join(root, program),
        `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');let program=path.basename(process.argv[1]),args=process.argv.slice(2);if(program==='sudo')program=args.shift();fs.appendFileSync(process.env.CALLS,JSON.stringify([program,...args])+'\\n');if(process.env.FAIL===program)process.exit(9);`,
        { mode: 0o755 },
      );
    const context = createContext({ root }, { PATH: root, CALLS: calls });
    if (manager === 'missing') {
      await assert.rejects(
        registerHostServices(context, 'alpine'),
        (error) => error.exitCode === 2,
      );
      await assert.rejects(fs.stat(calls), { code: 'ENOENT' });
      return;
    }
    await registerHostServices(
      context,
      manager === 'openrc' ? 'alpine' : 'debian',
    );
    const actual = (await fs.readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(
      actual,
      manager === 'openrc'
        ? [
            ['rc-update', 'add', 'nginx', 'default'],
            ['rc-update', 'add', 'crond', 'default'],
            ['rc-service', 'crond', 'start'],
          ]
        : [
            ['apt-get', 'install', '-y', 'cron'],
            ['systemctl', 'enable', 'nginx'],
            ['systemctl', 'enable', '--now', 'cron'],
          ],
    );
    await fs.writeFile(calls, '');
    context.env.FAIL = manager === 'openrc' ? 'rc-service' : 'apt-get';
    await assert.rejects(
      registerHostServices(context, manager === 'openrc' ? 'alpine' : 'ubuntu'),
    );
    const failed = (await fs.readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(
      failed.length,
      manager === 'openrc' ? 3 : 1,
      'failure must stop subsequent actions',
    );
  });
}
