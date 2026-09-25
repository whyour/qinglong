const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createContext } = require('../dist/local/context');
const {
  botSystemPackages,
  installAndStartBot,
  prepareBot,
  launchBot,
} = require('../dist/local/bot');
const { parse } = require('../dist/arguments');

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql-bot-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const ctx = createContext(
    { root },
    {
      PATH: `${bin}:/usr/bin:/bin`,
      QL_OS_TYPE: 'debian',
      CALLS: path.join(root, 'calls'),
    },
  );
  const recorder =
    'require("node:fs").appendFileSync(process.env.CALLS, JSON.stringify({program:require("node:path").basename(process.argv[1]),args:process.argv.slice(2)})+"\\n");';
  for (const program of ['sudo', 'apt-get', 'apk', 'pip3'])
    await fs.writeFile(
      path.join(bin, program),
      `#!${process.execPath}\n${recorder}`,
      { mode: 0o755 },
    );
  const repo = path.join(root, 'source');
  await fs.mkdir(path.join(repo, 'jbot'), { recursive: true });
  await fs.mkdir(path.join(repo, 'config'));
  await fs.writeFile(
    path.join(repo, 'jbot/requirements.txt'),
    'example==1.2\n',
  );
  await fs.writeFile(path.join(repo, 'jbot/__main__.py'), 'print("fixture")');
  await fs.writeFile(path.join(repo, 'config/bot.json'), '{"token":"sample"}');
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '.'],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
  ])
    execFileSync('/usr/bin/git', args, { cwd: repo });
  ctx.env.BotRepoUrl = repo;
  return ctx;
}

test('bot prepares local repository and dependencies while preserving user configuration', async (t) => {
  const ctx = await fixture(t);
  await fs.mkdir(ctx.paths.dir_config, { recursive: true });
  const config = path.join(ctx.paths.dir_config, 'bot.json');
  await fs.writeFile(config, '{"token":"keep"}', { mode: 0o600 });
  const lifecycle = [];
  await installAndStartBot(ctx, {
    stop: async () => {
      lifecycle.push('stop');
    },
    start: async () => {
      lifecycle.push('start');
      assert.equal(
        await fs.readFile(path.join(ctx.data, 'jbot/__main__.py'), 'utf8'),
        'print("fixture")',
      );
      return { pid: 123 };
    },
  });
  assert.deepEqual(lifecycle, ['stop', 'start']);
  assert.equal(await fs.readFile(config, 'utf8'), '{"token":"keep"}');
  assert.equal(
    await fs.readFile(path.join(ctx.data, 'requirements.txt'), 'utf8'),
    'example==1.2\n',
  );
  assert.ok(
    !(await fs.readdir(ctx.data)).some((name) =>
      name.startsWith('.bot-stage-'),
    ),
  );
  const calls = (await fs.readFile(ctx.env.CALLS, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  const install = calls.find((c) => c.program === 'pip3');
  assert.deepEqual(install.args.slice(0, 3), [
    '--default-timeout=100',
    'install',
    '-r',
  ]);
  assert.ok(install.args[3].endsWith('/jbot/requirements.txt'));
  const packages = botSystemPackages('debian');
  assert.deepEqual(
    calls[0].args,
    process.getuid() === 0
      ? packages.args
      : [packages.program, ...packages.args],
  );
  assert.equal(botSystemPackages('alpine').program, 'apk');
  assert.throws(
    () => botSystemPackages('darwin', { QL_LANG: 'en' }),
    /does not support/,
  );
  assert.throws(() => parse(['bot'], 'public'));
  assert.equal(parse(['bot'], 'local').name, 'local bot');
});

test('bot startup failure restores old source and requirements before restarting it', async (t) => {
  const ctx = await fixture(t);
  await fs.mkdir(path.join(ctx.data, 'jbot'), { recursive: true });
  await fs.writeFile(path.join(ctx.data, 'jbot/old'), 'old source');
  await fs.writeFile(
    path.join(ctx.data, 'requirements.txt'),
    'old requirements',
  );
  let starts = 0;
  await assert.rejects(
    installAndStartBot(ctx, {
      stop: async () => {},
      start: async () => {
        if (++starts === 1) throw new Error('startup failure');
        assert.equal(
          await fs.readFile(path.join(ctx.data, 'jbot/old'), 'utf8'),
          'old source',
        );
        assert.equal(
          await fs.readFile(path.join(ctx.data, 'requirements.txt'), 'utf8'),
          'old requirements',
        );
        return { pid: 123 };
      },
    }),
    /startup failure/,
  );
  assert.equal(starts, 2);
  assert.ok(
    !(await fs.readdir(ctx.data)).some(
      (name) => name.includes('previous-') || name.includes('ql-backup'),
    ),
  );
});

test('failed bot clone preserves previous repository and running files', async (t) => {
  const ctx = await fixture(t);
  ctx.env.BotRepoUrl = path.join(ctx.root, 'absent-repository');
  const old = path.join(ctx.paths.dir_repo, 'diybot');
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(path.join(old, 'old'), 'keep');
  await assert.rejects(
    prepareBot(ctx),
    /Required executable failed|必要的可执行程序失败/,
  );
  assert.equal(await fs.readFile(path.join(old, 'old'), 'utf8'), 'keep');
  assert.ok(
    !(await fs.readdir(ctx.paths.dir_repo)).some((name) =>
      name.startsWith('.bot-clone-'),
    ),
  );
});

test('bot launch detects immediate interpreter failure without reporting a running service', async (t) => {
  const ctx = await fixture(t);
  await fs.mkdir(ctx.data, { recursive: true });
  await fs.writeFile(
    path.join(ctx.root, 'bin/python3'),
    `#!${process.execPath}\nprocess.stderr.write('fixture startup failed');process.exit(9);`,
    { mode: 0o755 },
  );
  ctx.env.QL_LANG = 'en';
  await assert.rejects(launchBot(ctx), /startup \(9\)/);
  assert.equal(
    await fs.readFile(path.join(ctx.paths.dir_log, 'bot/nohup.log'), 'utf8'),
    'fixture startup failed',
  );
});

test('bot installation keeps internal relative links valid after staging cleanup', async (t) => {
  const ctx = await fixture(t);
  const source = ctx.env.BotRepoUrl;
  await fs.symlink('__main__.py', path.join(source, 'jbot/alias.py'));
  execFileSync('/usr/bin/git', ['add', '.'], { cwd: source });
  execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'internal link',
    ],
    { cwd: source },
  );
  await installAndStartBot(ctx, {
    stop: async () => {},
    start: async () => ({ pid: 123 }),
  });
  assert.equal(
    await fs.readlink(path.join(ctx.data, 'jbot/alias.py')),
    '__main__.py',
  );
  assert.equal(
    await fs.readFile(path.join(ctx.data, 'jbot/alias.py'), 'utf8'),
    'print("fixture")',
  );
});

for (const language of ['zh', 'en', 'unsupported']) {
  test(`bot validation and startup failures honor the operation language: ${language}`, async (t) => {
    const ctx = await fixture(t);
    ctx.env.QL_LANG = language;
    const expected = (zh, en) => (language === 'en' ? en : zh);
    assert.throws(
      () => botSystemPackages('unsupported-os', ctx.env),
      expected(
        /不支持此操作系统：unsupported-os/,
        /does not support OS: unsupported-os/,
      ),
    );
    const prepared = await prepareBot(ctx);
    await fs.rm(prepared.staged, { recursive: true });
    const userConfig = path.join(ctx.paths.dir_config, 'bot.json');
    await fs.writeFile(userConfig, 'retain-user-config');
    const source = path.join(prepared.repository, 'jbot');
    const outside = path.join(source, 'outside');
    await fs.symlink(userConfig, outside);
    await assert.rejects(
      prepareBot(ctx),
      expected(/外部的符号链接/, /external symlink/),
    );
    await fs.unlink(outside);
    const template = path.join(prepared.repository, 'config/bot.json');
    await fs.unlink(template);
    await fs.symlink(userConfig, template);
    await assert.rejects(
      prepareBot(ctx),
      expected(/模板必须为普通文件/, /template must be a regular file/),
    );
    assert.equal(await fs.readFile(userConfig, 'utf8'), 'retain-user-config');
    assert.ok(
      !(await fs.readdir(ctx.data)).some((name) =>
        name.startsWith('.bot-stage-'),
      ),
    );
    await fs.writeFile(
      path.join(ctx.root, 'bin/python3'),
      `#!${process.execPath}\nprocess.exitCode=9;`,
      { mode: 0o755 },
    );
    await assert.rejects(
      launchBot(ctx),
      expected(/启动期间退出（9）/, /startup \(9\)/),
    );
  });
}
