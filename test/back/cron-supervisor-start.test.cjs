const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readExit } = require('../../back/cron/settlement/exitReceipt.cjs');
const script = path.resolve('shell/cron-command.py');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-spawn-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, marker: path.join(root, 'db', 'cron-exits', 'launch') };
}

function launch(t, f, command, { extraFd, fallback = false } = {}) {
  const args = [
    script,
    command,
    String(process.pid),
    f.marker,
    process.execPath,
    path.resolve('back/shared/managedExit.cjs'),
    'report-start',
  ];
  if (fallback)
    args.unshift(
      '-c',
      "import sys,runpy;sys.argv=sys.argv[1:];sys.platform='darwin';sys.exit(runpy.run_path(sys.argv[0])['main']())",
    );
  const child = spawn('python3', ['-I', '-S', ...args], {
    env: { ...process.env, QL_DATA_DIR: f.root, QL_TRIGGER_ID: 'launch' },
    stdio: [
      'pipe',
      'pipe',
      'pipe',
      'pipe',
      ...(extraFd === undefined ? [] : [extraFd]),
    ],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '',
    stderr = '',
    stamp = '';
  child.stdout.setEncoding('utf8').on('data', (data) => (stdout += data));
  child.stderr.setEncoding('utf8').on('data', (data) => (stderr += data));
  child.stdio[3].setEncoding('ascii').on('data', (data) => (stamp += data));
  const timing = once(child.stdio[3], 'end');
  const closed = once(child, 'close').then(([code, signal]) => ({
    code,
    signal,
    stdout,
    stderr,
    stamp,
  }));
  return { child, closed, timing };
}

test(
  'launch authorization is required before Bash environment and command side effects',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const command = `printf forbidden > '${path.join(f.root, 'side-effect')}'`;
    const run = launch(t, f, command);
    await new Promise((r) => setTimeout(r, 150));
    await assert.rejects(fs.access(path.join(f.root, 'side-effect')), {
      code: 'ENOENT',
    });
    run.child.stdin.end();
    const result = await run.closed;
    assert.equal(result.code, 125);
    await assert.rejects(fs.access(f.marker), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(f.root, 'side-effect')), {
      code: 'ENOENT',
    });
  },
);

for (const fallback of [false, true]) {
  test(
    `telemetry closes before command completion and inherited descriptors stay private (fallback=${fallback})`,
    { timeout: 10000, skip: process.platform !== 'linux' },
    async (t) => {
      const f = await fixture(t);
      const handle = await fs.open(path.join(f.root, 'private'), 'w+');
      t.after(() => handle.close());
      const run = launch(
        t,
        f,
        'test ! -e /proc/self/fd/3 && test ! -e /proc/self/fd/4 || exit 90; read value && exit 91; sleep 0.5; printf "尾行 stdout\\n"; printf "stderr\\n" >&2; exit 17',
        { extraFd: handle.fd, fallback },
      );
      run.child.stdin.end('run\n');
      await run.timing;
      assert.equal(
        run.child.exitCode,
        null,
        'telemetry must not wait for the command to close inherited fd 3',
      );
      const result = await run.closed;
      assert.equal(result.code, 17, result.stderr);
      assert.equal(result.stdout, '尾行 stdout\n');
      assert.equal(result.stderr, 'stderr\n');
      assert.match(result.stamp, /^\d{13}$/);
      const exit = await readExit('launch', f.marker);
      assert.equal(exit.version, 1);
      assert.equal(exit.code, 17);
    },
  );
}

for (const signal of ['TERM', 'PIPE']) {
  test(
    `command SIG${signal} survives supervision and verified receipt publication`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t);
      const run = launch(t, f, `kill -${signal} $$; exit 99`);
      run.child.stdin.end('run\n');
      const result = await run.closed;
      assert.equal(result.code, null, result.stderr);
      assert.equal(result.signal, 'SIG' + signal);
      const exit = await readExit('launch', f.marker);
      assert.equal(exit.version, 1);
      assert.equal(exit.code, null);
      assert.equal(exit.signal, 'SIG' + signal);
    },
  );
}

test(
  'native launch failures close every pipe without executing a command',
  { timeout: 10000, skip: process.platform !== 'linux' },
  async (t) => {
    // Some Linux libffi builds retain a descriptor on their first load. Include
    // that runtime-owned descriptor in the baseline, not in launch allocations.
    const code = `import os,runpy,sys,signal,ctypes
ctypes.CDLL(None,use_errno=True)
module=runpy.run_path(sys.argv[1])
def descriptors():
 result={}
 for fd in os.listdir('/proc/self/fd'):
  try: result[fd]=os.readlink('/proc/self/fd/'+fd)
  except FileNotFoundError: pass
 return result
before=descriptors()
def fail(*args,**kwargs): raise OSError(2,'injected exec failure')
os.posix_spawn=fail
for merged,log in ((False,None),(True,None),(True,os.devnull)):
 try: module['spawn_command']('exit 99',merged,log)
 except OSError as error: assert error.errno==2
 else: raise AssertionError('launch unexpectedly succeeded')
 after=descriptors()
 assert after==before,(merged,log,before,after)
`;
    const child = spawn('python3', ['-I', '-S', '-c', code, script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    t.after(() => child.kill('SIGKILL'));
    let stderr = '';
    child.stderr.on('data', (data) => (stderr += data));
    const [status] = await once(child, 'close');
    assert.equal(status, 0, stderr);
  },
);

for (const fallback of [false, true]) {
  test(
    `acknowledged log bytes survive killing the supervisor before its writer (fallback=${fallback})`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const logfile = path.join(f.root, 'command.log');
      const ready = path.join(f.root, 'ready');
      const proceed = path.join(f.root, 'proceed');
      const acknowledged = path.join(f.root, 'acknowledged');
      const writer = path.join(f.root, 'writer.py');
      const payload = '最后一行 中文🚀 stdout/stderr\n'.repeat(10);
      await fs.writeFile(
        writer,
        `import os,time\nopen(${JSON.stringify(
          ready,
        )},'w').write(str(os.getpid()))\nwhile not os.path.exists(${JSON.stringify(
          proceed,
        )}):time.sleep(.005)\ndata=${JSON.stringify(
          payload,
        )}.encode('utf8')\nfor fd in (1,2):\n offset=0\n while offset<len(data):offset+=os.write(fd,data[offset:])\nopen(${JSON.stringify(
          acknowledged,
        )},'w').write('written')\ntime.sleep(30)\n`,
      );
      const args = [
        script,
        `exec python3 '${writer}'`,
        String(process.pid),
        f.marker,
        process.execPath,
        path.resolve('back/shared/managedExit.cjs'),
        'log-output',
        logfile,
      ];
      if (fallback)
        args.unshift(
          '-c',
          "import sys,runpy;sys.argv=sys.argv[1:];sys.platform='darwin';sys.exit(runpy.run_path(sys.argv[0])['main']())",
        );
      const child = spawn('python3', ['-I', '-S', ...args], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let writerPid;
      t.after(() => {
        child.kill('SIGKILL');
        if (writerPid)
          try {
            process.kill(writerPid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
      });
      const closed = once(child, 'close');
      child.stdin.end('run\n');
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const value = await fs.readFile(ready, 'utf8').catch(() => '');
        if (value) {
          writerPid = Number(value);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(writerPid, 'writer must start');
      child.kill('SIGSTOP');
      await fs.writeFile(proceed, 'write');
      while (Date.now() < deadline) {
        if (await fs.readFile(acknowledged, 'utf8').catch(() => '')) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(await fs.readFile(acknowledged, 'utf8'), 'written');
      child.kill('SIGKILL');
      // The independent relay must keep draining acknowledged pipe bytes even
      // with the writer still alive and its supervisor gone. File visibility is
      // asynchronous; neither killing the writer nor resuming the supervisor
      // may be necessary to finish persisting this prefix.
      while (Date.now() < deadline) {
        if (
          (await fs.readFile(logfile, 'utf8').catch(() => '')) ===
          payload + payload
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(await fs.readFile(logfile, 'utf8'), payload + payload);
      process.kill(writerPid, 'SIGKILL');
      writerPid = undefined;
      await closed;
    },
  );
}
