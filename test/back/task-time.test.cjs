const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function extract(file, name) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(name + '() {');
  assert.ok(start >= 0);
  return text.slice(start, text.indexOf('\n}', start) + 2);
}
const source =
  ['handle_log_path', 'init_begin_time']
    .map((n) => extract('shell/task.sh', n))
    .join('\n') +
  '\n' +
  ['format_time', 'format_log_time', 'format_timestamp', 'handle_task_end']
    .map((n) => extract('shell/share.sh', n))
    .join('\n');
function run(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-task-time-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(
    '/bin/bash',
    [
      '-ec',
      source +
        `
is_macos=0
mtime_format='%Y-%m-%d %H:%M:%S.%3N'
time_format='%Y-%m-%d %H:%M:%S'
ID=42; dir_log=/tmp; log_name=''; real_log_path=''; no_tee=''; real_time=''
make_dir() { :; }
t() { printf '%s\\n' "$*" >> "$TEST_DIR/messages"; }
update_cron() { printf '%s\\n' "$*" >> "$TEST_DIR/status"; }
record_cron_stat() { printf '%s\\n' "$*" >> "$TEST_DIR/stats"; }
date() {
 printf '%s\\n' "$*" >> "$TEST_DIR/dates"
 case "$1" in
  '+%Y-%m-%d %H:%M:%S.%3N|%Y-%m-%d-%H-%M-%S-%3N') printf '%s\\n' '2026-09-12 23:59:59.999|2026-09-12-23-59-59-999';;
  '+%Y-%m-%d %H:%M:%S|%s') printf '%s\\n' '2026-09-13 00:00:00|101';;
  '-d') [[ "$3" == '+%s' ]] && echo 100;;
  *) echo raw-time;;
 esac
}
` +
        body,
    ],
    { encoding: 'utf8', env: { ...process.env, TEST_DIR: dir } },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return {
    dir,
    text: (name) =>
      fs.existsSync(path.join(dir, name))
        ? fs.readFileSync(path.join(dir, name), 'utf8')
        : '',
  };
}
test('Linux task timestamps share a snapshot and retain millisecond log names across midnight', (t) => {
  const r = run(
    t,
    `handle_log_path 'folder/example.js'
init_begin_time
[[ "$log_path" == 'folder_example_42/2026-09-12-23-59-59-999.log' ]]
[[ "$time" == '2026-09-12 23:59:59.999' && "$begin_time" == '2026-09-12 23:59:59' && "$begin_timestamp" == 100 ]]
handle_task_end`,
  );
  assert.equal(r.text('dates').trim().split('\n').length, 3);
  assert.match(r.text('stats'), /^42 0 1\n$/);
  assert.match(r.text('messages'), /2026-09-13 00:00:00/);
});
test('explicit log paths and output mode remain intact', (t) => {
  run(
    t,
    `real_log_path='custom/output.log'; real_time=true
handle_log_path 'folder/example.js'
[[ "$log_path" == 'custom/output.log' && "$cmd" == '' ]]`,
  );
});
test('task failure keeps exit code and minimum one-second runtime', (t) => {
  const r = run(
    t,
    `begin_timestamp=101; _task_exit_code=7; log_path=test.log
handle_task_end`,
  );
  assert.equal(r.text('stats'), '42 7 1\n');
  assert.match(r.text('messages'), /失败/);
  assert.match(r.text('status'), /101 1 7/);
});
test('manual stop retains stopped message and exit status reporting', (t) => {
  const r = run(
    t,
    `begin_timestamp=99; _task_exit_code=1; log_path=test.log; MANUAL=true
handle_task_end`,
  );
  assert.equal(r.text('stats'), '42 1 2\n');
  assert.match(r.text('messages'), /已停止/);
});
for (const mode of ['macos', 'custom'])
  test(`${mode} keeps legacy time conversion helpers`, (t) => {
    run(
      t,
      `
${mode === 'macos' ? 'is_macos=1' : 'mtime_format=custom; time_format=custom'}
format_log_time() { echo legacy-log; }
format_time() { echo legacy-time; }
format_timestamp() { echo 100; }
handle_log_path example.js
init_begin_time
[[ "$log_time" == legacy-log && "$begin_time" == legacy-time && "$begin_timestamp" == 100 ]]
handle_task_end
`,
    );
  });
