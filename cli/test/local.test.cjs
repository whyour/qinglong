const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createContext, sourceEnvironment } = require('../dist/local/context');
const { runProcess } = require('../dist/local/process');
const { pruneLogs } = require('../dist/local/maintenance');
const { parse } = require('../dist/arguments');

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-local-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

test('native argument schema accepts standard syntax, short options, aliases and scoped help', () => {
  const result = parse([
    '--json',
    'task',
    'list',
    '--search=a b',
    '-p',
    '2',
    '--size=10',
  ]);
  assert.equal(result.json, true);
  assert.equal(result.values.search, 'a b');
  assert.equal(result.values.page, '2');
  assert.equal(
    parse(['login', '--url=https://example.com']).name,
    'auth login',
  );
  assert.match(parse(['task', 'logs', '--help']).help, /--tail/);
  assert.doesNotMatch(parse(['task', 'logs', '--help']).help, /--url/);
  assert.throws(() => parse(['task', 'list', '-p', '1', '--page', '2']), {
    exitCode: 2,
  });
});

test('user shell config evaluates variables without polluting the parent environment', async (t) => {
  const root = sandbox(t);
  const context = createContext(
    { root },
    {
      PATH: process.env.PATH,
      QL_DATA_DIR: path.join(root, 'separate data'),
      KEEP: 'parent',
    },
  );
  const config = path.join(root, 'config with spaces.sh');
  fs.writeFileSync(
    config,
    'UnexportedValue="two words"\nexport KEEP="child"\nexport QUOTED="value with = and \\n newline"\n',
  );
  const env = await sourceEnvironment(context.env, [config]);
  assert.equal(env.UnexportedValue, 'two words');
  assert.equal(env.KEEP, 'child');
  assert.equal(context.env.KEEP, 'parent');
  assert.equal(env.dir_scripts, path.join(root, 'separate data/scripts'));
});

test('subprocess argv, output, exit status and bounded capture are independent of shell quoting', async (t) => {
  const root = sandbox(t);
  const result = await runProcess(
    process.execPath,
    [
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exit(7)',
      'a b',
      '$(touch unwanted)',
      '*.js',
    ],
    { cwd: root, capture: true },
  );
  assert.equal(result.code, 7);
  assert.deepEqual(JSON.parse(result.stdout), [
    'a b',
    '$(touch unwanted)',
    '*.js',
  ]);
  assert.equal(fs.existsSync(path.join(root, 'unwanted')), false);
  await assert.rejects(
    runProcess(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(100000))'],
      { capture: true, maxCaptureBytes: 10 },
    ),
    /capture limit|捕获上限/,
  );
});

test('timeout escalates and terminates a process that ignores SIGINT', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.on("SIGINT",()=>{});setInterval(()=>{},1000)'],
    { capture: true, timeoutMs: 200, graceMs: 100 },
  );
  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
});

test('log cleanup respects active references, age and symlink boundaries', async (t) => {
  const root = sandbox(t);
  const context = createContext({ root });
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    assert.equal(req.headers.authorization, 'Bearer local-test-token');
    const log = new URL(req.url, 'http://localhost').searchParams.get(
      'log_path',
    );
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        code: 200,
        data: log.includes('active') ? { id: 1, name: 'running' } : null,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  context.env.QlPort = String(server.address().port);
  fs.mkdirSync(context.paths.dir_config, { recursive: true });
  fs.writeFileSync(
    context.paths.file_auth_token,
    JSON.stringify({
      value: 'local-test-token',
      expiration: Date.now() / 1000 + 1000,
    }),
  );
  const logDir = path.join(context.paths.dir_log, 'nested');
  fs.mkdirSync(logDir, { recursive: true });
  for (const name of [
    '2000-01-01-old.log',
    '2000-01-01-active.log',
    '2999-01-01-future.log',
  ])
    fs.writeFileSync(path.join(logDir, name), name);
  const outside = path.join(root, '2000-01-01-outside.log');
  fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(logDir, 'link.log'));
  const result = await pruneLogs(context, 7);
  assert.deepEqual(result.removed, ['nested/2000-01-01-old.log']);
  assert.deepEqual(result.retained, ['nested/2000-01-01-active.log']);
  assert.equal(fs.existsSync(outside), true);
  assert.equal(requests.length, 2);
});

test('task engine runs scripts with exact arguments, log output, failure status and account selection', async (t) => {
  const {
    executeTask,
    selectedAccounts,
    durationMs,
  } = require('../dist/local/taskRunner');
  const root = sandbox(t);
  const context = createContext(
    { root },
    { PATH: process.env.PATH, no_tee: 'true' },
  );
  fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
  const script = path.join(context.paths.dir_scripts, 'example.js');
  fs.writeFileSync(
    script,
    'console.log(JSON.stringify({args:process.argv.slice(2),account:process.env.ACCOUNTS,cwd:process.cwd()}));process.exit(7)',
  );
  const result = await executeTask(context, {
    argv: ['example.js'],
    scriptArgs: ['space value', '--json'],
    mode: 'now',
  });
  assert.equal(result.exitCode, 7);
  const log = fs.readFileSync(
    path.join(context.paths.dir_log, result.logPath),
    'utf8',
  );
  assert.match(log, /space value/);
  assert.match(log, /--json/);
  assert.match(log, /退出码 7/);
  assert.deepEqual(selectedAccounts('3-1 2 max', 3), [3, 2, 1]);
  assert.throws(() => selectedAccounts('0', 3, { QL_LANG: 'en' }), /outside/);
  assert.equal(durationMs('1.5m'), 90000);
  context.env.ACCOUNTS = 'one&two&three';
  const designated = await executeTask(context, {
    argv: ['example.js'],
    mode: 'desi',
    variable: 'ACCOUNTS',
    selection: '3 1',
  });
  assert.match(
    fs.readFileSync(
      path.join(context.paths.dir_log, designated.logPath),
      'utf8',
    ),
    /three&one/,
  );
});

test('task log flags keep realtime output off disk and override no_tee', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  for (const flags of [
    {},
    { no_tee: 'true' },
    { real_time: 'true' },
    { real_time: 'true', no_tee: 'true' },
  ]) {
    const context = createContext(
      { root: sandbox(t) },
      {
        PATH: process.env.PATH,
        ...flags,
      },
    );
    fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
    fs.writeFileSync(
      path.join(context.paths.dir_scripts, 'flags.js'),
      'console.log("stdout-marker");console.error("stderr-marker");',
    );
    let output = '';
    const result = await executeTask(context, {
      argv: ['flags.js'],
      mode: 'now',
      output: (chunk) => {
        output += chunk;
      },
    });
    assert.equal(result.exitCode, 0);
    const logFile = path.join(context.paths.dir_log, result.logPath);
    if (flags.real_time === 'true') {
      assert.equal(fs.existsSync(logFile), false);
      assert.equal(fs.existsSync(context.paths.dir_log), false);
    } else {
      const log = fs.readFileSync(logFile, 'utf8');
      assert.match(log, /stdout-marker/);
      assert.match(log, /stderr-marker/);
    }
    if (flags.no_tee === 'true' && flags.real_time !== 'true') {
      assert.equal(output, '');
    } else {
      assert.match(output, /stdout-marker/);
      assert.match(output, /stderr-marker/);
    }
  }
});

test('concurrent accounts finish independently but merge logs in selection order', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  const root = sandbox(t);
  const context = createContext(
    { root },
    { PATH: process.env.PATH, no_tee: 'true', ACCOUNTS: 'slow&fast' },
  );
  fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
  fs.writeFileSync(
    path.join(context.paths.dir_scripts, 'parallel.js'),
    `
    const account=process.env.ACCOUNTS;
    console.log(account+':start');
    setTimeout(()=>{console.log(account+':end');process.exit(account==='fast'?7:0)},account==='slow'?200:10);
  `,
  );
  const result = await executeTask(context, {
    argv: ['parallel.js'],
    mode: 'conc',
    variable: 'ACCOUNTS',
    selection: '1 2',
  });
  assert.equal(result.exitCode, 7);
  const log = fs.readFileSync(
    path.join(context.paths.dir_log, result.logPath),
    'utf8',
  );
  assert.match(log, /slow:start\nslow:end\nfast:start\nfast:end/);
  assert.deepEqual(fs.readdirSync(context.paths.dir_list_tmp), []);
});

test('concurrent log spool waits for peers and cleans up on invocation failure', async (t) => {
  const { orderedConcurrent } = require('../dist/local/concurrent');
  const root = sandbox(t);
  const chunks = [];
  let peerFinished = false;
  await assert.rejects(
    orderedConcurrent(
      root,
      [1, 2],
      async (account, output) => {
        if (account === 1) throw new Error('fixture invocation failure');
        await new Promise((resolve) => setTimeout(resolve, 30));
        output(Buffer.from('peer output'));
        peerFinished = true;
      },
      (chunk) => chunks.push(chunk.toString()),
    ),
    /fixture invocation failure/,
  );
  assert.equal(peerFinished, true);
  assert.equal(chunks.join(''), 'peer output');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('failed output sink rejects the process and terminates the writer', async () => {
  const { runProcess } = require('../dist/local/process');
  await assert.rejects(
    runProcess(
      process.execPath,
      ['-e', 'process.stdout.write("data");setInterval(()=>{},1000)'],
      {
        output: () => {
          throw new Error('fixture full disk');
        },
        timeoutMs: 3000,
      },
    ),
    /fixture full disk/,
  );
});

test(
  'timeout kills descendants holding pipes after their leader has exited',
  { timeout: 5000 },
  async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX process groups');
    const { runProcess } = require('../dist/local/process');
    let descendant;
    t.after(() => {
      if (descendant)
        try {
          process.kill(descendant, 'SIGKILL');
        } catch {}
    });
    const grandchild =
      'process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000)';
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(
      grandchild,
    )}],{stdio:['ignore',1,2]});setTimeout(()=>process.exit(0),100);`;
    const result = await runProcess(process.execPath, ['-e', parent], {
      timeoutMs: 350,
      graceMs: 100,
      output: (chunk) => {
        const pid = Number(chunk.toString().trim());
        if (pid) descendant = pid;
      },
    });
    assert.equal(result.code, 124);
    assert.equal(result.timedOut, true);
    assert.ok(descendant);
  },
);

test(
  'cancellation remains cancellation after the process leader exits',
  { timeout: 5000 },
  async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX process groups');
    const { runProcess } = require('../dist/local/process');
    const controller = new AbortController();
    let descendant;
    t.after(() => {
      if (descendant)
        try {
          process.kill(descendant, 'SIGKILL');
        } catch {}
    });
    const grandchild =
      'process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000)';
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(
      grandchild,
    )}],{stdio:['ignore',1,2]});setTimeout(()=>process.exit(0),50);`;
    const timer = setTimeout(() => controller.abort(), 300);
    t.after(() => clearTimeout(timer));
    const result = await runProcess(process.execPath, ['-e', parent], {
      signal: controller.signal,
      graceMs: 100,
      output: (chunk) => {
        descendant = Number(chunk.toString().trim());
      },
    });
    assert.equal(result.code, 143);
    assert.equal(result.timedOut, false);
  },
);

test('already cancelled execution never starts the requested program', async (t) => {
  const { runProcess } = require('../dist/local/process');
  const root = sandbox(t),
    marker = path.join(root, 'must-not-exist');
  for (const reason of [
    undefined,
    'SIGINT',
    'SIGHUP',
    'SIGTERM',
    'SIGKILL',
    new Error('cancel'),
  ]) {
    const controller = new AbortController();
    controller.abort(reason);
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`,
      ],
      { signal: controller.signal },
    );
    const expectedSignal =
      reason === 'SIGINT' || reason === 'SIGHUP' ? reason : 'SIGTERM';
    assert.equal(result.code, 128 + os.constants.signals[expectedSignal]);
    assert.equal(result.signal, expectedSignal);
    assert.equal(fs.existsSync(marker), false);
  }
});

test('hook exports reach scripts and after hooks share shell state with inline commands', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  const root = sandbox(t);
  const context = createContext(
    { root },
    { PATH: process.env.PATH, no_tee: 'true' },
  );
  fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
  fs.mkdirSync(context.paths.dir_config, { recursive: true });
  fs.writeFileSync(
    context.paths.file_task_before,
    `export FROM_BEFORE=before\ntask_before='export FROM_INLINE=inline'\n`,
  );
  fs.writeFileSync(
    path.join(context.paths.dir_scripts, 'hooks.js'),
    'console.log(process.env.FROM_BEFORE+":"+process.env.FROM_INLINE);process.exit(7)',
  );
  fs.writeFileSync(
    context.paths.file_task_after,
    `local_value=after\nhook_function() { printf 'hook:%s:%s:%s:%s\\n' "$FROM_BEFORE" "$FROM_INLINE" "$local_value" "$_task_exit_code"; }\ntask_after=hook_function\n`,
  );
  const result = await executeTask(context, {
    argv: ['hooks.js'],
    mode: 'now',
  });
  assert.equal(result.exitCode, 7);
  const log = fs.readFileSync(
    path.join(context.paths.dir_log, result.logPath),
    'utf8',
  );
  assert.match(log, /before:inline/);
  assert.match(log, /hook:before:inline:after:7/);
});

test('ordinary shell tasks share unexported variables and functions across before script and after hooks', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  const root = sandbox(t);
  const context = createContext(
    { root },
    { PATH: process.env.PATH, no_tee: 'true' },
  );
  fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
  fs.mkdirSync(context.paths.dir_config, { recursive: true });
  fs.writeFileSync(
    context.paths.file_task_before,
    'before_value=private\nbefore_function() { printf "before:%s\\n" "$before_value"; }\n',
  );
  fs.writeFileSync(
    path.join(context.paths.dir_scripts, 'shared.sh'),
    'before_function\nprintf "arg:%s\\n" "$1"\nscript_value=changed\nscript_function() { printf "script:%s\\n" "$script_value"; }\nreturn 7\n',
  );
  fs.writeFileSync(
    context.paths.file_task_after,
    'script_function\nprintf "after:%s:%s:%s\\n" "$before_value" "$script_value" "$_task_exit_code"\n',
  );
  const result = await executeTask(context, {
    argv: ['shared.sh'],
    scriptArgs: ['space value'],
    mode: 'now',
  });
  assert.equal(result.exitCode, 7);
  const log = fs.readFileSync(
    path.join(context.paths.dir_log, result.logPath),
    'utf8',
  );
  assert.match(
    log,
    /before:private\narg:space value\nscript:changed\nafter:private:changed:7/,
  );
});

test('task resolves modules from pnpm global root and restores the previous path for after hooks', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  const root = sandbox(t),
    bin = path.join(root, 'bin'),
    global = path.join(root, 'global modules');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(global, 'fixture-module'), { recursive: true });
  fs.writeFileSync(
    path.join(global, 'fixture-module/index.js'),
    'module.exports="global module loaded"',
  );
  fs.writeFileSync(
    path.join(bin, 'pnpm'),
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(global)});`,
    { mode: 0o755 },
  );
  const context = createContext(
    { root },
    { PATH: `${bin}:/usr/bin:/bin`, NODE_PATH: '/previous', no_tee: 'true' },
  );
  fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
  fs.mkdirSync(context.paths.dir_config, { recursive: true });
  fs.writeFileSync(
    path.join(context.paths.dir_scripts, 'dependency.js'),
    'console.log(require("fixture-module"));console.log(process.env.QL_NODE_GLOBAL_PATH)',
  );
  fs.writeFileSync(
    context.paths.file_task_after,
    'printf "after-path:%s:%s\\n" "$NODE_PATH" "${QL_NODE_GLOBAL_PATH-unset}"',
  );
  const result = await executeTask(context, {
    argv: ['dependency.js'],
    mode: 'now',
  });
  assert.equal(result.exitCode, 0);
  const log = fs.readFileSync(
    path.join(context.paths.dir_log, result.logPath),
    'utf8',
  );
  assert.match(log, /global module loaded/);
  assert.ok(log.includes(global));
  assert.match(log, /after-path:\/previous:unset/);
  assert.equal(context.env.NODE_PATH, '/previous');
  assert.equal(context.env.QL_NODE_GLOBAL_PATH, undefined);
});

test('missing optional pnpm still provides user dependency resolution', async (t) => {
  const { taskDependencyEnvironment } = require('../dist/local/dependencies');
  const context = createContext(
    { root: sandbox(t) },
    {
      PATH: '/missing-bin',
      NODE_PATH: '/previous',
      QL_NODE_GLOBAL_PATH: '/stale',
    },
  );
  const env = await taskDependencyEnvironment(context);
  assert.equal(
    env.NODE_PATH,
    `/previous${path.delimiter}${context.paths.dir_dep}`,
  );
  assert.equal(env.QL_NODE_GLOBAL_PATH, undefined);
  assert.equal(context.env.QL_NODE_GLOBAL_PATH, '/stale');
});

test('missing script directory never falls back to an unrelated same-name script', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  const context = createContext(
    { root: sandbox(t) },
    { PATH: process.env.PATH, no_tee: 'true' },
  );
  fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
  fs.writeFileSync(
    path.join(context.paths.dir_scripts, 'same.js'),
    'console.log("WRONG SCRIPT EXECUTED")',
  );
  const result = await executeTask(context, {
    argv: ['missing/same.js'],
    mode: 'now',
  });
  assert.notEqual(result.exitCode, 0);
  const log = fs.readFileSync(
    path.join(context.paths.dir_log, result.logPath),
    'utf8',
  );
  assert.doesNotMatch(log, /WRONG SCRIPT EXECUTED/);
});

test('nested script paths and explicit working directories preserve legacy selection and exact arguments', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  const root = fs.realpathSync(sandbox(t));
  const context = createContext(
    { root },
    { PATH: process.env.PATH, no_tee: 'true' },
  );
  const nested = path.join(context.paths.dir_scripts, 'space directory');
  const work = path.join(context.paths.dir_scripts, 'work');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(work);
  const script =
    'console.log("RESULT:"+JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))';
  fs.writeFileSync(path.join(nested, 'file.js'), script);
  fs.writeFileSync(path.join(work, 'file.js'), script);
  for (const [argv, working, expected] of [
    [['space directory/file.js'], undefined, nested],
    [[path.join(nested, 'file.js')], undefined, nested],
    [['space directory/file.js'], 'work', work],
  ]) {
    context.env.work_dir = working;
    const result = await executeTask(context, {
      argv,
      scriptArgs: ['a b', '--flag=value'],
      mode: 'now',
    });
    assert.equal(result.exitCode, 0);
    const log = fs.readFileSync(
      path.join(context.paths.dir_log, result.logPath),
      'utf8',
    );
    const record = JSON.parse(
      log
        .split('\n')
        .find((line) => line.startsWith('RESULT:'))
        .slice(7),
    );
    assert.deepEqual(record, { cwd: expected, args: ['a b', '--flag=value'] });
  }
});

test('task lifecycle logs honor QL_LANG with Chinese fallback', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  const { translate } = require('../dist/i18n');
  const root = sandbox(t);
  const context = createContext(
    { root },
    { PATH: process.env.PATH, no_tee: 'true', QL_LANG: 'en' },
  );
  fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
  fs.writeFileSync(
    path.join(context.paths.dir_scripts, 'language.js'),
    'process.exit(3)',
  );
  const result = await executeTask(context, {
    argv: ['language.js'],
    mode: 'now',
  });
  const log = fs.readFileSync(
    path.join(context.paths.dir_log, result.logPath),
    'utf8',
  );
  assert.match(log, /## Starting/);
  assert.match(log, /Failed.*exit code 3/);
  assert.equal(translate({ QL_LANG: 'unknown' }, '完成'), '完成');
  assert.equal(translate({ QL_LANG: 'en' }, '完成'), 'Completed');
  assert.equal(
    translate({ QL_LANG: 'en' }, 'unknown %s %%', 'value'),
    'unknown value %',
  );
});

test('designated shell accounts retain hook functions and script state in a shared session', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  const context = createContext(
    { root: sandbox(t) },
    { PATH: process.env.PATH, no_tee: 'true' },
  );
  for (const dir of [
    context.paths.dir_scripts,
    context.paths.dir_config,
    context.paths.dir_preload,
  ])
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    context.paths.file_env,
    'export ACCOUNTS="first&second&third"\n',
  );
  fs.writeFileSync(
    context.paths.file_task_before,
    'private_function() { printf "selected:%s\\n" "$ACCOUNTS"; }\n',
  );
  fs.writeFileSync(
    path.join(context.paths.dir_scripts, 'accounts.sh'),
    'private_function\nprivate_result=from_script\nreturn 4\n',
  );
  fs.writeFileSync(
    context.paths.file_task_after,
    'printf "after:%s:%s:%s\\n" "$ACCOUNTS" "$private_result" "$_task_exit_code"\n',
  );
  const result = await executeTask(context, {
    argv: ['accounts.sh'],
    mode: 'desi',
    variable: 'ACCOUNTS',
    selection: '3 1',
  });
  assert.equal(result.exitCode, 4);
  const log = fs.readFileSync(
    path.join(context.paths.dir_log, result.logPath),
    'utf8',
  );
  assert.match(log, /selected:third&first\nafter:third&first:from_script:4/);
});

test('lifecycle reports share execution identity and statistics survive a rejected final status', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  const context = createContext(
    { root: sandbox(t) },
    {
      PATH: process.env.PATH,
      no_tee: 'true',
      QL_CLI_LIFECYCLE: 'extended',
      ID: '12',
      QL_EXECUTION_ORIGIN: 'scheduled_system',
    },
  );
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: req.url, method: req.method, body });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({ code: body.status === '1' ? 500 : 200, data: {} }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  context.env.QlPort = String(server.address().port);
  fs.mkdirSync(context.paths.dir_config, { recursive: true });
  fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
  fs.writeFileSync(
    context.paths.file_auth_token,
    JSON.stringify({
      value: 'fixture-token',
      expiration: Date.now() / 1000 + 1000,
    }),
  );
  fs.writeFileSync(
    path.join(context.paths.dir_scripts, 'failed.js'),
    'process.exit(9)',
  );
  const result = await executeTask(context, {
    argv: ['failed.js'],
    mode: 'now',
  });
  assert.equal(result.exitCode, 9);
  assert.equal(requests.length, 3);
  const [start, end, stat] = requests;
  assert.equal(start.url, '/open/crons/status');
  assert.equal(end.url, start.url);
  assert.equal(start.method, 'PUT');
  assert.equal(end.method, 'PUT');
  assert.deepEqual(start.body.ids, [12]);
  assert.equal(start.body.status, '0');
  assert.equal(end.body.status, '1');
  assert.equal(start.body.exit_code, undefined);
  assert.equal(end.body.exit_code, 9);
  assert.equal(start.body.execution_id, end.body.execution_id);
  assert.equal(end.body.execution_id, result.executionId);
  assert.match(result.executionId, /^legacy-system:\d+:[0-9a-f-]{36}$/);
  assert.equal(start.body.log_path, result.logPath);
  assert.equal(end.body.last_execution_time, start.body.last_execution_time);
  assert.equal(stat.url, '/open/dashboard/record');
  assert.equal(stat.method, 'POST');
  assert.deepEqual(stat.body, {
    ref_id: 12,
    code: 9,
    elapsed: result.durationSeconds,
  });
  assert.match(
    fs.readFileSync(path.join(context.paths.dir_log, result.logPath), 'utf8'),
    /任务状态上报失败/,
  );
});

test('configuration functions survive the environment bridge without sourcing config twice', async (t) => {
  const { localContext } = require('../dist/local/context');
  const { executeTask } = require('../dist/local/taskRunner');
  const root = fs.realpathSync(sandbox(t));
  const initial = createContext({ root });
  fs.mkdirSync(initial.paths.dir_config, { recursive: true });
  fs.mkdirSync(initial.paths.dir_scripts, { recursive: true });
  const marker = path.join(root, 'config-loads');
  fs.writeFileSync(
    initial.paths.file_config_user,
    `no_tee=true\nprintf 'loaded\\n' >> '${marker}'\nconfiguration_function() { printf 'configuration-function\\n'; }\n`,
  );
  fs.writeFileSync(
    path.join(initial.paths.dir_scripts, 'configuration.sh'),
    'configuration_function\n',
  );
  const context = await localContext({
    values: { root },
    positionals: ['configuration.sh'],
  });
  const result = await executeTask(context, {
    argv: ['configuration.sh'],
    mode: 'now',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'loaded\n');
  assert.match(
    fs.readFileSync(path.join(context.paths.dir_log, result.logPath), 'utf8'),
    /configuration-function/,
  );
});

test('concurrent shell tasks inherit hook functions but isolate script state and run after hook once', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  const context = createContext(
    { root: fs.realpathSync(sandbox(t)) },
    { PATH: process.env.PATH, no_tee: 'true', ACCOUNTS: 'one&two' },
  );
  fs.mkdirSync(context.paths.dir_config, { recursive: true });
  fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
  const marker = path.join(context.root, 'hooks');
  fs.writeFileSync(
    context.paths.file_task_before,
    `printf 'before\\n' >> '${marker}'\nshared_value=before\nhook_function() { printf 'account:%s:%s\\n' "$ACCOUNTS" "$shared_value"; }\n`,
  );
  fs.writeFileSync(
    path.join(context.paths.dir_scripts, 'concurrent.sh'),
    'hook_function\nshared_value=script_changed\n',
  );
  fs.writeFileSync(
    context.paths.file_task_after,
    `printf 'after:%s\\n' "$shared_value" >> '${marker}'\n`,
  );
  const result = await executeTask(context, {
    argv: ['concurrent.sh'],
    mode: 'conc',
    variable: 'ACCOUNTS',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'before\nafter:before\n');
  const log = fs.readFileSync(
    path.join(context.paths.dir_log, result.logPath),
    'utf8',
  );
  assert.match(log, /account:one:before\naccount:two:before/);
});

test('cancelling after hooks preserves the signal and final task status', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  for (const extension of ['js', 'sh']) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      await t.test(`${extension}: ${signal}`, async () => {
        const context = createContext(
          { root: sandbox(t) },
          { PATH: process.env.PATH },
        );
        fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
        fs.mkdirSync(context.paths.dir_config, { recursive: true });
        fs.writeFileSync(
          path.join(context.paths.dir_scripts, `done.${extension}`),
          extension === 'js' ? 'process.exit(7)' : 'return 7\n',
        );
        fs.writeFileSync(
          context.paths.file_task_after,
          "trap 'echo received:SIGINT; exit 23' INT\n" +
            "trap 'echo received:SIGTERM; exit 23' TERM\n" +
            "trap 'echo received:SIGHUP; exit 23' HUP\n" +
            'echo after-ready:$_task_exit_code\nwhile :; do sleep 0.1; done\n',
        );
        const controller = new AbortController();
        let output = '',
          cancelled = false;
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const result = await executeTask(context, {
            argv: [`done.${extension}`],
            mode: 'now',
            signal: controller.signal,
            output: (chunk) => {
              output += chunk;
              if (!cancelled && output.includes('after-ready:7')) {
                cancelled = true;
                controller.abort(signal);
              }
            },
          });
          assert.equal(cancelled, true, output);
          assert.equal(result.exitCode, 128 + os.constants.signals[signal]);
          assert.equal(result.timedOut, false);
          assert.deepEqual(output.match(/received:SIG\w+/g), [
            `received:${signal}`,
          ]);
          const log = fs.readFileSync(
            path.join(context.paths.dir_log, result.logPath),
            'utf8',
          );
          assert.ok(log.includes(`退出码 ${result.exitCode}`));
        } finally {
          clearTimeout(timer);
        }
      });
    }
  }
});

test('cancelled script does not start an independent after hook', async (t) => {
  const { executeTask } = require('../dist/local/taskRunner');
  const context = createContext(
    { root: sandbox(t) },
    { PATH: process.env.PATH },
  );
  fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
  fs.mkdirSync(context.paths.dir_config, { recursive: true });
  fs.writeFileSync(
    path.join(context.paths.dir_scripts, 'cancel.js'),
    'console.log("script-ready");setInterval(()=>{},1000)',
  );
  fs.writeFileSync(context.paths.file_task_after, 'echo after-must-not-run\n');
  const controller = new AbortController();
  let output = '',
    cancelled = false;
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const result = await executeTask(context, {
      argv: ['cancel.js'],
      mode: 'now',
      signal: controller.signal,
      output: (chunk) => {
        output += chunk;
        if (!cancelled && output.includes('script-ready')) {
          cancelled = true;
          controller.abort('SIGTERM');
        }
      },
    });
    assert.equal(cancelled, true);
    assert.equal(result.exitCode, 143);
    assert.doesNotMatch(output, /after-must-not-run/);
  } finally {
    clearTimeout(timer);
  }
});

test('fd3 capture keeps configuration data separate and enforces its own size limit', async () => {
  let output = '';
  const result = await runProcess(
    process.execPath,
    [
      '-e',
      'console.log("user-output");console.error("user-error");require("fs").writeSync(3,"private-data")',
    ],
    {
      capture: true,
      captureFd: 3,
      maxCaptureBytes: 12,
      output: (chunk) => {
        output += chunk;
      },
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'private-data');
  assert.match(output, /user-output/);
  assert.match(output, /user-error/);
  assert.doesNotMatch(output, /private-data/);
  await assert.rejects(
    runProcess(
      process.execPath,
      [
        '-e',
        'require("fs").writeSync(3,Buffer.alloc(1024));setInterval(()=>{},1000)',
      ],
      {
        capture: true,
        captureFd: 3,
        maxCaptureBytes: 64,
        output: () => {},
      },
    ),
    /capture limit|捕获上限/,
  );
});

test('pre-cancelled configuration is never sourced', async (t) => {
  const root = sandbox(t),
    file = path.join(root, 'config.sh'),
    marker = path.join(root, 'marker');
  fs.writeFileSync(file, 'touch "$MARKER"\n');
  const controller = new AbortController();
  controller.abort('SIGINT');
  await assert.rejects(
    sourceEnvironment({ PATH: process.env.PATH, MARKER: marker }, [file], [], {
      signal: controller.signal,
    }),
    { name: 'AbortError', code: 'ABORT_ERR' },
  );
  assert.equal(fs.existsSync(marker), false);
});
