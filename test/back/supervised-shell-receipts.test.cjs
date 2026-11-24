const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const text = fs.readFileSync('shell/share.sh', 'utf8');
const start = text.indexOf('handle_task_end() {');
const helper = text.slice(start, text.indexOf('\n}', start) + 2);

test('authorized supervisor removes redundant finish HTTP calls; standalone wrappers retain receipts and log trailers', () => {
  for (const [flag, trigger, expected] of [
    ['1', 'run-id', false],
    ['', 'run-id', true],
    ['1', '', true],
  ]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        helper +
          `\n
 update_cron(){ echo STATUS >&2; }; record_cron_stat(){ echo STATS >&2; }; t(){ printf "$@"; }
 ID=1; is_macos=0; time_format='%Y-%m-%d %H:%M:%S'; begin_timestamp=0; _task_exit_code=7
 handle_task_end
 `,
      ],
      {
        env: {
          ...process.env,
          QL_TRIGGER_ID: trigger,
          QL_SUPERVISOR_RECEIPT: flag,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.includes('STATUS'), expected);
    assert.equal(result.stderr.includes('STATS'), expected);
    assert.match(result.stdout, /退出码 7/);
  }
});

test('only a prebound manual log skips shell start HTTP; scheduled and standalone tasks publish their log path', () => {
  const offset = text.indexOf('handle_task_start() {');
  const startHelper = text.slice(offset, text.indexOf('\n}', offset) + 2);
  for (const [flag, trigger, expected] of [
    ['1', 'run-id', false],
    ['', 'run-id', true],
    ['1', '', true],
  ]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        startHelper +
          `\n
      update_cron(){ echo START >&2; }; t(){ printf "$@"; }
      ID=1; begin_time=now; handle_task_start
    `,
      ],
      {
        env: {
          ...process.env,
          QL_TRIGGER_ID: trigger,
          QL_SUPERVISOR_LOG_BOUND: flag,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.includes('START'), expected);
    assert.match(result.stdout, /开始执行/);
  }
});
