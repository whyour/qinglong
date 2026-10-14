const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../shell/task-timeout.sh'),
  'utf8',
);

test('timed task cleanup preserves output and exit codes without Bash job notifications', () => {
  const result = spawnSync(
    process.env.QL_TEST_BASH || '/bin/bash',
    [
      '-c',
      source +
        `
      command_timeout_time=1h
      for code in 0 7 0 7 0 7 0 7 0 7; do
        # Keep a descendant alive after the task leader exits so cleanup must
        # terminate the worker group as well as the sleeping watchdog.
        run_task_command bash -c 'sleep 10 & echo TASK_OUTPUT; echo TASK_ERROR >&2; exit "$1"' task "$code"
        actual=$?
        [[ $actual == "$code" ]] || exit 99
      done
    `,
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'TASK_OUTPUT\n'.repeat(10));
  assert.equal(result.stderr, 'TASK_ERROR\n'.repeat(10));
});
