const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createContext } = require('../../dist/internal/runtime/context');
const {
  repairConfiguration,
  installPanelDependencies,
  startPanel,
} = require('../../dist/internal/maintenance/operator');
const {
  replaceAndReload,
  stageUpgrade,
  reloadPanel,
} = require('../../dist/internal/maintenance/upgrade');
const { parse } = require('../helpers/commands.cjs');
const {
  writeManifest,
  sourceCommit,
} = require('../../../test/helpers/upgrade-fixture.cjs');

async function fixture(t) {
  t.mock.method(
    require('../../dist/internal/maintenance/upgradeArtifacts.cjs'),
    'waitForHealth',
    async () => {},
  );
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql-operator-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = createContext(
    { root },
    { PATH: '/usr/bin:/bin', QL_LANG: 'en' },
  );
  await fs.mkdir(path.join(root, 'sample'));
  for (const file of [
    'config.sample.sh',
    'task.sample.sh',
    'extra.sample.sh',
    'notify.py',
    'notify.js',
    'ql_sample.js',
    'ql_sample.py',
  ])
    await fs.writeFile(path.join(root, 'sample', file), `sample:${file}`);
  return context;
}

async function stub(context, program, body) {
  const bin = path.join(context.root, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(
    path.join(bin, program),
    `#!${process.execPath}\n${body}`,
    { mode: 0o755 },
  );
  context.env.PATH = `${bin}:/usr/bin:/bin`;
}

async function stubRuntimeTools(context, record) {
  const prefix = path.join(context.root, 'global-prefix');
  await stub(
    context,
    'npm',
    `${record}
if(process.argv[2]==='prefix') process.stdout.write(${JSON.stringify(
      prefix,
    )}+'\\n');`,
  );
  await fs.mkdir(path.join(context.root, 'scripts'), { recursive: true });
  await fs.writeFile(
    path.join(context.root, 'scripts/install-runtime-tools.cjs'),
    record,
  );
  return prefix;
}

test('configuration repair preserves custom content and intentionally empty hooks', async (t) => {
  const ctx = await fixture(t);
  await fs.mkdir(ctx.paths.dir_config, { recursive: true });
  await fs.writeFile(ctx.paths.file_config_user, 'custom configuration');
  await fs.writeFile(ctx.paths.file_task_before, '');
  assert.equal((await repairConfiguration(ctx)).length, 8);
  assert.equal(
    await fs.readFile(ctx.paths.file_config_user, 'utf8'),
    'custom configuration',
  );
  assert.equal(await fs.readFile(ctx.paths.file_task_before, 'utf8'), '');
  assert.deepEqual(await repairConfiguration(ctx), []);
  await fs.writeFile(ctx.paths.file_notify_py, '');
  assert.deepEqual(await repairConfiguration(ctx), [ctx.paths.file_notify_py]);
});

async function stubPanelDependencies(context, body) {
  await fs.mkdir(path.join(context.root, 'scripts'), { recursive: true });
  await fs.writeFile(
    path.join(context.root, 'scripts/install-panel-dependencies.cjs'),
    body,
  );
}

test('dependency installation uses the installed helper and preserves root, static and commit arguments', async (t) => {
  const ctx = await fixture(t);
  ctx.env.CALLS = path.join(ctx.root, 'dependencies.jsonl');
  const record =
    'require("node:fs").appendFileSync(process.env.CALLS,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),termux:process.env.is_termux||""})+"\\n");';
  await stubPanelDependencies(ctx, record);
  await installPanelDependencies(ctx);
  ctx.env.is_termux = '1';
  await installPanelDependencies(ctx);
  const source = path.join(ctx.root, 'source ;$(touch SHOULD_NOT_RUN)');
  const staticRoot = path.join(ctx.root, 'static ;$(touch SHOULD_NOT_RUN)');
  await fs.mkdir(source);
  await installPanelDependencies(ctx, source, staticRoot, sourceCommit);
  const calls = (await fs.readFile(ctx.env.CALLS, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(calls, [
    { args: ['--root', ctx.root], cwd: ctx.root, termux: '0' },
    { args: ['--root', ctx.root], cwd: ctx.root, termux: '1' },
    {
      args: [
        '--root',
        source,
        '--static-dir',
        staticRoot,
        '--source-commit',
        sourceCommit,
      ],
      cwd: source,
      termux: '1',
    },
  ]);
  for (const directory of [ctx.root, source])
    await assert.rejects(fs.stat(path.join(directory, 'SHOULD_NOT_RUN')), {
      code: 'ENOENT',
    });
});

test('PM2 reload uses installation cwd and exact process-manager arguments', async (t) => {
  const ctx = await fixture(t);
  ctx.env.CALLS = path.join(ctx.root, 'pm2.jsonl');
  await stub(
    ctx,
    'pm2',
    'require("node:fs").appendFileSync(process.env.CALLS,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})+"\\n");',
  );
  assert.deepEqual(await startPanel(ctx), { manager: 'pm2' });
  const calls = (await fs.readFile(ctx.env.CALLS, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ['flush'],
      ['startOrGracefulReload', 'ecosystem.config.js', '--update-env'],
    ],
  );
  assert.ok(calls.every((c) => c.cwd === ctx.root));
});

test('PM2 restarts retain configured ports without mutating legacy environment', async (t) => {
  const ctx = await fixture(t);
  ctx.env.CALLS = path.join(ctx.root, 'ports.jsonl');
  ctx.env.BACK_PORT = '5600';
  ctx.env.GRPC_PORT = '5400';
  await stub(
    ctx,
    'pm2',
    'require("node:fs").appendFileSync(process.env.CALLS, JSON.stringify([process.env.BACK_PORT,process.env.GRPC_PORT])+"\\n");',
  );
  await startPanel(ctx);
  ctx.env.QlPort = '5799';
  ctx.env.QlGrpcPort = '5599';
  await startPanel(ctx);
  assert.deepEqual(
    (await fs.readFile(ctx.env.CALLS, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse),
    [
      ['5700', '5500'],
      ['5700', '5500'],
      ['5799', '5599'],
      ['5799', '5599'],
    ],
  );
  assert.equal(ctx.env.BACK_PORT, '5600');
  assert.equal(ctx.env.GRPC_PORT, '5400');
});

test('failed service start restores all replaced files and restarts the previous version', async (t) => {
  const ctx = await fixture(t);
  const target = path.join(ctx.root, 'installed');
  const source = path.join(ctx.root, 'staged');
  await fs.mkdir(target);
  await fs.mkdir(source);
  await fs.writeFile(path.join(target, 'old'), 'old');
  await fs.writeFile(path.join(source, 'new'), 'new');
  let starts = 0,
    stops = 0;
  await assert.rejects(
    replaceAndReload(ctx, [{ source, target }], {
      stop: async () => {
        stops++;
      },
      start: async () => {
        if (++starts === 1) {
          assert.equal(
            await fs.readFile(path.join(target, 'new'), 'utf8'),
            'new',
          );
          throw new Error('startup failed');
        }
        assert.equal(
          await fs.readFile(path.join(target, 'old'), 'utf8'),
          'old',
        );
      },
    }),
    /startup failed/,
  );
  assert.equal(stops, 2);
  assert.equal(starts, 2);
  assert.deepEqual(await fs.readdir(target), ['old']);
  assert.ok(
    !(await fs.readdir(ctx.root)).some((name) => name.includes('ql-backup')),
  );
  await replaceAndReload(ctx, [{ source, target }], {
    stop: async () => {},
    start: async () => ({ manager: 'fixture' }),
  });
  assert.deepEqual(await fs.readdir(target), ['new']);
});

test('incomplete upgrade download cannot stop services or change installed files', async (t) => {
  const ctx = await fixture(t);
  await fs.writeFile(path.join(ctx.root, 'package.json'), '{"name":"old"}');
  await stub(ctx, 'curl', 'process.exit(22);');
  await assert.rejects(stageUpgrade(ctx, 'github'), /exit 22/);
  assert.equal(
    await fs.readFile(path.join(ctx.root, 'package.json'), 'utf8'),
    '{"name":"old"}',
  );
  assert.deepEqual(await fs.readdir(ctx.paths.dir_tmp), []);
  assert.throws(() => parse(['update'], 'public'));
  assert.equal(
    parse(['update', '--download-only'], 'local').values['download-only'],
    true,
  );
  assert.throws(() => parse(['reload', '--target', 'arbitrary'], 'local'));
});

test('upgrade staging extracts both archives before publishing readiness and rejects archive symlinks', async (t) => {
  const { execFileSync } = require('node:child_process');
  const ctx = await fixture(t);
  const payloads = path.join(ctx.root, 'payloads');
  const archives = path.join(ctx.root, 'archives');
  await fs.mkdir(archives);
  await fs.mkdir(path.join(payloads, `qinglong-${sourceCommit}`), {
    recursive: true,
  });
  await fs.mkdir(path.join(payloads, 'qinglong-static-master/build'), {
    recursive: true,
  });
  const manifest = '{"name":"fixture"}';
  await fs.writeFile(path.join(ctx.root, 'package.json'), manifest);
  await fs.writeFile(
    path.join(payloads, `qinglong-${sourceCommit}/package.json`),
    manifest,
  );
  await fs.writeFile(
    path.join(payloads, 'qinglong-static-master/build/app.js'),
    'console.log("fixture")',
  );
  await fs.mkdir(path.join(payloads, `qinglong-${sourceCommit}/sample`));
  await fs.writeFile(
    path.join(payloads, `qinglong-${sourceCommit}/sample/config.sample.sh`),
    'new sample',
  );
  writeManifest(
    path.join(payloads, `qinglong-${sourceCommit}`),
    path.join(payloads, 'qinglong-static-master'),
  );
  await fs.writeFile(path.join(ctx.root, 'pnpm-lock.yaml'), 'fixture lock\n');
  await fs.mkdir(path.join(ctx.root, 'node_modules'));
  for (const repo of ['qinglong', 'qinglong-static'])
    execFileSync(
      '/usr/bin/zip',
      [
        '-qry',
        path.join(archives, `${repo}.zip`),
        `${repo}-${repo === 'qinglong' ? sourceCommit : 'master'}`,
      ],
      { cwd: payloads },
    );
  ctx.env.ARCHIVES = archives;
  await stub(
    ctx,
    'curl',
    'const fs=require("node:fs"),p=require("node:path"),args=process.argv.slice(2),out=args[args.indexOf("--output")+1]; fs.copyFileSync(p.join(process.env.ARCHIVES,p.basename(out)),out);',
  );
  const staged = await stageUpgrade(ctx, 'github');
  assert.equal(
    await fs.readFile(path.join(staged.source, 'package.json'), 'utf8'),
    manifest,
  );
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(path.dirname(staged.source), 'ready.json'),
        'utf8',
      ),
    ),
    { ...staged, sourceCommit, dependenciesChanged: false },
  );
  await fs.writeFile(
    path.join(ctx.root, 'package.json'),
    '{"name":"older-installed"}',
  );
  ctx.env.CALLS = path.join(ctx.root, 'upgrade-dependencies.jsonl');
  await stubPanelDependencies(ctx, 'process.exit(23);');
  await assert.rejects(stageUpgrade(ctx, 'github'), /exit 23/);
  const ready = path.join(ctx.paths.dir_tmp, 'upgrade-ready-master.json');
  assert.deepEqual(JSON.parse(await fs.readFile(ready, 'utf8')), {
    directory: path.basename(path.dirname(staged.source)),
  });
  assert.equal(
    await fs.readFile(path.join(ctx.root, 'package.json'), 'utf8'),
    '{"name":"older-installed"}',
  );
  await stubPanelDependencies(
    ctx,
    'const fs=require("node:fs"),p=require("node:path"),args=process.argv.slice(2);fs.appendFileSync(process.env.CALLS,JSON.stringify({args,cwd:process.cwd()})+"\\n");fs.mkdirSync(p.join(args[args.indexOf("--root")+1],"node_modules"),{recursive:true});',
  );
  const changedStage = await stageUpgrade(ctx, 'github');
  assert.deepEqual(
    JSON.parse((await fs.readFile(ctx.env.CALLS, 'utf8')).trim()),
    {
      args: [
        '--root',
        changedStage.source,
        '--static-dir',
        changedStage.static,
        '--source-commit',
        sourceCommit,
      ],
      cwd: changedStage.source,
    },
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(path.dirname(changedStage.source), 'ready.json'),
        'utf8',
      ),
    ).dependenciesChanged,
    true,
  );
  await fs.symlink(
    '../../outside',
    path.join(payloads, `qinglong-${sourceCommit}/escape`),
  );
  execFileSync(
    '/usr/bin/zip',
    ['-qry', path.join(archives, 'qinglong.zip'), `qinglong-${sourceCommit}`],
    { cwd: payloads },
  );
  await assert.rejects(stageUpgrade(ctx, 'github'), /symlinks/);
  assert.deepEqual(
    (await fs.readdir(ctx.paths.dir_tmp)).sort(),
    [
      path.basename(path.dirname(changedStage.source)),
      'upgrade-ready-master.json',
    ].sort(),
  );
  await repairConfiguration(ctx);
  await stub(ctx, 'pm2', '');
  await reloadPanel(ctx, 'system');
  assert.equal(
    await fs.readFile(
      path.join(ctx.paths.dir_config, 'config.sample.sh'),
      'utf8',
    ),
    'new sample',
  );
  assert.equal(
    await fs.readFile(path.join(ctx.paths.dir_static, 'build/app.js'), 'utf8'),
    'console.log("fixture")',
  );
});

test('check repairs dependencies and notifications, probes loopback and reloads with clean diagnostics', async (t) => {
  const http = require('node:http');
  const {
    checkAndRepair,
    diagnosticLog,
    inspectPanel,
  } = require('../../dist/internal/maintenance/check');
  const ctx = await fixture(t);
  const routes = [];
  const server = http.createServer((req, res) => {
    routes.push(req.url);
    res.end(
      req.url === '/'
        ? '<html><div id="root"></div></html>'
        : '{"code":200,"data":{"status":"ok"}}',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  ctx.env.QlPort = String(server.address().port);
  ctx.env.CALLS = path.join(ctx.root, 'operations.jsonl');
  ctx.env.PM2_HOME = path.join(ctx.root, 'pm2');
  ctx.env.HTTP_PROXY = 'http://127.0.0.1:1';
  const record =
    'require("node:fs").appendFileSync(process.env.CALLS,JSON.stringify({program:require("node:path").basename(process.argv[1]),args:process.argv.slice(2)})+"\\n");';
  for (const executable of ['pnpm', 'pm2']) await stub(ctx, executable, record);
  const toolsPrefix = await stubRuntimeTools(ctx, record);
  await stubPanelDependencies(ctx, record);
  await repairConfiguration(ctx);
  await fs.writeFile(ctx.paths.file_notify_py, 'custom old notify');
  await fs.mkdir(path.join(ctx.env.PM2_HOME, 'logs'), { recursive: true });
  const logfile = path.join(ctx.env.PM2_HOME, 'logs/qinglong-out.log');
  await fs.writeFile(
    logfile,
    Array.from({ length: 350 }, (_, i) => `line ${i}`).join('\n') + '\n',
  );
  const result = await checkAndRepair(ctx);
  assert.equal(
    await fs.readFile(ctx.paths.file_notify_py, 'utf8'),
    'sample:notify.py',
  );
  assert.equal(result.before.panel.healthy, true);
  assert.equal(result.after.backend.healthy, true);
  assert.equal(result.service.manager, 'pm2');
  assert.equal(result.logs[0].text.split('\n').length, 300);
  assert.equal(result.logs[0].text.split('\n')[0], 'line 50');
  assert.equal(result.logs[1].error, 'Log is absent.');
  const calls = (await fs.readFile(ctx.env.CALLS, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(calls, [
    {
      program: 'npm',
      args: ['prefix', '--global'],
    },
    {
      program: 'install-runtime-tools.cjs',
      args: [
        '--archive',
        path.join(ctx.root, 'static/runtime-tools.tgz'),
        '--proof',
        path.join(ctx.root, 'static/runtime-tools-proof.json'),
        '--prefix',
        toolsPrefix,
      ],
    },
    {
      program: 'install-panel-dependencies.cjs',
      args: ['--root', ctx.root],
    },
    { program: 'pm2', args: ['flush'] },
    {
      program: 'pm2',
      args: ['startOrGracefulReload', 'ecosystem.config.js', '--update-env'],
    },
  ]);
  assert.equal(routes.length, 4);
  assert.equal(
    routes.filter((route) => route.startsWith('/api/health?t=')).length,
    2,
  );
  await fs.writeFile(logfile, 'x'.repeat(1024 * 1024) + '\nlast line\n');
  assert.deepEqual(await diagnosticLog(logfile), {
    file: logfile,
    text: 'last line',
    truncated: true,
  });
  ctx.env.QlPort = '5700/remote';
  await assert.rejects(inspectPanel(ctx), /QlPort/);
  assert.throws(() => parse(['check'], 'public'));
  assert.equal(parse(['check'], 'local').name, 'local check');
});

test('diagnostics reject redirects and HTTP errors without following a remote target', async (t) => {
  const http = require('node:http');
  const { inspectPanel } = require('../../dist/internal/maintenance/check');
  const ctx = await fixture(t);
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(302, { Location: 'http://example.invalid/' });
      res.end('<div id="root"></div>');
    } else {
      res.writeHead(503);
      res.end('{"code":200}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  ctx.env.QlPort = String(server.address().port);
  const result = await inspectPanel(ctx);
  assert.deepEqual(result, {
    panel: { healthy: false, status: 302 },
    backend: { healthy: false, status: 503 },
  });
});

test('repair stops after installer failure before replacing user files or reloading', async (t) => {
  const { checkAndRepair } = require('../../dist/internal/maintenance/check');
  const ctx = await fixture(t);
  await repairConfiguration(ctx);
  await fs.writeFile(ctx.paths.file_notify_js, 'keep existing notification');
  await stub(ctx, 'npm', 'process.exit(17);');
  await stub(
    ctx,
    'pm2',
    'require("node:fs").writeFileSync(process.env.QL_DIR+"/unexpected-reload", "bad");',
  );
  await assert.rejects(checkAndRepair(ctx), /exit 17/);
  assert.equal(
    await fs.readFile(ctx.paths.file_notify_js, 'utf8'),
    'keep existing notification',
  );
  await assert.rejects(fs.stat(path.join(ctx.root, 'unexpected-reload')), {
    code: 'ENOENT',
  });
});

test('dependency helper failure preserves notifications and prevents a service reload', async (t) => {
  const { checkAndRepair } = require('../../dist/internal/maintenance/check');
  const ctx = await fixture(t);
  await repairConfiguration(ctx);
  await fs.writeFile(ctx.paths.file_notify_js, 'keep installed notification');
  await stubRuntimeTools(ctx, '');
  await stubPanelDependencies(ctx, 'process.exit(19);');
  await stub(
    ctx,
    'pm2',
    'require("node:fs").writeFileSync(process.env.QL_DIR+"/unexpected-reload", "bad");',
  );
  await assert.rejects(checkAndRepair(ctx), /exit 19/);
  assert.equal(
    await fs.readFile(ctx.paths.file_notify_js, 'utf8'),
    'keep installed notification',
  );
  await assert.rejects(fs.stat(path.join(ctx.root, 'unexpected-reload')), {
    code: 'ENOENT',
  });
});

test('legacy check workflow and TypeScript repair agree on dependency and notification operations', async (t) => {
  const { execFileSync } = require('node:child_process');
  const ctx = await fixture(t);
  await repairConfiguration(ctx);
  const trace = path.join(ctx.root, 'legacy-trace');
  const shell = `
    t() { :; }
    npm() { printf 'npm %s\\n' "$*" >> "$TRACE"; printf '%s\\n' "$dir_root/global-prefix"; }
    node() { printf 'tools %s\\n' "$*" >> "$TRACE"; }
    fix_config() { printf 'repair-config\\n' >> "$TRACE"; }
    npm_install_2() { printf 'dependencies %s\\n' "$1" >> "$TRACE"; }
    cp() { printf 'copy %s\\n' "$*" >> "$TRACE"; command cp "$@"; }
    curl() {
      case "$*" in
        *'/api/health'*|*'/api/system'*) printf '{"code":200,"data":{},"status":"ok"}' ;;
        *) printf '<div id="root"></div>' ;;
      esac
    }
    tail() { :; }
    reload_pm2() { printf 'reload\\n' >> "$TRACE"; }
    . "$CHECK_SOURCE"
  `;
  execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', shell], {
    env: {
      ...ctx.env,
      TRACE: trace,
      CHECK_SOURCE: path.resolve(__dirname, '../../../shell/check.sh'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const operations = (await fs.readFile(trace, 'utf8')).trim().split('\n');
  assert.deepEqual(operations, [
    'npm prefix --global',
    `tools ${ctx.root}/scripts/install-runtime-tools.cjs --archive ${ctx.root}/static/runtime-tools.tgz --proof ${ctx.root}/static/runtime-tools-proof.json --prefix ${ctx.root}/global-prefix`,
    'repair-config',
    `dependencies ${ctx.root}`,
    `copy -fv ${ctx.paths.file_notify_py_sample} ${ctx.paths.file_notify_py}`,
    `copy -fv ${ctx.paths.file_notify_js_sample} ${ctx.paths.file_notify_js}`,
    'reload',
  ]);
  assert.equal(
    await fs.readFile(ctx.paths.file_notify_js, 'utf8'),
    'sample:notify.js',
  );
  assert.equal(
    await fs.readFile(ctx.paths.file_notify_py, 'utf8'),
    'sample:notify.py',
  );
});

test('legacy check aborts dependency failure before copying notifications or reloading', async (t) => {
  const { execFileSync } = require('node:child_process');
  const ctx = await fixture(t);
  await repairConfiguration(ctx);
  await fs.writeFile(ctx.paths.file_notify_js, 'keep legacy notification');
  const shell = `
    t() { :; }
    npm() { printf '%s\\n' "$dir_root/global-prefix"; }
    node() { :; }
    fix_config() { :; }
    npm_install_2() { return 19; }
    reload_pm2() { printf unexpected > "$dir_root/unexpected-reload"; }
    curl() { printf '<div id="root"></div>{"code":200,"status":"ok"}'; }
    . "$CHECK_SOURCE"
  `;
  assert.throws(
    () =>
      execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', shell], {
        env: {
          ...ctx.env,
          CHECK_SOURCE: path.resolve(__dirname, '../../../shell/check.sh'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    (error) => error.status === 19,
  );
  assert.equal(
    await fs.readFile(ctx.paths.file_notify_js, 'utf8'),
    'keep legacy notification',
  );
  await assert.rejects(fs.stat(path.join(ctx.root, 'unexpected-reload')), {
    code: 'ENOENT',
  });
});

test('installed upgrade hooks propagate returned failures and preserve legacy installer status', async (t) => {
  const {
    withLifecycleHooks,
  } = require('../../dist/internal/maintenance/upgradeArtifacts.cjs');
  for (const [returned, legacy, expected] of [
    [19, 0, 19],
    [0, 23, 23],
    [0, 0, 0],
  ]) {
    const ctx = await fixture(t);
    const tmp = path.join(ctx.root, 'tmp');
    await fs.mkdir(tmp);
    await fs.mkdir(path.join(ctx.root, 'shell'));
    const trace = path.join(ctx.root, 'install-args');
    await fs.writeFile(path.join(ctx.root, 'shell/env.sh'), '');
    await fs.writeFile(
      path.join(ctx.root, 'shell/share.sh'),
      `import_config() { :; }
npm_install_2() {
  printf '%s\\n' "$@" > "$QL_INSTALL_TRACE"
  exit_status=${legacy}
  return ${returned}
}
`,
    );
    const args = [
      path.join(ctx.root, 'staged source;$(touch SHOULD_NOT_RUN)'),
      path.join(ctx.root, 'staged static;$(touch SHOULD_NOT_RUN)'),
      sourceCommit,
    ];
    const operation = withLifecycleHooks(
      ctx.root,
      tmp,
      { ...ctx.env, QL_INSTALL_TRACE: trace },
      (hook) => hook('install', args),
    );
    if (expected)
      await assert.rejects(operation, new RegExp(`exit ${expected}`));
    else await operation;
    assert.deepEqual(
      (await fs.readFile(trace, 'utf8')).trim().split('\n'),
      args,
    );
    await assert.rejects(fs.stat(path.join(ctx.root, 'SHOULD_NOT_RUN')), {
      code: 'ENOENT',
    });
    assert.deepEqual(await fs.readdir(tmp), []);
  }
});

test('interrupted reload restores old files and recovery subprocesses ignore the cancelled operation', async (t) => {
  const {
    cancellableOperation,
    operationSignal,
  } = require('../../dist/internal/runtime/cancellation');
  const { checkedProcess } = require('../../dist/internal/runtime/process');
  for (const phase of ['before', 'stop', 'start']) {
    const ctx = await fixture(t);
    const target = path.join(ctx.root, 'installed');
    const source = path.join(ctx.root, 'staged');
    await fs.mkdir(target);
    await fs.mkdir(source);
    await fs.writeFile(path.join(target, 'version'), 'old');
    await fs.writeFile(path.join(source, 'version'), 'new');
    const controller = new AbortController();
    const events = [];
    if (phase === 'before') controller.abort('SIGTERM');
    await assert.rejects(
      cancellableOperation(controller.signal, () =>
        replaceAndReload(ctx, [{ source, target }], {
          stop: async () => {
            events.push('stop');
            if (phase === 'stop' && events.length === 1)
              controller.abort('SIGTERM');
            if (events.length > 1) assert.equal(operationSignal(), undefined);
          },
          start: async () => {
            const version = await fs.readFile(
              path.join(target, 'version'),
              'utf8',
            );
            events.push(`start:${version}`);
            if (version === 'new') {
              controller.abort('SIGTERM');
              // Simulate a start that reports success despite interruption.
              return;
            }
            assert.equal(operationSignal(), undefined);
            const result = await checkedProcess(
              process.execPath,
              ['-e', 'process.stdout.write("recovered")'],
              { capture: true },
            );
            assert.equal(result.stdout, 'recovered');
          },
        }),
      ),
    );
    assert.deepEqual(
      events,
      phase === 'before'
        ? []
        : phase === 'stop'
        ? ['stop', 'start:old']
        : ['stop', 'start:new', 'stop', 'start:old'],
    );
    assert.equal(
      await fs.readFile(path.join(target, 'version'), 'utf8'),
      'old',
    );
    assert.ok(
      !(await fs.readdir(ctx.root)).some((name) => name.includes('ql-backup')),
    );
  }
});

test('reload retains backups when a partially started new service cannot stop', async (t) => {
  const ctx = await fixture(t);
  const target = path.join(ctx.root, 'installed');
  const source = path.join(ctx.root, 'staged');
  await fs.mkdir(target);
  await fs.mkdir(source);
  await fs.writeFile(path.join(target, 'version'), 'old');
  await fs.writeFile(path.join(source, 'version'), 'new');
  let stops = 0;
  await assert.rejects(
    replaceAndReload(ctx, [{ source, target }], {
      stop: async () => {
        if (++stops === 2) throw new Error('service still running');
      },
      start: async () => {
        throw new Error('partial startup');
      },
    }),
    /service still running/,
  );
  assert.equal(await fs.readFile(path.join(target, 'version'), 'utf8'), 'new');
  const backup = (await fs.readdir(ctx.root)).find((name) =>
    name.startsWith('installed.ql-backup-'),
  );
  assert.ok(backup);
  assert.equal(
    await fs.readFile(path.join(ctx.root, backup, 'version'), 'utf8'),
    'old',
  );
});

test('overlay directory backup supports replacement and rollback after EXDEV', async (t) => {
  for (const failed of [false, true]) {
    const ctx = await fixture(t);
    const target = path.join(ctx.root, 'installed');
    const source = path.join(ctx.root, 'staged');
    await fs.mkdir(target);
    await fs.mkdir(source);
    await fs.writeFile(path.join(target, 'version'), 'old');
    await fs.writeFile(path.join(source, 'version'), 'new');
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (from === target)
        throw Object.assign(new Error('overlay directory'), { code: 'EXDEV' });
      return rename(from, to);
    };
    let starts = 0;
    try {
      const operation = replaceAndReload(ctx, [{ source, target }], {
        stop: async () => {},
        start: async () => {
          if (++starts === 1 && failed) throw Error('new service failed');
        },
      });
      if (failed) await assert.rejects(operation, /new service failed/);
      else await operation;
      assert.equal(
        await fs.readFile(path.join(target, 'version'), 'utf8'),
        failed ? 'old' : 'new',
      );
      assert.ok(
        !(await fs.readdir(ctx.root)).some((name) =>
          name.includes('ql-backup'),
        ),
      );
    } finally {
      fs.rename = rename;
    }
  }
});

test('partial overlay backup, removal and replacement failures restore the complete previous installation', async (t) => {
  for (const phase of ['backup', 'remove', 'replacement']) {
    await t.test(phase, async () => {
      const ctx = await fixture(t);
      const replacements = [];
      for (const name of ['first', 'second']) {
        const target = path.join(ctx.root, name);
        const source = path.join(ctx.root, `${name}-staged`);
        await fs.mkdir(target);
        await fs.mkdir(source);
        await fs.writeFile(path.join(target, 'version'), `old-${name}`);
        await fs.writeFile(path.join(target, 'keep'), 'original metadata');
        await fs.symlink('version', path.join(target, 'link'));
        await fs.writeFile(path.join(source, 'version'), `new-${name}`);
        replacements.push({ source, target });
      }
      const [first, second] = replacements;
      const original = { rename: fs.rename, cp: fs.cp, rm: fs.rm };
      let injected = false;
      const failure = Object.assign(new Error(`partial ${phase}`), {
        code: phase === 'remove' ? 'EACCES' : 'ENOSPC',
      });
      const events = [];
      fs.rename = async (from, to) => {
        if (replacements.some((item) => item.target === from))
          throw Object.assign(new Error('overlay directory'), {
            code: 'EXDEV',
          });
        return original.rename(from, to);
      };
      fs.cp = async (from, to, options) => {
        if (
          !injected &&
          ((phase === 'backup' && from === second.target) ||
            (phase === 'replacement' && from === second.source))
        ) {
          injected = true;
          await fs.mkdir(to, { recursive: true });
          await fs.writeFile(path.join(to, 'version'), 'incomplete copy');
          throw failure;
        }
        return original.cp(from, to, options);
      };
      fs.rm = async (target, options) => {
        if (!injected && phase === 'remove' && target === second.target) {
          injected = true;
          await original.rm(path.join(target, 'version'));
          throw failure;
        }
        return original.rm(target, options);
      };
      try {
        await assert.rejects(
          replaceAndReload(ctx, replacements, {
            stop: async () => {
              events.push('stop');
            },
            start: async () => {
              events.push('start');
              // Recovery must restore every root entry before restarting services.
              for (const [index, item] of replacements.entries())
                assert.equal(
                  await fs.readFile(path.join(item.target, 'version'), 'utf8'),
                  `old-${index === 0 ? 'first' : 'second'}`,
                );
            },
          }),
          (error) => error === failure,
        );
        assert.equal(injected, true);
        assert.deepEqual(events, ['stop', 'start']);
        for (const item of replacements) {
          assert.equal(
            await fs.readFile(path.join(item.target, 'keep'), 'utf8'),
            'original metadata',
          );
          assert.equal(
            await fs.readlink(path.join(item.target, 'link')),
            'version',
          );
        }
        assert.equal(
          await fs.readFile(path.join(first.source, 'version'), 'utf8'),
          'new-first',
        );
        assert.ok(
          !(await fs.readdir(ctx.root)).some((name) =>
            name.includes('ql-backup'),
          ),
        );
      } finally {
        Object.assign(fs, original);
      }
    });
  }
});

test('invalid or incomplete staged pointers cannot stop the installed panel', async (t) => {
  const ctx = await fixture(t);
  await fs.mkdir(ctx.paths.dir_tmp, { recursive: true });
  const calls = path.join(ctx.root, 'service-called');
  ctx.env.CALLS = calls;
  await stub(
    ctx,
    'pm2',
    'require("node:fs").writeFileSync(process.env.CALLS,"called")',
  );
  const pointer = path.join(ctx.paths.dir_tmp, 'upgrade-ready-master.json');
  for (const value of [
    'invalid json',
    JSON.stringify({ directory: '../outside' }),
    JSON.stringify({ directory: 'upgrade-missing' }),
  ]) {
    await fs.writeFile(pointer, value);
    await assert.rejects(reloadPanel(ctx, 'system'));
    await assert.rejects(fs.access(calls));
  }
  const stage = path.join(ctx.paths.dir_tmp, 'upgrade-fixture');
  await fs.mkdir(path.join(stage, 'qinglong-master'), { recursive: true });
  await fs.mkdir(path.join(stage, 'qinglong-static-master'));
  await fs.writeFile(pointer, JSON.stringify({ directory: 'upgrade-fixture' }));
  await fs.writeFile(path.join(stage, 'ready.json'), '{}');
  await assert.rejects(reloadPanel(ctx, 'system'), /readiness/);
  await assert.rejects(fs.access(calls));
  await fs.rm(stage, { recursive: true });
  await fs.symlink(ctx.root, stage);
  await assert.rejects(reloadPanel(ctx, 'system'), /directory/);
  await assert.rejects(fs.access(calls));
  await fs.rm(pointer);
  await assert.rejects(
    reloadPanel(ctx, 'system'),
    (error) =>
      error.code === 'ENOENT' &&
      error.path === path.join(ctx.paths.dir_tmp, 'upgrade-ready-master.json'),
  );
});

test('deleted entries are restored alongside replacements when service startup fails', async (t) => {
  const ctx = await fixture(t);
  const removed = path.join(ctx.root, 'obsolete');
  const added = path.join(ctx.root, 'added');
  const source = path.join(ctx.root, 'incoming');
  await fs.mkdir(removed);
  await fs.writeFile(path.join(removed, 'keep'), 'old contents');
  await fs.writeFile(source, 'new contents');
  let starts = 0;
  await assert.rejects(
    replaceAndReload(ctx, [{ target: removed }, { source, target: added }], {
      stop: async () => {},
      start: async () => {
        if (++starts === 1) {
          await assert.rejects(fs.access(removed));
          assert.equal(await fs.readFile(added, 'utf8'), 'new contents');
          throw new Error('failed new start');
        }
        assert.equal(
          await fs.readFile(path.join(removed, 'keep'), 'utf8'),
          'old contents',
        );
        await assert.rejects(fs.access(added));
      },
    }),
    /failed new start/,
  );
  assert.equal(starts, 2);
  assert.ok(
    !(await fs.readdir(ctx.root)).some((name) => name.includes('ql-backup')),
  );
});

test('system upgrade preserves installed dotenv bytes and permissions even when payload includes dotenv', async (t) => {
  const ctx = await fixture(t);
  await repairConfiguration(ctx);
  await stub(ctx, 'pm2', '');
  const source = path.join(ctx.root, 'payload-source');
  const staticRoot = path.join(ctx.root, 'payload-static');
  await fs.mkdir(path.join(source, 'sample'), { recursive: true });
  await fs.mkdir(path.join(staticRoot, 'build'), { recursive: true });
  await fs.writeFile(
    path.join(source, 'package.json'),
    '{"name":"replacement"}',
  );
  await fs.writeFile(
    path.join(source, 'sample/config.sample.sh'),
    'new sample',
  );
  await fs.writeFile(path.join(staticRoot, 'build/app.js'), '');
  await fs.writeFile(path.join(source, '.env'), 'PORT=9999\nREPLACE_ME=true\n');
  writeManifest(source, staticRoot);
  const target = path.join(ctx.root, '.env');
  const original = 'PORT=5700\nPRIVATE_VALUE=preserved\n';
  await fs.writeFile(target, original, { mode: 0o600 });
  const before = await fs.stat(target);
  await reloadPanel(ctx, 'system', { source, static: staticRoot });
  assert.equal(await fs.readFile(target, 'utf8'), original);
  const after = await fs.stat(target);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o600);
  assert.equal(
    await fs.readFile(path.join(ctx.root, 'package.json'), 'utf8'),
    '{"name":"replacement"}',
  );
});
