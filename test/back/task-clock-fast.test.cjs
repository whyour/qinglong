const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const bash = fs.existsSync('/opt/homebrew/bin/bash')
  ? '/opt/homebrew/bin/bash'
  : 'bash';
const major = Number(
  spawnSync(bash, ['-c', 'echo "$BASH_VERSINFO"'], {
    encoding: 'utf8',
  }).stdout.trim(),
);
function extract(file, name) {
  const s = fs.readFileSync(file, 'utf8');
  const a = s.indexOf(name + '() {');
  return s.slice(a, s.indexOf('\n}', a) + 2);
}
const helpers = ['handle_log_path', 'init_begin_time']
  .map((n) => extract('shell/task.sh', n))
  .concat(extract('shell/share.sh', 'handle_task_end'))
  .join('\n');
for (const zone of ['UTC', 'Asia/Shanghai'])
  test(
    `Bash clock preserves millisecond names and consistent epoch without date subprocesses (${zone})`,
    { skip: major < 5 },
    () => {
      const seconds = Date.parse('2026-09-12T23:59:59Z') / 1000;
      const script =
        helpers +
        `\n
 unset EPOCHSECONDS EPOCHREALTIME
 EPOCHREALTIME=${seconds}.999321; EPOCHSECONDS=${
          seconds + 1
        }; TZ=${zone}; export TZ
 ID=42; is_macos=0; dir_log=/tmp; log_name=task; no_tee=true
 time_format='%Y-%m-%d %H:%M:%S'; mtime_format='%Y-%m-%d %H:%M:%S.%3N'
 make_dir(){ :; }; date(){ echo FORBIDDEN >&2; return 99; }; format_timestamp(){ echo FORBIDDEN >&2; return 99; }
 t(){ :; }; update_cron(){ printf 'STATUS:%s:%s\\n' "$5" "$8"; }; record_cron_stat(){ printf 'STATS:%s:%s\\n' "$3" "$4"; }
 handle_log_path file.py; init_begin_time
 printf 'START:%s:%s:%s\\n' "$begin_timestamp" "$time" "$log_path"
 handle_task_end
 `;
      const r = spawnSync(bash, ['-eu', '-c', script], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /FORBIDDEN/);
      assert.match(
        r.stdout,
        new RegExp(`START:${seconds}:.*\\.999:task/.*-999\\.log`),
      );
      assert.match(r.stdout, new RegExp(`STATS:1:${seconds + 1}`));
      assert.match(
        r.stdout,
        zone === 'UTC' ? /2026-09-12-23-59-59-999/ : /2026-09-13-07-59-59-999/,
      );
    },
  );
