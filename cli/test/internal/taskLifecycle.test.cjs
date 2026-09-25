const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-task-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['data/config', 'data/scripts', 'bin'])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin/pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const trace = path.join(root, 'trace');
  return {
    root, trace,
    write(file, contents) { fs.writeFileSync(path.join(root, file), contents); },
    args: [path.resolve(__dirname, '../../dist/runner.js'), '--root', root, '--json'],
    env: { PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`, TRACE: trace },
    events() { return fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n') : []; },
  };
}

test('shared Shell lifecycle scopes timeouts to the task and runs cleanup exactly once', async t => {
  const cases = [
    { name: 'success', task: 'return 0', code: 0 },
    { name: 'failure', task: 'return 7', code: 7 },
    { name: 'function timeout preserves state', task: 'STATE=changed; sleep 10', code: 124, timeout: true, state: 'changed' },
    { name: 'external timeout', args: ['sleep', '10'], code: 124, timeout: true },
    { name: 'Shell script timeout preserves state', task: 'STATE=changed; sleep 10', shell: true, code: 124, timeout: true, state: 'changed' },
    { name: 'slow before is outside task timeout', before: 'sleep 0.2', task: 'return 0', code: 0 },
    { name: 'slow after is outside task timeout', after: 'sleep 0.2', task: 'return 0', code: 0 },
    { name: 'background child cannot hold pipes after timeout cleanup', task: '(trap "" INT; sleep 30) & sleep 30', after: 'sleep 0.3', code: 124, timeout: true },
    { name: 'script may redirect fd 3', shell: true, task: 'exec 3> "$TRACE.fd"; return 0', after: 'sleep 0.3', code: 0 },
    { name: 'before may close fd 3 and redirect fd 9', before: 'exec 3>&- 9> "$TRACE.lock"', task: 'return 0', after: 'sleep 0.3', code: 0 },
    { name: 'timeout cleanup survives script fd 3 redirection', shell: true, task: 'exec 3> "$TRACE.fd"; STATE=changed; sleep 30', after: 'sleep 0.3', code: 124, timeout: true, state: 'changed' },
    { name: 'explicit exit preserves user trap and skips after', task: 'trap \'printf "exit\\n" >> "$TRACE"\' EXIT; exit 9', code: 9, noAfter: true, userExit: true },
    { name: 'user EXIT trap survives timeout with parent cleanup', task: 'trap \'printf "exit\\n" >> "$TRACE"\' EXIT; sleep 10', code: 124, timeout: true, userExit: true },
    { name: 'forced termination falls back to cleanup', task: 'trap "" INT; sleep 30', code: 124, timeout: true },
  ];
  for (const scenario of cases) await t.test(scenario.name, t => {
    const f = fixture(t);
    f.write('data/config/config.sh', `no_tee=true\nSTATE=original\nmy_task() { ${scenario.task || ':'}; }\n`);
    f.write('data/config/task_before.sh', `printf 'before\\n' >> "$TRACE"\n${scenario.before || ':'}\n`);
    f.write('data/config/task_after.sh', `${scenario.after || ':'}\nprintf 'after:%s:%s\\n' "$STATE" "$_task_exit_code" >> "$TRACE"\n`);
    if (scenario.shell) f.write('data/scripts/task.sh', scenario.task + '\n');
    const result = spawnSync(process.execPath, [...f.args, '-m', '0.1s', ...(scenario.args || [scenario.shell ? 'task.sh' : 'my_task'])], {
      env: f.env, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, scenario.code, result.stderr);
    const data = JSON.parse(result.stdout).data;
    assert.equal(data.exitCode, scenario.code);
    assert.equal(data.timedOut, !!scenario.timeout);
    assert.deepEqual(f.events(), [
      'before', ...(scenario.userExit ? ['exit'] : []),
      ...(scenario.noAfter ? [] : [`after:${scenario.state || 'original'}:${scenario.code}`]),
    ]);
  });
});

test('user cancellation remains cancellation, without timeout cleanup replay', async t => {
  const f = fixture(t);
  f.write('data/config/config.sh', 'my_task() { printf "READY\\n"; sleep 30; }\n');
  f.write('data/config/task_after.sh', 'printf "after\\n" >> "$TRACE"\n');
  const child = spawn(process.execPath, [...f.args, '-m', '20s', 'my_task'], { env: f.env });
  let out = '', err = '', sent = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  t.after(() => { clearTimeout(timer); child.kill('SIGKILL'); });
  child.stdout.on('data', chunk => out += chunk);
  child.stderr.on('data', chunk => {
    err += chunk;
    if (!sent && err.includes('READY')) { sent = true; child.kill('SIGTERM'); }
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(sent, true, err);
  assert.equal(code, 143, err);
  assert.equal(JSON.parse(out).data.timedOut, false);
  assert.deepEqual(f.events(), []);
});
