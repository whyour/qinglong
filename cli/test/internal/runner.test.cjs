const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { parseExecution } = require('../../dist/runner');

test('cancelling random delay returns final JSON without starting the Shell task', async (t) => {
  for (const signal of [
    'SIGINT',
    'SIGTERM',
    'SIGHUP',
    'SIGQUIT',
    'SIGALRM',
    'SIGTSTP',
  ]) {
    await t.test(signal, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-delay-signal-'));
      fs.mkdirSync(path.join(root, 'data/scripts'), { recursive: true });
      fs.mkdirSync(path.join(root, 'data/config'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'data/config/config.sh'),
        'RandomDelay=600\nRandomDelayFileExtensions=sh\nRandomDelayIgnoredMinutes=99\n',
      );
      const marker = path.join(root, 'task-started');
      fs.writeFileSync(
        path.join(root, 'data/scripts/delay.sh'),
        'touch "$MARKER"\n',
      );
      const child = spawn(
        process.execPath,
        [
          path.resolve(__dirname, '../../dist/runner.js'),
          '--root',
          root,
          '--json',
          'delay.sh',
        ],
        {
          env: { PATH: process.env.PATH, MARKER: marker },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '',
        stderr = '',
        sent = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        const completion = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, exitSignal) =>
            resolve({ code, exitSignal }),
          );
        });
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
          if (!sent && stderr.includes('任务随机延迟')) {
            sent = true;
            child.kill(signal);
          }
        });
        const result = await completion;
        assert.equal(sent, true, stderr);
        const code = 128 + os.constants.signals[signal];
        assert.deepEqual(result, { code, exitSignal: null }, stderr);
        const payload = JSON.parse(stdout);
        assert.equal(payload.data.exitCode, code);
        assert.equal(payload.data.timedOut, false);
        assert.equal(fs.existsSync(marker), false);
        const log = fs.readFileSync(
          path.join(root, 'data/log', payload.data.logPath),
          'utf8',
        );
        assert.ok(log.includes(`退出码 ${code}`));
      } finally {
        clearTimeout(timer);
        child.kill('SIGKILL');
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('runner preserves child flags, script separators and legacy account modes', () => {
  assert.deepEqual(parseExecution(['example.js', '--timeout']).execution.argv, [
    'example.js',
    '--timeout',
  ]);
  const parsed = parseExecution([
    '--json',
    '-m',
    '2s',
    'example.js',
    'desi',
    'ACCOUNTS',
    '1-3',
    '--',
    '--json',
    'a b',
  ]);
  assert.equal(parsed.values.json, true);
  assert.equal(parsed.execution.timeout, '2s');
  assert.equal(parsed.execution.selection, '1-3');
  assert.deepEqual(parsed.execution.scriptArgs, ['--json', 'a b']);
  assert.throws(() => parseExecution(['--unknown', 'example.js']), {
    exitCode: 2,
  });
});

test('runner executable keeps JSON stdout clean and returns the script exit status', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data/scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data/config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data/config/task_before.sh'),
    'export FROM_HOOK=before\nprintf "hook output\\n"\n',
  );
  fs.writeFileSync(
    path.join(root, 'data/config/task_after.sh'),
    'printf "after output\\n"\n',
  );
  fs.writeFileSync(
    path.join(root, 'data/scripts/example.js'),
    'console.log(process.env.FROM_HOOK);console.log(process.argv.slice(2).join("|"));process.exit(7)',
  );
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, '../../dist/runner.js'),
      '--root',
      root,
      '--json',
      'example.js',
      '--',
      '--timeout',
      'a b',
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH } },
  );
  assert.equal(result.status, 7, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.exitCode, 7);
  assert.match(result.stderr, /hook output/);
  assert.match(result.stderr, /before/);
  assert.match(result.stderr, /--timeout\|a b/);
  assert.match(result.stderr, /after output/);
  const log = fs.readFileSync(
    path.join(root, 'data/log', payload.data.logPath),
    'utf8',
  );
  assert.match(log, /hook output/);
  assert.match(log, /after output/);
});

test('runner signals cancel a live Shell session and emit a final JSON result', async (t) => {
  for (const signal of [
    'SIGINT',
    'SIGTERM',
    'SIGHUP',
    'SIGQUIT',
    'SIGALRM',
    'SIGTSTP',
  ]) {
    await t.test(signal, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-runner-signal-'));
      fs.mkdirSync(path.join(root, 'data/scripts'), { recursive: true });
      fs.mkdirSync(path.join(root, 'data/config'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'data/config/task_after.sh'),
        'echo unexpected-after\n',
      );
      fs.writeFileSync(
        path.join(root, 'data/scripts/wait.sh'),
        "trap 'echo signal-marker:SIGTERM; exit 23' TERM\ntrap 'echo signal-marker:SIGINT; exit 23' INT\ntrap 'echo signal-marker:SIGHUP; exit 23' HUP\ntrap 'echo signal-marker:SIGQUIT; exit 23' QUIT\ntrap 'echo signal-marker:SIGALRM; exit 23' ALRM\ntrap 'echo signal-marker:SIGTSTP; exit 23' TSTP\ntrap 'echo exit-marker' EXIT\necho ready-pid:$$\nwhile :; do sleep 0.1; done\n",
      );
      const child = spawn(
        process.execPath,
        [
          path.resolve(__dirname, '../../dist/runner.js'),
          '--root',
          root,
          '--json',
          'wait.sh',
          'now',
        ],
        { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '',
        stderr = '',
        sessionPid;
      let closed = false;
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        if (sessionPid) {
          try {
            process.kill(-sessionPid, 'SIGKILL');
          } catch {}
        }
      }, 10000);
      try {
        const completion = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, exitSignal) => {
            closed = true;
            resolve({ code, exitSignal });
          });
        });
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
          const match = /ready-pid:(\d+)\n/.exec(stderr);
          if (match && !sessionPid) {
            sessionPid = Number(match[1]);
            child.kill(signal);
          }
        });
        const result = await completion;
        assert.ok(sessionPid, stderr);
        const expectedCode = 128 + os.constants.signals[signal];
        assert.deepEqual(
          result,
          { code: expectedCode, exitSignal: null },
          stderr,
        );
        const payload = JSON.parse(stdout);
        assert.equal(payload.data.exitCode, expectedCode);
        assert.equal(payload.data.timedOut, false);
        assert.deepEqual(stderr.match(/signal-marker:SIG\w+/g), [
          `signal-marker:${signal}`,
        ]);
        assert.match(stderr, /exit-marker/);
        assert.doesNotMatch(stderr, /unexpected-after/);
        const log = fs.readFileSync(
          path.join(root, 'data/log', payload.data.logPath),
          'utf8',
        );
        assert.ok(log.includes(`signal-marker:${signal}`));
        assert.ok(log.includes(`退出码 ${expectedCode}`));
      } finally {
        clearTimeout(timeout);
        if (!closed) child.kill('SIGKILL');
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('configuration and independent before hooks cancel without starting the task', async (t) => {
  for (const phase of ['config', 'before']) {
    for (const signal of [
      'SIGINT',
      'SIGTERM',
      'SIGHUP',
      'SIGQUIT',
      'SIGALRM',
      'SIGTSTP',
    ]) {
      await t.test(`${phase}: ${signal}`, async () => {
        const root = fs.mkdtempSync(
          path.join(os.tmpdir(), 'ql-config-cancel-'),
        );
        fs.mkdirSync(path.join(root, 'data/scripts'), { recursive: true });
        fs.mkdirSync(path.join(root, 'data/config'), { recursive: true });
        const marker = path.join(root, 'started');
        fs.writeFileSync(
          path.join(root, 'data/scripts/task.js'),
          'require("node:fs").writeFileSync(process.env.MARKER,"started")',
        );
        const hook = phase === 'config' ? 'config.sh' : 'task_before.sh';
        fs.writeFileSync(
          path.join(root, 'data/config', hook),
          "trap 'echo received:SIGINT; exit 23' INT\n" +
            "trap 'echo received:SIGTERM; exit 23' TERM\n" +
            "trap 'echo received:SIGHUP; exit 23' HUP\n" +
            "trap 'echo received:SIGQUIT; exit 23' QUIT\n" +
            "trap 'echo received:SIGALRM; exit 23' ALRM\n" +
            "trap 'echo received:SIGTSTP; exit 23' TSTP\n" +
            'echo ready-pid:$$\nwhile :; do sleep 0.1; done\n',
        );
        const child = spawn(
          process.execPath,
          [
            path.resolve(__dirname, '../../dist/runner.js'),
            '--root',
            root,
            '--json',
            'task.js',
            'now',
          ],
          {
            env: { PATH: process.env.PATH, MARKER: marker },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '',
          stderr = '',
          sessionPid;
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          if (sessionPid) {
            try {
              process.kill(-sessionPid, 'SIGKILL');
            } catch {}
          }
        }, 10000);
        try {
          const completion = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, exitSignal) =>
              resolve({ code, exitSignal }),
            );
          });
          child.stdout.on('data', (chunk) => {
            stdout += chunk;
          });
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
            const match = /ready-pid:(\d+)\n/.exec(stderr);
            if (match && !sessionPid) {
              sessionPid = Number(match[1]);
              child.kill(signal);
            }
          });
          const result = await completion;
          const code = 128 + os.constants.signals[signal];
          assert.ok(sessionPid, stderr);
          assert.deepEqual(result, { code, exitSignal: null }, stderr);
          assert.deepEqual(stderr.match(/received:SIG\w+/g), [
            `received:${signal}`,
          ]);
          assert.equal(fs.existsSync(marker), false);
          if (phase === 'config') {
            assert.equal(stdout, '');
            const error = JSON.parse(stderr.trim().split('\n').at(-1));
            assert.equal(error.code, code);
            assert.match(
              error.message,
              /cancelled during configuration|加载配置时已取消/,
            );
          } else {
            const payload = JSON.parse(stdout);
            assert.equal(payload.data.exitCode, code);
            assert.equal(payload.data.timedOut, false);
          }
        } finally {
          clearTimeout(timer);
          child.kill('SIGKILL');
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});
