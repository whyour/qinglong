const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const psTree = require('ps-tree');
const test = require('node:test');

const bash = process.env.QL_TEST_BASH || '/bin/bash';
const helper = path.resolve(__dirname, '../../shell/task-timeout.sh');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tree = (pid) =>
  new Promise((resolve, reject) =>
    psTree(pid, (error, children) =>
      error ? reject(error) : resolve(children),
    ),
  );
async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, message);
    await delay(20);
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        if (
          ['Z', 'X', 'x'].includes(
            stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0],
          )
        )
          return false;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

for (const mode of ['timeout', 'manual']) {
  test(
    `${mode} cleans up TERM-resistant children, grandchildren and the watchdog`,
    { timeout: 12000, skip: process.platform === 'win32' },
    async (t) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ql-timeout-processes-'),
      );
      const known = new Set();
      let child;
      t.after(async () => {
        if (child) {
          for (const p of await tree(child.pid).catch(() => []))
            known.add(Number(p.PID));
        }
        for (const pid of known) {
          if (pid > 1) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {}
          }
        }
        fs.rmSync(root, { recursive: true, force: true });
      });
      fs.writeFileSync(
        path.join(root, 'child.sh'),
        `
      trap '' TERM
      printf '%s' "$$" > "$QA_ROOT/child"
      sleep 30 &
      printf '%s' "$!" > "$QA_ROOT/grandchild"
      wait
    `,
      );
      child = spawn(
        bash,
        [
          '-c',
          `
      . "$QA_HELPER"
      task() {
        trap '' TERM
        /bin/sh -c 'printf "%s" "$PPID"' > "$QA_ROOT/worker"
        "$QA_BASH" "$QA_ROOT/child.sh" &
        wait
      }
      run_task_command task
      exit $?
    `,
        ],
        {
          detached: true,
          env: {
            ...process.env,
            QA_ROOT: root,
            QA_HELPER: helper,
            QA_BASH: bash,
            command_timeout_time: mode === 'timeout' ? '1s' : '1h',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      known.add(child.pid);
      let result,
        stderr = '';
      child.stdout.resume();
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('exit', (code, signal) => {
        result = { code, signal };
      });
      await until(
        () =>
          ['worker', 'child', 'grandchild'].every((name) => {
            const file = path.join(root, name);
            return (
              fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8')) > 1
            );
          }),
        'task process tree did not initialize',
      );
      const descendants = await tree(child.pid);
      for (const p of descendants) known.add(Number(p.PID));
      for (const name of ['worker', 'child', 'grandchild'])
        known.add(Number(fs.readFileSync(path.join(root, name), 'utf8')));
      assert.ok(
        known.size >= 6,
        'must observe the wrapper, watchdog and task descendants',
      );
      if (mode === 'manual') {
        const worker = Number(
          fs.readFileSync(path.join(root, 'worker'), 'utf8'),
        );
        const wrapper = descendants.find((p) => Number(p.PID) === worker);
        assert.ok(wrapper, 'worker must belong to this test process tree');
        process.kill(Number(wrapper.PPID), 'SIGTERM');
      }
      await until(() => result, 'task wrapper did not exit');
      assert.equal(result.code, mode === 'timeout' ? 124 : 143, stderr);
      await until(
        () => [...known].every((pid) => !alive(pid)),
        'task or watchdog process survived cleanup',
      );
    },
  );
}
