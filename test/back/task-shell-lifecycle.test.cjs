const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function extract(file, name) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(name + '() {');
  assert.ok(start >= 0, name);
  return text.slice(start, text.indexOf('\n}', start) + 2);
}
const helpers = [
  ...['handle_task_start', 'handle_task_end', 'run_task_before', 'run_task_after', 'get_env_array', 'clear_env'].map(n => extract('shell/share.sh', n)),
  ...['run_shell_script', 'define_program', 'format_params'].map(n => extract('shell/task.sh', n)),
].join('\n');
const taskSource = path.resolve('shell/otask.sh');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-shell-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, body) => fs.writeFileSync(path.join(root, name), body);
  write('env.sh', 'export QA_PANEL="alpha&beta&gamma"\n');
  write('before.sh', 'export QA_BEFORE=ready\nqa_function() { printf "HOOK_FUNCTION\\n"; }\n');
  write('after.sh', 'printf "AFTER:%s:%s\\n" "$QA_PANEL" "$QA_BEFORE" >> "$QA_ROOT/events"\n');
  const run = (args) => {
    const r = spawnSync('/bin/bash', ['-c', helpers + `
      dir_scripts=$QA_ROOT; dir_shell=$QA_ROOT; dir_dep=$QA_ROOT
      file_env=$QA_ROOT/env.sh; file_task_before=$QA_ROOT/before.sh; file_task_after=$QA_ROOT/after.sh
      ID=42; log_path=fixture.log; is_macos=0
      dir_log=$QA_ROOT; log_dir=.; mtime_format='%Y-%m-%d %H:%M:%S'
      format_log_time() { printf fixture; }
      time_format='%Y-%m-%d %H:%M:%S'; begin_time=start; begin_timestamp=$(date +%s)
      real_time=true; no_delay=true; NODE_OPTIONS=''; PYTHONPATH=''
      pnpm() { printf '/fixture/global\\n'; }
      t() { :; }
      update_cron() { printf 'STATUS:%s:%s\\n' "$2" "$7" >> "$QA_ROOT/events"; }
      record_cron_stat() { printf 'STAT:%s\\n' "$2" >> "$QA_ROOT/events"; }
      format_params "$@"; define_program "${'${task_shell_params[@]}'}"
      . "$QA_TASK_SOURCE"
      printf 'WRAPPER_FINISHED\\n' >> "$QA_ROOT/events"
    `, 'fixture', ...args], { cwd: root, env: { ...process.env, QA_ROOT: root, QA_TASK_SOURCE: taskSource }, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return { stdout: r.stdout, events: fs.readFileSync(path.join(root, 'events'), 'utf8').trim().split('\n') };
  };
  return { write, run };
}

for (const [label, body, code] of [
  ['normal return', ':', 0],
  ['exit zero', 'exit 0', 0],
  ['exit failure', 'exit 7', 7],
  ['exec replacement', "exec bash -c 'exit 9'", 9],
  ['errexit failure', 'set -e\nfalse\necho SHOULD_NOT_RUN', 1],
  ['script EXIT trap', `trap 'echo SCRIPT_EXIT_TRAP' EXIT\nexit 4`, 4],
]) {
  test(`sourced shell ${label} still runs after hook and reports exactly one completion`, t => {
    const f = fixture(t);
    f.write('probe.sh', `[[ "$QA_PANEL" == 'alpha&beta&gamma' && "$QA_BEFORE" == ready ]] || exit 99\nqa_function\n${body}\n`);
    const r = f.run(['probe.sh']);
    assert.match(r.stdout, /HOOK_FUNCTION/);
    assert.doesNotMatch(r.stdout, /SHOULD_NOT_RUN/);
    if (label === 'script EXIT trap') assert.match(r.stdout, /SCRIPT_EXIT_TRAP/);
    assert.deepEqual(r.events, ['STATUS:0:', 'AFTER:alpha&beta&gamma:ready', `STATUS:1:${code}`, `STAT:${code}`, 'WRAPPER_FINISHED']);
  });
}

test('shell arguments and before-hook functions survive isolation while script state stays in the child', t => {
  const f = fixture(t);
  f.write('probe.sh', '[[ "$1" == "arg with spaces" ]] || exit 99\nqa_function\nexport QA_BEFORE=changed\ncd /\nexit 5\n');
  const r = f.run(['probe.sh', '--', 'arg with spaces']);
  assert.match(r.stdout, /HOOK_FUNCTION/);
  assert.ok(r.events.includes('AFTER:alpha&beta&gamma:ready'));
  assert.ok(r.events.includes('STATUS:1:5'));
});

for (const [label, args] of [
  ['explicit shell interpreter', ['bash', 'probe.sh', 'argument']],
  ['shell script with positional args', ['probe.sh', 'argument']],
]) {
  test(`${label} preserves generated environment and reports failure`, t => {
    const f = fixture(t);
    f.write('probe.sh', '[[ "$QA_PANEL" == "alpha&beta&gamma" && "$QA_BEFORE" == ready && "$1" == argument ]] || exit 99\nexit 6\n');
    const r = f.run(args);
    assert.ok(r.events.includes('STATUS:1:6'));
    assert.equal(r.events.filter(x => x.startsWith('STATUS:1:')).length, 1);
  });
}

test('explicit Python interpreter receives panel and before-hook environment', t => {
  const f = fixture(t);
  f.write('probe.py', 'import os,sys\nassert os.environ["QA_PANEL"] == "alpha&beta&gamma"\nassert os.environ["QA_BEFORE"] == "ready"\nassert sys.argv[1] == "argument"\nsys.exit(8)\n');
  assert.ok(f.run(['python3', 'probe.py', 'argument']).events.includes('STATUS:1:8'));
});

test('explicit Node interpreter retains generated environment', t => {
  const f = fixture(t);
  f.write('probe.cjs', 'if (process.env.QA_PANEL !== "alpha&beta&gamma" || process.env.QA_BEFORE !== "ready") process.exit(99); process.exit(8);\n');
  assert.ok(f.run(['node', 'probe.cjs']).events.includes('STATUS:1:8'));
});

test('plain commands retain generated environment', t => {
  const f = fixture(t);
  assert.match(f.run(['printenv', 'QA_PANEL']).stdout, /alpha&beta&gamma/);
});

for (const mode of ['desi', 'conc']) {
  test(`shell ${mode} keeps selected account values and completion reporting`, t => {
    const f = fixture(t);
    f.write('probe.sh', 'printf "ACCOUNT=%s\\n" "$QA_PANEL"\nexit 0\n');
    const r = f.run(['probe.sh', mode, 'QA_PANEL', '2-3']);
    assert.match(r.stdout, mode === 'desi' ? /ACCOUNT=beta&gamma/ : /ACCOUNT=beta\nACCOUNT=gamma/);
    assert.doesNotMatch(r.stdout, /ACCOUNT=alpha/);
    assert.ok(r.events.includes(`AFTER:${mode === 'desi' ? 'beta&gamma' : 'gamma'}:ready`));
    assert.equal(r.events.filter(x => x === 'STATUS:1:0').length, 1);
    assert.equal(r.events.filter(x => x.startsWith('AFTER:')).length, 1);
  });
}
