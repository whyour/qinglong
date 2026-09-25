const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createContext } = require('../../dist/local/context');
const { startPanel, stopPanel } = require('../../dist/local/operator');
const { runProcess } = require('../../dist/local/process');

test(
  'interrupted replacement stops the real new service and restores the old HTTP backend',
  { timeout: 60000 },
  async (t) => {
    for (const manager of ['node', 'pm2']) {
      await t.test(manager, async (t) => {
        const root = await fs.mkdtemp(
          path.join(os.tmpdir(), 'ql-upgrade-real-'),
        );
        const env = {
          ...process.env,
          TEST_ROOT: root,
          QL_DIR: root,
          HOME: root,
          PM2_HOME: path.join(root, 'pm2'),
          PATH: manager === 'node' ? '/nonexistent' : process.env.PATH,
        };
        const context = createContext({ root }, env);
        let child;
        t.after(async () => {
          if (child && child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL');
          await stopPanel(context);
          if (manager === 'pm2')
            await runProcess('pm2', ['kill'], {
              env,
              output: () => {},
              timeoutMs: 10000,
            });
          await fs.rm(root, { recursive: true, force: true });
        });
        for (const [directory, version] of [
          ['static', 'old'],
          ['staged', 'new'],
        ]) {
          await fs.mkdir(path.join(root, directory, 'build'), {
            recursive: true,
          });
          await fs.writeFile(
            path.join(root, directory, 'build/app.js'),
            `require('http').createServer((q,s)=>s.end(JSON.stringify({version:'${version}',pid:process.pid}))).listen(5811,'127.0.0.1')`,
          );
        }
        await fs.writeFile(
          path.join(root, 'ecosystem.config.js'),
          'module.exports={apps:[{name:"upgrade-fixture",script:"static/build/app.js",exec_mode:"fork",instances:1}]}',
        );
        assert.equal((await startPanel(context)).manager, manager);
        const old = await require('./service-response.cjs')('old');
        assert.equal(old.version, 'old');
        child = fork(path.join(__dirname, 'interrupted-reload.cjs'), [], {
          env,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let diagnostics = '';
        child.stdout.on('data', (chunk) => (diagnostics += chunk));
        child.stderr.on('data', (chunk) => (diagnostics += chunk));
        const closed = new Promise((resolve) =>
          child.on('close', (code, signal) => resolve({ code, signal })),
        );
        const ready = await Promise.race([
          new Promise((resolve) => child.once('message', resolve)),
          closed.then((result) => {
            throw new Error(
              `Premature exit ${JSON.stringify(result)}: ${diagnostics}`,
            );
          }),
        ]);
        assert.equal(ready.ready, true);
        assert.notEqual(ready.pid, old.pid);
        child.kill('SIGTERM');
        assert.deepEqual(
          await closed,
          { code: 143, signal: null },
          diagnostics,
        );
        const restored = await require('./service-response.cjs')('old');
        assert.equal(restored.version, 'old');
        assert.notEqual(restored.pid, ready.pid);
        assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' });
        assert.match(
          await fs.readFile(path.join(root, 'static/build/app.js'), 'utf8'),
          /version:'old'/,
        );
        assert.ok(
          !(await fs.readdir(root)).some((name) => name.includes('ql-backup')),
        );
      });
    }
  },
);
