const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readExit } = require('../../back/cron/settlement/exitReceipt.cjs');
const { shellQuote } = require('../../back/shared/shellQuote');
const script = path.resolve('shell/cron-command.py');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await sleep(10);
  }
  assert.fail('condition did not become true');
}
async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql-supervisor-boundaries-'),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    log: path.join(root, 'output.log'),
    marker: path.join(root, 'db', 'cron-exits', 'boundary'),
  };
}
function launch(t, f, command, { fallback = false, limited = false } = {}) {
  const bootstrap = `import runpy,sys${
    limited
      ? ',resource;resource.setrlimit(resource.RLIMIT_FSIZE,(1024,1024))'
      : ''
  }\n${
    fallback ? "sys.platform='darwin'\n" : ''
  }sys.argv=sys.argv[1:];sys.exit(runpy.run_path(sys.argv[0])['main']())`;
  const child = spawn(
    'python3',
    [
      '-I',
      '-S',
      '-c',
      bootstrap,
      script,
      command,
      String(process.pid),
      f.marker,
      process.execPath,
      path.resolve('back/shared/managedExit.cjs'),
      'log-output',
      f.log,
    ],
    {
      env: { ...process.env, QL_TRIGGER_ID: 'boundary' },
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (s) => (stderr += s));
  const closed = once(child, 'close').then(([code, signal]) => ({
    code,
    signal,
    stderr,
  }));
  child.stdin.end('run\n');
  return { child, closed };
}
for (const fallback of [false, true]) {
  test(
    `background writer retains supervision and cannot publish an early receipt (fallback=${fallback})`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t);
      const ready = path.join(f.root, 'ready');
      const go = path.join(f.root, 'go');
      const code = `import os,time\nopen(${JSON.stringify(
        ready,
      )},'w').write('ready')\nwhile not os.path.exists(${JSON.stringify(
        go,
      )}):time.sleep(.01)\nos.write(1,'后台尾行 stdout\\n'.encode());os.write(2,'后台尾行 stderr\\n'.encode())\n`;
      const run = launch(
        t,
        f,
        `python3 -I -S -c ${shellQuote(code)} & printf 'foreground\\n'`,
        { fallback },
      );
      await until(() =>
        fs.access(ready).then(
          () => true,
          () => false,
        ),
      );
      await sleep(100);
      assert.equal(run.child.exitCode, null);
      await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
      await fs.writeFile(go, 'continue');
      assert.equal((await run.closed).code, 0);
      assert.equal(
        await fs.readFile(f.log, 'utf8'),
        'foreground\n后台尾行 stdout\n后台尾行 stderr\n',
      );
      assert.equal((await readExit('boundary', f.marker)).code, 0);
    },
  );
  test(
    `regular log reaching its size limit does not interrupt script side effects (fallback=${fallback})`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t);
      const done = path.join(f.root, 'business-done');
      const code = `import os\nfor i in range(128):\n data=b'x'*8192\n while data:data=data[os.write(1+i%2,data):]\nopen(${JSON.stringify(
        done,
      )},'w').write('done')\n`;
      const result = await launch(
        t,
        f,
        `python3 -I -S -c ${shellQuote(code)}`,
        { fallback, limited: true },
      ).closed;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(await fs.readFile(done, 'utf8'), 'done');
      assert.equal((await fs.stat(f.log)).size, 1024);
      assert.equal(
        (result.stderr.match(/Could not write command log/g) || []).length,
        1,
      );
      assert.equal((await readExit('boundary', f.marker)).code, 0);
    },
  );
}

test(
  'Linux adopts a background task into the cancellable tree and drains acknowledged logs on forced stop',
  { timeout: 15000, skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t);
    const ready = path.join(f.root, 'ready');
    const payload = '取消前已确认日志 中文🚀\n'.repeat(4000);
    const code = `import os,time,signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\ndata=(${JSON.stringify(
      '取消前已确认日志 中文🚀\n',
    )}*4000).encode()\nwhile data:data=data[os.write(1,data):]\nopen(${JSON.stringify(
      ready,
    )},'w').write(str(os.getpid()))\ntime.sleep(30)\n`;
    const run = launch(t, f, `python3 -I -S -c ${shellQuote(code)} &`);
    let pid;
    await until(async () => {
      pid = Number(await fs.readFile(ready, 'utf8').catch(() => ''));
      if (!pid) return false;
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      return (
        Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) ===
        run.child.pid
      );
    });
    t.after(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (_) {}
    });
    const { killTask } = require('../../back/config/util');
    const { systemOwner } = require('../../back/cron/execution/cronProcess');
    const birth = systemOwner(run.child.pid);
    await killTask(run.child.pid, true, () =>
      assert.equal(systemOwner(run.child.pid), birth),
    );
    await run.closed;
    assert.throws(() => systemOwner(pid), { code: /ESRCH|ENOENT/ });
    assert.equal(await fs.readFile(f.log, 'utf8'), payload);
  },
);
