const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createContext } = require('../../dist/internal/runtime/context');
const {
  bootstrapPanel,
  bootstrapPackages,
} = require('../../dist/internal/maintenance/bootstrap');
const { parse } = require('../helpers/commands.cjs');

async function fixture(t) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql-bootstrap-')),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'panel');
  await fs.mkdir(root);
  const bin = path.join(base, 'bin');
  await fs.mkdir(bin);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    QL_OS_TYPE: 'debian',
    CALLS: path.join(base, 'calls'),
    AutoStartBot: 'true',
    EnableExtraShell: 'true',
  };
  const ctx = createContext(
    { root, 'data-dir': path.join(base, 'external/data') },
    env,
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
    await fs.writeFile(path.join(root, 'sample', file), '# fixture');
  await fs.writeFile(path.join(root, '.env.example'), 'SAMPLE=true');
  const program = `
    const fs=require('node:fs'),p=require('node:path');
    const program=p.basename(process.argv[1]),args=process.argv.slice(2);
    fs.appendFileSync(process.env.CALLS,JSON.stringify({program,args,python:process.env.PYTHON_HOME,node:process.env.PNPM_HOME})+'\\n');
    if(program==='python3') process.stdout.write('3.12\\n');
    if(program==='nginx' && args.includes('-s')) process.exit(1);
  `;
  for (const name of [
    'sudo',
    'apt-get',
    'apk',
    'npm',
    'pip3',
    'python3',
    'pm2',
    'nginx',
  ])
    await fs.writeFile(
      path.join(bin, name),
      `#!${process.execPath}\n${program}`,
      { mode: 0o755 },
    );
  const hooks = [];
  const registrations = [];
  const system = {
    registerServices: async (context, os) => {
      registrations.push({ data: context.data, os });
    },
    nginxConfig: path.join(base, 'nginx/nginx.conf'),
    nginxIncludes: path.join(base, 'nginx/conf.d'),
    nginxRun: path.join(base, 'run/nginx'),
    background: async (context, action) => {
      hooks.push({ action, data: context.data });
      return 100 + hooks.length;
    },
  };
  return { ctx, system, hooks, base, registrations };
}

test('bootstrap installs prerequisites, uses the configured data directory and starts services in order', async (t) => {
  const { ctx, system, hooks, registrations } = await fixture(t);
  await fs.writeFile(path.join(ctx.root, '.env'), 'KEEP=true');
  const result = await bootstrapPanel(ctx, false, system);
  assert.equal(result.mode, 'install');
  assert.equal(result.service.manager, 'pm2');
  assert.deepEqual(registrations, [{ data: ctx.data, os: 'debian' }]);
  assert.deepEqual(
    hooks.map((h) => h.action),
    ['bot', 'extra'],
  );
  assert.ok(hooks.every((h) => h.data === ctx.data));
  assert.equal(
    await fs.readFile(path.join(ctx.root, '.env'), 'utf8'),
    'KEEP=true',
  );
  const calls = (await fs.readFile(ctx.env.CALLS, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(
    calls.map((c) => c.program),
    [
      process.getuid() === 0 ? 'apt-get' : 'sudo',
      process.getuid() === 0 ? 'apt-get' : 'sudo',
      'npm',
      'python3',
      'pip3',
      'pm2',
      'nginx',
      'nginx',
      'pm2',
      'pm2',
      'pm2',
      'pm2',
    ],
  );
  assert.deepEqual(calls[4].args, [
    'install',
    '--prefix',
    path.join(ctx.data, 'dep_cache/python3'),
    'requests',
  ]);
  assert.deepEqual(calls[6].args, ['-c', system.nginxConfig, '-s', 'reload']);
  assert.deepEqual(calls[7].args, ['-c', system.nginxConfig]);
  assert.deepEqual(
    calls.slice(-4).map((c) => c.args),
    [
      ['flush'],
      ['startOrGracefulReload', 'ecosystem.config.js', '--update-env'],
      ['startup'],
      ['save'],
    ],
  );
  assert.ok(
    calls
      .slice(4)
      .every(
        (c) =>
          c.python === path.join(ctx.data, 'dep_cache/python3') &&
          c.node === path.join(ctx.data, 'dep_cache/node'),
      ),
  );
  assert.equal(bootstrapPackages('alpine').program, 'apk');
  assert.throws(
    () => bootstrapPackages('darwin', { QL_LANG: 'en' }),
    /Unsupported deployment OS/,
  );
  assert.throws(() => parse(['start'], 'public'));
  assert.equal(parse(['start', '--reload'], 'local').values.reload, true);
});

test('startup reload skips package installation, optional hooks and PM2 startup registration', async (t) => {
  const { ctx, system, hooks, registrations } = await fixture(t);
  await bootstrapPanel(ctx, true, system);
  const calls = (await fs.readFile(ctx.env.CALLS, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(
    calls.map((c) => c.program),
    ['python3', 'pm2', 'nginx', 'nginx', 'pm2', 'pm2'],
  );
  assert.deepEqual(hooks, []);
  assert.deepEqual(registrations, []);
  assert.equal(
    await fs.readFile(path.join(ctx.root, '.env'), 'utf8'),
    'SAMPLE=true',
  );
  assert.equal(
    (await fs.stat(path.join(ctx.root, '.env'))).mode & 0o777,
    0o600,
  );
  await assert.rejects(
    bootstrapPanel(
      {
        ...ctx,
        env: { ...ctx.env, QL_LANG: 'en' },
        data: path.join(ctx.root, 'wrong'),
      },
      true,
      system,
    ),
    /ending in \/data/,
  );
});

test('container startup explicitly skips boot registration but starts services and saves PM2 state', async (t) => {
  const { ctx, system, registrations } = await fixture(t);
  const result = await bootstrapPanel(ctx, false, system, {
    registerStartup: false,
  });
  assert.equal(result.startup, 'skipped');
  assert.deepEqual(registrations, []);
  assert.equal(result.service.manager, 'pm2');
  const calls = (await fs.readFile(ctx.env.CALLS, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.ok(
    !calls.some((call) => call.program === 'pm2' && call.args[0] === 'startup'),
  );
  assert.ok(
    calls.some((call) => call.program === 'pm2' && call.args[0] === 'save'),
  );
  assert.ok(calls.some((call) => call.program === 'npm'));
});

for (const language of ['zh', 'en', 'unsupported']) {
  test(`bootstrap rejects invalid setup before package or service work: ${language}`, async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ql-bootstrap-invalid-'),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const ctx = createContext(
      { root },
      { QL_LANG: language, QL_OS_TYPE: 'unsupported', PATH: '' },
    );
    await assert.rejects(bootstrapPanel(ctx), (error) => {
      assert.equal(error.exitCode, 2);
      assert.match(
        error.message,
        language === 'en'
          ? /Unsupported deployment OS: unsupported/
          : /不支持此部署操作系统：unsupported/,
      );
      return true;
    });
    await assert.rejects(
      bootstrapPanel({ ...ctx, data: path.join(root, 'invalid') }),
      (error) => {
        assert.equal(error.exitCode, 2);
        assert.match(
          error.message,
          language === 'en' ? /ending in \/data/ : /以 \/data 结尾/,
        );
        return true;
      },
    );
    const { runtimeEnvironment } = require('../../dist/internal/maintenance/bootstrap');
    assert.throws(
      () => runtimeEnvironment(ctx, 'bad'),
      (error) => {
        assert.equal(error.exitCode, 1);
        assert.match(
          error.message,
          language === 'en' ? /invalid version/ : /无效版本/,
        );
        return true;
      },
    );
    assert.deepEqual(await fs.readdir(root), []);
  });
}
