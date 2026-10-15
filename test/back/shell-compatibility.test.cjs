const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '../..');
const bash = process.env.QL_TEST_BASH || '/bin/bash';
const source = (file) => fs.readFileSync(path.join(repo, file), 'utf8');
function extract(file, name) {
  const text = source(file);
  const start = text.indexOf(`${name}() {`);
  assert.ok(start >= 0, name);
  return text.slice(start, text.indexOf('\n}', start) + 2);
}
function fixture(t, prefix = `ql compatibility '" $literal `) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, content, executable = false) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: executable ? 0o755 : 0o644 });
    return file;
  };
  const run = (code, env = {}, args = [], cwd = root) =>
    spawnSync(bash, ['-c', code, 'compatibility-test', ...args], {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 15000,
    });
  return { root, write, run };
}

for (const [label, args] of [
  ['normal', ['nested folder/probe [1] $name.sh', '--']],
  ['explicit bash', ['bash', 'nested folder/probe [1] $name.sh']],
  [
    'designated',
    ['nested folder/probe [1] $name.sh', 'desi', 'QA_PANEL', '1-2', '--'],
  ],
  [
    'concurrent',
    ['nested folder/probe [1] $name.sh', 'conc', 'QA_PANEL', '1-2', '--'],
  ],
  ['automatic Node', ['nested folder/probe [1] $name.js', '--']],
  ['explicit Node', ['node', 'nested folder/probe [1] $name.js']],
]) {
  for (const logging of ['tee', 'file']) {
    test(`${label} task keeps literal paths and arguments with ${logging} logging`, (t) => {
      const f = fixture(t);
      for (const name of ['share.sh', 'task.sh', 'otask.sh', 'task-timeout.sh'])
        f.write(`shell/${name}`, source(`shell/${name}`));
      f.write(
        'shell/api.sh',
        'update_cron(){ :; }; record_cron_stat(){ :; }\n',
      );
      f.write('shell/preload/env.sh', 'export QA_PANEL="one&two"\n');
      f.write('shell/preload/sitecustomize.js', '// fixture preloader\n');
      f.write(
        'data/config/config.sh',
        'DefaultCronRule="0 0 * * *"\nCommandTimeoutTime="2s"\n',
      );
      f.write('data/config/task_before.sh', 'printf "BEFORE\\n"\n');
      f.write('data/config/task_after.sh', 'printf "AFTER\\n"\n');
      f.write('bin/pnpm', '#!/bin/bash\nprintf /fixture/global\n', true);
      const literal = `argument with 'quotes' $literal ; echo NOT_EXECUTED`;
      f.write(
        'data/scripts/nested folder/probe [1] $name.sh',
        'printf "ARG=%s\\nACCOUNT=%s\\n" "$1" "$QA_PANEL"\n',
      );
      f.write(
        'data/scripts/nested folder/probe [1] $name.js',
        'console.log("ARG=" + process.argv[2]);\n',
      );
      const started = Date.now();
      const result = f.run(
        'exec "$QA_BASH" "$QL_DIR/shell/task.sh" "$@"',
        {
          QA_BASH: bash,
          QL_DIR: f.root,
          QL_DATA_DIR: path.join(f.root, 'data'),
          ID: '42',
          no_delay: 'true',
          real_time: 'false',
          no_tee: logging === 'file' ? 'true' : 'false',
          real_log_path: 'literal [log] $name.log',
          PATH: path.join(f.root, 'bin') + path.delimiter + process.env.PATH,
        },
        [...args, literal],
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.ok(
        Date.now() - started < 1800,
        'completion must not wait for the two-second watchdog',
      );
      const log = fs.readFileSync(
        path.join(f.root, 'data/log/literal [log] $name.log'),
        'utf8',
      );
      assert.ok(log.includes(`ARG=${literal}\n`), log);
      assert.match(log, /AFTER\n/);
      assert.match(log, /完成 ✅/);
      if (label === 'concurrent') {
        assert.match(log, /ACCOUNT=one\n/);
        assert.match(log, /ACCOUNT=two\n/);
      }
    });
  }
}

test('shared initialization copies configuration and hooks under a directory containing spaces', (t) => {
  const f = fixture(t);
  f.write('shell/share.sh', source('shell/share.sh'));
  for (const name of [
    'config.sample.sh',
    'task.sample.sh',
    'extra.sample.sh',
    'notify.py',
    'notify.js',
    'ql_sample.js',
    'ql_sample.py',
  ])
    f.write(
      `sample/${name}`,
      name === 'config.sample.sh'
        ? 'DefaultCronRule="0 0 * * *"\n'
        : '# fixture\n',
    );
  const result = f.run(
    '. "$QL_DIR/shell/share.sh"; fix_config; import_config; printf "%s" "$default_cron"',
    {
      QL_DIR: f.root,
      QL_DATA_DIR: path.join(f.root, 'custom data'),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '0 0 * * *');
  assert.ok(
    fs.existsSync(path.join(f.root, 'custom data/config/task_after.sh')),
  );
});

test('token generation passes a compiled token filename literally', (t) => {
  const f = fixture(t);
  f.write('static/build/token.js', 'console.log("fixture-token");\n');
  const result = f.run(
    extract('shell/api.sh', 'create_token') +
      '\ncreate_token; printf "%s" "$__ql_token__"',
    { dir_root: f.root },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'fixture-token');
});

test('script discovery keeps filenames with spaces, glob characters and leading dashes', (t) => {
  const f = fixture(t, 'ql-script-list | ');
  for (const name of ['-dash name.js', 'probe [1].js', 'sendNotify.js'])
    f.write(`scripts/${name}`, "new Env('fixture');\n");
  const result = f.run(
    extract('shell/otask.sh', 'gen_array_scripts') +
      '\ngen_array_scripts; printf "%s\\n" "${array_scripts[@]}"',
    {
      dir_scripts: path.join(f.root, 'scripts'),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.trim().split('\n').sort(), [
    '-dash name.js',
    'probe [1].js',
  ]);
});

test('token generation passes the TypeScript fallback filename literally', (t) => {
  const f = fixture(t);
  const result = f.run(
    extract('shell/api.sh', 'create_token') +
      `
    ts-node-transpile-only(){ [[ "$1" == "$dir_root/back/token.ts" ]] || return 99; printf fallback-token; }
    create_token || exit $?
    printf '%s' "$__ql_token__"
  `,
    { dir_root: f.root },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'fallback-token');
});

test('repository cloning preserves a literal destination with and without a branch', (t) => {
  const f = fixture(t);
  const origin = path.join(f.root, 'origin repo');
  for (const args of [
    ['init', '-b', 'develop', origin],
    ['-C', origin, 'config', 'user.name', 'Fixture'],
    ['-C', origin, 'config', 'user.email', 'fixture@example.invalid'],
  ]) {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  fs.writeFileSync(path.join(origin, 'probe.txt'), 'fixture');
  for (const args of [
    ['-C', origin, 'add', '.'],
    ['-C', origin, 'commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const branch of ['', 'develop']) {
    const target = path.join(f.root, branch || 'default clone');
    const result = f.run(
      [
        extract('shell/share.sh', 'set_proxy'),
        extract('shell/share.sh', 'unset_proxy'),
        extract('shell/share.sh', 'git_clone_scripts'),
        't(){ :; }; git_clone_scripts "$QA_ORIGIN" "$QA_TARGET" "$QA_BRANCH"; exit "$exit_status"',
      ].join('\n'),
      { QA_ORIGIN: origin, QA_TARGET: target, QA_BRANCH: branch },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(path.join(target, 'probe.txt'), 'utf8'),
      'fixture',
    );
  }
});

for (const condition of [
  'missing data',
  'invalid data',
  'invalid root',
  'npm only',
  'missing module',
  'unsupported OS',
]) {
  test(`native startup reports ${condition} without depending on translation initialization`, (t) => {
    const f = fixture(t);
    const npmRoot = path.join(f.root, 'npm global');
    fs.mkdirSync(path.join(npmRoot, '@whyour/qinglong'), { recursive: true });
    f.write('bin/npm', '#!/bin/bash\nprintf "%s" "$QA_NPM_ROOT"\n', true);
    f.write('bin/id', '#!/bin/bash\nprintf 1000\n', true);
    const env = {
      PATH: path.join(f.root, 'bin'),
      QL_DIR: f.root,
      QL_DATA_DIR: path.join(f.root, 'data'),
      QA_NPM_ROOT: npmRoot,
      QL_OS_TYPE: 'unsupported-fixture',
    };
    if (condition === 'missing data') env.QL_DATA_DIR = '';
    if (condition === 'invalid data') env.QL_DATA_DIR = 'relative/data';
    if (condition === 'invalid root') env.QL_DIR = 'relative';
    if (condition === 'npm only' || condition === 'missing module')
      env.QL_DIR = '';
    if (condition === 'missing module')
      fs.rmdirSync(path.join(npmRoot, '@whyour/qinglong'));
    const result = f.run(source('shell/start.sh'), env);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(
      result.stderr,
      /command not found|No such file|integer expression/,
    );
    assert.match(
      result.stderr,
      condition === 'npm only'
        ? /export QL_DIR=/
        : condition === 'missing module'
        ? /npm i -g @whyour\/qinglong/
        : condition === 'unsupported OS'
        ? /暂不支持此系统/
        : condition === 'invalid root'
        ? /QL_DIR/
        : /QL_DATA_DIR/,
    );
  });
}

test('language loading falls back when global associative arrays are unavailable', (t) => {
  const f = fixture(t, 'ql-locale-compat-');
  f.write(
    'shell/lang/en.sh',
    'printf loaded > "$QA_MARKER"\ndeclare -gA LANG_MESSAGES=([probe]=translated)\n',
  );
  const result = f.run(
    source('shell/share.sh') +
      `
    declare(){ if [[ "$1" == -gA ]]; then return 2; fi; builtin declare "$@"; }
    import_config
    t probe
  `,
    {
      QL_DIR: f.root,
      QL_LANG: 'en',
      QA_MARKER: path.join(f.root, 'loaded'),
      DefaultCronRule: '0 0 * * *',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'probe\n');
  assert.equal(fs.existsSync(path.join(f.root, 'loaded')), false);
});

test(
  'supported Bash keeps translated messages global after configuration loading',
  {
    skip:
      spawnSync(bash, ['-c', 'declare -gA probe'], { stdio: 'ignore' })
        .status !== 0,
  },
  (t) => {
    const f = fixture(t);
    f.write(
      'shell/lang/en.sh',
      'declare -gA LANG_MESSAGES=([probe]=translated)\n',
    );
    const result = f.run(
      source('shell/share.sh') + '\nimport_config; t probe',
      {
        QL_DIR: f.root,
        QL_LANG: 'en',
        DefaultCronRule: '0 0 * * *',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'translated\n');
  },
);

for (const fail of [false, true]) {
  test(`raw download ${
    fail
      ? 'failure preserves the installed script'
      : 'success installs the new script'
  } and clears its proxy`, (t) => {
    const f = fixture(t);
    f.write('raw/probe.js', 'previous-good-version');
    f.write('scripts/raw_probe.js', 'previous-good-version');
    f.write('crontab.list', '');
    const result = f.run(
      [
        extract('shell/share.sh', 'set_proxy'),
        extract('shell/share.sh', 'unset_proxy'),
        extract('shell/update.sh', 'update_raw'),
        `t(){ :; }
       wget(){ printf '%s' "$QA_CONTENT" > "$4"; return "$QA_STATUS"; }
       update_raw 'https://fixture.invalid/probe.js' 'http://fixture.invalid:8080' false false
       result=$?
       if env | grep -qE '^https?_proxy='; then exit 99; fi
       exit "$result"`,
      ].join('\n'),
      {
        dir_raw: path.join(f.root, 'raw'),
        dir_scripts: path.join(f.root, 'scripts'),
        list_crontab_user: path.join(f.root, 'crontab.list'),
        cmd_task: 'task',
        uniq_path: 'probe',
        QA_CONTENT: fail ? 'partial-download' : 'new-version',
        QA_STATUS: fail ? '8' : '0',
      },
    );
    assert.equal(result.status, fail ? 8 : 0, result.stderr);
    const expected = fail ? 'previous-good-version' : 'new-version';
    assert.equal(
      fs.readFileSync(path.join(f.root, 'raw/probe.js'), 'utf8'),
      expected,
    );
    assert.equal(
      fs.readFileSync(path.join(f.root, 'scripts/raw_probe.js'), 'utf8'),
      expected,
    );
    assert.equal(fs.existsSync(path.join(f.root, 'raw/probe.js.new')), false);
  });
}

test('ql raw propagates download failure without replacing either installed copy', (t) => {
  const f = fixture(t);
  for (const name of ['share.sh', 'update.sh', 'env.sh'])
    f.write(`shell/${name}`, source(`shell/${name}`));
  f.write('shell/api.sh', '');
  f.write('data/config/config.sh', 'DefaultCronRule="0 0 * * *"\n');
  f.write('data/config/crontab.list', '');
  f.write('data/raw/invalid_probe.js', 'old-version');
  f.write('data/scripts/raw_invalid_probe.js', 'old-version');
  f.write('bin/wget', '#!/bin/bash\nprintf partial > "$4"\nexit 8\n', true);
  const result = f.run(
    'exec "$QA_BASH" "$QL_DIR/shell/update.sh" raw https://fixture.invalid/probe.js "" false false',
    {
      QA_BASH: bash,
      QL_DIR: f.root,
      QL_DATA_DIR: path.join(f.root, 'data'),
      ID: '',
      PATH: path.join(f.root, 'bin') + path.delimiter + process.env.PATH,
    },
  );
  assert.equal(result.status, 8, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(f.root, 'data/raw/invalid_probe.js'), 'utf8'),
    'old-version',
  );
  assert.equal(
    fs.readFileSync(
      path.join(f.root, 'data/scripts/raw_invalid_probe.js'),
      'utf8',
    ),
    'old-version',
  );
});

const dateTools = [
  {
    name: 'host',
    command: 'date',
    macos: process.platform === 'darwin' ? '1' : '0',
  },
];
if (
  process.platform === 'darwin' &&
  spawnSync('gdate', ['--version']).status === 0
)
  dateTools.push({ name: 'GNU', command: 'gdate', macos: '0' });
for (const dateTool of dateTools) {
  test(`${dateTool.name} retention handles literal filenames, active references and empty directories`, (t) => {
    const f = fixture(t);
    const old = f.write('logs/2020-01-01 two [words].log', 'old');
    const active = f.write('logs/2020-01-01 active & protected.log', 'active');
    f.write('logs/keep/important.txt', 'keep');
    fs.mkdirSync(path.join(f.root, 'logs/empty directory'));
    const result = f.run(
      `
      t(){ :; }
      date(){ command "$QA_DATE" "$@"; }
      find_cron_api(){ printf '%s\n' "$1" >> "$QA_QUERIES"; [[ "$1" == *active* ]] && printf active; }
      . "$QA_SCRIPT" 7
    `,
      {
        dir_log: path.join(f.root, 'logs'),
        is_macos: dateTool.macos,
        QA_DATE: dateTool.command,
        QA_QUERIES: path.join(f.root, 'queries'),
        QA_SCRIPT: path.join(repo, 'shell/rmlog.sh'),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(active), true);
    assert.equal(
      fs.existsSync(path.join(f.root, 'logs/empty directory')),
      false,
    );
    assert.ok(fs.existsSync(path.join(f.root, 'logs/keep/important.txt')));
    const queries = fs
      .readFileSync(path.join(f.root, 'queries'), 'utf8')
      .trim()
      .split('\n');
    for (const query of queries)
      assert.equal(
        new URLSearchParams(query).get('log_path').includes('.log'),
        true,
      );
    assert.ok(
      queries.some(
        (query) =>
          new URLSearchParams(query).get('log_path') ===
          '2020-01-01 active & protected.log',
      ),
    );
  });

  test(`${dateTool.name} retention measures a dated log from local midnight`, (t) => {
    const f = fixture(t, 'ql-retention-boundary-');
    const file = f.write('logs/2026-01-01.log', 'boundary');
    const result = f.run(
      `
      t(){ :; }; find_cron_api(){ :; }
      date(){ if [[ "$*" == +%s ]]; then printf 1767830401; else command "$QA_DATE" "$@"; fi; }
      . "$QA_SCRIPT" 7
    `,
      {
        dir_log: path.join(f.root, 'logs'),
        is_macos: dateTool.macos,
        QA_DATE: dateTool.command,
        QA_SCRIPT: path.join(repo, 'shell/rmlog.sh'),
        TZ: 'UTC',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.existsSync(file),
      false,
      'seven days plus one second is past retention',
    );
  });
}

test('log streaming options are accepted by the actual platform tail', (t) => {
  const f = fixture(t);
  const today = spawnSync('date', ['+%F'], { encoding: 'utf8' }).stdout.trim();
  f.write(`syslog/${today}.log`, 'ready\n');
  const result = f.run(
    extract('shell/update.sh', 'show_service_logs') +
      `
    tail(){ printf '%s\\0' "$@"; }
    show_service_logs --lines 0
  `,
    { dir_data: f.root },
  );
  assert.equal(result.status, 0, result.stderr);
  const args = result.stdout.split('\0').slice(0, -1);
  const native = spawnSync('tail', args, {
    encoding: 'utf8',
    timeout: 250,
    killSignal: 'SIGKILL',
  });
  assert.equal(native.error?.code, 'ETIMEDOUT', native.stderr);
  assert.equal(native.stderr, '');
});

for (const version of ['2.23.0', '2.23.0-beta.1+build.2', 'invalid']) {
  test(`legacy publishing ${
    version === 'invalid'
      ? 'rejects an invalid version before Git changes'
      : 'uses the complete version with GNU-compatible tools'
  }`, (t) => {
    const f = fixture(t);
    f.write('version.yaml', `version: ${version}\n`);
    f.write(
      'bin/git',
      '#!/bin/bash\nprintf "%s\\n" "$*" >> "$QA_GIT_CALLS"\n',
      true,
    );
    f.write('bin/ts-node-transpile-only', '#!/bin/bash\nexit 0\n', true);
    const result = f.run(source('shell/pub.sh'), {
      PATH:
        path.join(f.root, 'bin') +
        path.delimiter +
        (process.platform === 'darwin' &&
        fs.existsSync('/opt/homebrew/opt/grep/libexec/gnubin')
          ? '/opt/homebrew/opt/grep/libexec/gnubin:'
          : '') +
        process.env.PATH,
      QA_GIT_CALLS: path.join(f.root, 'git-calls'),
    });
    if (version === 'invalid') {
      assert.notEqual(result.status, 0);
      assert.equal(fs.existsSync(path.join(f.root, 'git-calls')), false);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        fs
          .readFileSync(path.join(f.root, 'git-calls'), 'utf8')
          .includes(`tag -a v${version} -m release v${version}`),
      );
    }
  });
}
