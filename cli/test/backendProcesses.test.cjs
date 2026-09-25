const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { findDirectBackendPids } = require('../dist/local/backendProcesses');

test('Linux backend discovery scopes legacy relative and absolute commands to one installation', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql-proc-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const proc = path.join(root, 'proc');
  const panel = path.join(root, 'panel with spaces'),
    other = path.join(root, 'other');
  const entry = path.join(panel, 'static/build/app.js');
  for (const base of [panel, other]) {
    await fs.mkdir(path.join(base, 'static/build'), { recursive: true });
    await fs.writeFile(path.join(base, 'static/build/app.js'), '');
  }
  await fs.mkdir(proc);
  const alias = path.join(root, 'alias');
  await fs.symlink(panel, alias);
  async function processFixture(pid, args, cwd = panel) {
    const directory = path.join(proc, String(pid));
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'cmdline'), args.join('\0') + '\0');
    await fs.symlink(cwd, path.join(directory, 'cwd'));
  }
  // Use synthetic PIDs far outside ordinary host ranges; no signals are sent.
  await processFixture(900001, ['node', 'static/build/app.js']);
  await processFixture(900002, ['/usr/bin/node', entry], other);
  await processFixture(900003, ['node', './static/build/app.js'], alias);
  await processFixture(900004, ['node', 'static/build/app.js'], other);
  await processFixture(900005, ['node', '-e', 'static/build/app.js']);
  await processFixture(900006, ['bash', entry]);
  await processFixture(900007, ['node', entry, 'extra']);
  await processFixture(900008, ['node', 'missing.js']);
  await processFixture(
    900009,
    ['node', 'static/build/app.js'],
    path.join(root, 'gone'),
  );
  await processFixture(process.pid, ['node', entry]);
  await fs.mkdir(path.join(proc, '900010')); // Exited before cmdline could be read.
  await fs.mkdir(path.join(proc, 'self'));
  assert.deepEqual(
    (await findDirectBackendPids(entry, proc)).sort(),
    [900001, 900002, 900003],
  );
  assert.deepEqual(
    await findDirectBackendPids(path.join(root, 'missing/app.js'), proc),
    [],
  );
});

test(
  'real Linux stop and direct startup isolate panel installations',
  {
    skip: process.platform !== 'linux',
    timeout: 15000,
  },
  async (t) => {
    const { spawn } = require('node:child_process');
    const { once } = require('node:events');
    const { createContext } = require('../dist/local/context');
    const { stopPanel, startPanel } = require('../dist/local/operator');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-live-proc-'));
    const children = [];
    let fallbackPid;
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'close');
        }
      }
      if (fallbackPid) {
        try {
          process.kill(fallbackPid, 'SIGKILL');
        } catch {}
      }
      await fs.rm(root, { recursive: true, force: true });
    });
    const contexts = [];
    for (const name of ['panel with spaces', 'other-panel']) {
      await fs.mkdir(path.join(root, name));
      const context = createContext(
        { root: path.join(root, name) },
        { PATH: '' },
      );
      contexts.push(context);
      const entry = path.join(context.paths.dir_static, 'build/app.js');
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.writeFile(
        entry,
        'process.on("SIGTERM",()=>{console.log("terminated");process.exit(0)});console.log("ready");setInterval(()=>{},1000)',
      );
      const child = spawn(process.execPath, ['static/build/app.js'], {
        cwd: context.root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      await once(child.stdout, 'data');
      assert.equal(child.exitCode, null);
    }
    const [target, other] = contexts;
    const entry = path.join(target.paths.dir_static, 'build/app.js');
    assert.deepEqual(await findDirectBackendPids(entry), [children[0].pid]);
    const stopped = once(children[0], 'close');
    await stopPanel(target);
    assert.deepEqual(await stopped, [0, null]);
    assert.equal(children[1].exitCode, null);
    assert.equal(children[1].signalCode, null);
    assert.deepEqual(
      await findDirectBackendPids(
        path.join(other.paths.dir_static, 'build/app.js'),
      ),
      [children[1].pid],
    );
    const started = await startPanel(target);
    fallbackPid = started.pid;
    assert.equal(started.manager, 'node');
    assert.ok(Number.isSafeInteger(fallbackPid));
    assert.deepEqual(await findDirectBackendPids(entry), [fallbackPid]);
    assert.match(
      await fs.readFile(
        path.join(target.paths.dir_log, 'qinglong.log'),
        'utf8',
      ),
      /ready/,
    );
    await stopPanel(target);
    const deadline = Date.now() + 2000;
    while ((await findDirectBackendPids(entry)).length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await findDirectBackendPids(entry), []);
    fallbackPid = undefined;
    assert.equal(children[1].exitCode, null);
  },
);

test(
  'Linux direct restart waits for port release and refuses an unresponsive old service',
  {
    skip: process.platform !== 'linux',
    timeout: 20000,
  },
  async (t) => {
    const { spawn } = require('node:child_process');
    const { once } = require('node:events');
    const { createContext } = require('../dist/local/context');
    const { startPanel } = require('../dist/local/operator');
    for (const mode of ['delayed', 'ignore']) {
      await t.test(mode, async () => {
        const root = await fs.mkdtemp(
          path.join(os.tmpdir(), 'ql-port-handoff-'),
        );
        const context = createContext(
          { root },
          { PATH: '', MODE: mode, QL_LANG: 'en' },
        );
        const entry = path.join(context.paths.dir_static, 'build/app.js');
        const marker = path.join(root, 'starts');
        context.env.STARTS = marker;
        await fs.mkdir(path.dirname(entry), { recursive: true });
        await fs.writeFile(
          entry,
          'require("fs").appendFileSync(process.env.STARTS,"start\\n");' +
            'const server=require("http").createServer((q,s)=>s.end(String(process.pid)));' +
            'process.on("SIGTERM",()=>{if(process.env.MODE!=="ignore")setTimeout(()=>server.close(()=>process.exit(0)),400)});' +
            'server.listen(Number(process.env.PORT||0),"127.0.0.1",()=>console.log(server.address().port));',
        );
        const old = spawn(process.execPath, ['static/build/app.js'], {
          cwd: root,
          env: context.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let pid;
        try {
          const [chunk] = await once(old.stdout, 'data');
          context.env.PORT = chunk.toString().trim();
          assert.match(context.env.PORT, /^\d+$/);
          if (mode === 'ignore') {
            await assert.rejects(startPanel(context), /did not stop/);
            assert.equal(await fs.readFile(marker, 'utf8'), 'start\n');
            assert.equal(old.exitCode, null);
          } else {
            const result = await startPanel(context);
            pid = result.pid;
            assert.equal(result.manager, 'node');
            assert.equal(old.exitCode, 0);
            const response = await fetch(
              `http://127.0.0.1:${context.env.PORT}`,
            );
            assert.equal(await response.text(), String(pid));
            assert.equal(await fs.readFile(marker, 'utf8'), 'start\nstart\n');
          }
        } finally {
          if (old.exitCode === null && old.signalCode === null) {
            old.kill('SIGKILL');
            await once(old, 'close');
          }
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {}
          }
          await fs.rm(root, { recursive: true, force: true });
        }
      });
    }
  },
);

for (const language of ['zh', 'en', 'unsupported']) {
  test(
    `direct backend startup failure retains localized exit detail: ${language}`,
    { skip: process.platform !== 'linux' },
    async (t) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'ql-start-language-'),
      );
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const { createContext } = require('../dist/local/context');
      const { startPanel } = require('../dist/local/operator');
      const context = createContext({ root }, { PATH: '', QL_LANG: language });
      const entry = path.join(context.paths.dir_static, 'build/app.js');
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.writeFile(entry, 'process.exitCode=9;');
      await assert.rejects(
        startPanel(context),
        language === 'en' ? /startup \(9\)/ : /启动期间退出（9）/,
      );
    },
  );
}
