const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const {
  commands,
  globalOptions,
  localOptions,
} = require('../dist/framework/registry');
const { helpText } = require('../dist/i18n/help');
const { loggedOperation } = require('../dist/local/commandLog');
const { createContext } = require('../dist/local/context');

test('every registered help description has a Chinese translation and preserves English', () => {
  const text = [
    ...commands.map((c) => c.summary),
    ...Object.values({ ...globalOptions, ...localOptions }).map(
      (o) => o.description,
    ),
    ...commands.flatMap((c) =>
      Object.values(c.options || {}).map((o) => o.description),
    ),
  ];
  for (const value of text) {
    assert.notEqual(
      helpText(value, {}),
      value,
      `Missing translation: ${value}`,
    );
    assert.equal(helpText(value, { QL_LANG: 'en' }), value);
  }
});

test('public and local JSON help honors QL_LANG without reading panel configuration', () => {
  for (const entry of ['index', 'admin'])
    for (const language of ['zh', 'en']) {
      const result = spawnSync(
        process.execPath,
        [path.resolve(__dirname, `../dist/${entry}.js`), '--help', '--json'],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            QL_LANG: language,
            QL_DIR: '/nonexistent',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const help = JSON.parse(result.stdout).data.help;
      assert.match(help, language === 'en' ? /Usage:/ : /用法：/);
      assert.match(help, language === 'en' ? /Options:/ : /选项：/);
      assert.match(help, /--json/);
    }
});

test('maintenance log banners honor Chinese fallback and English selection', async (t) => {
  for (const language of ['zh', 'en']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-i18n-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const context = createContext(
      { root },
      { QL_LANG: language, no_tee: 'true' },
    );
    const { logPath } = await loggedOperation(
      context,
      'extra',
      async () => true,
    );
    const log = await fs.readFile(
      path.join(context.paths.dir_log, logPath),
      'utf8',
    );
    assert.match(log, language === 'en' ? /Starting/ : /开始执行/);
    assert.match(
      log,
      language === 'en' ? /Finished.*exit code 0/ : /执行结束.*退出码 0/,
    );
  }
});

test('standalone entry help supports both languages without panel or repository setup', () => {
  for (const entry of [
    'runner',
    'compat',
    'subscription-worker',
    'developer',
  ]) {
    for (const language of ['en', 'zh']) {
      const result = spawnSync(
        process.execPath,
        [path.resolve(__dirname, `../dist/${entry}.js`), '--help'],
        {
          encoding: 'utf8',
          cwd: os.tmpdir(),
          env: {
            PATH: process.env.PATH,
            QL_LANG: language,
            QL_DIR: '/missing-panel',
            QL_CLI_CONFIG: '/missing-credentials',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, language === 'en' ? /Usage:/ : /用法：/);
      assert.match(result.stdout, /ql(?: |-)/);
    }
  }
});

test('task, maintenance and subscription failure warnings honor locale without failing completed work', async (t) => {
  const { LocalApi } = require('../dist/local/api');
  const { executeTask } = require('../dist/local/taskRunner');
  const { syncRepository } = require('../dist/local/subscriptionRunner');
  const { withOperationOutput } = require('../dist/local/output');
  const { execFileSync } = require('node:child_process');
  const git = process.platform === 'darwin' ? '/usr/bin/git' : 'git';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-warning-locale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'owner/source');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'job.js'), '// cron: 0 9 * * *\n');
  for (const args of [
    ['init'],
    ['add', '.'],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'fixture',
    ],
  ])
    execFileSync(git, args, { cwd: source, stdio: 'ignore' });
  let created = 0,
    notifications = 0;
  t.mock.method(LocalApi.prototype, 'call', async (endpoint, method) => {
    if (endpoint === 'crons' && method === 'POST') {
      created++;
      return { data: { id: created } };
    }
    if (endpoint === 'crons') return { data: { data: [] } };
    if (endpoint === 'system/notify') notifications++;
    throw new Error('Fixture unavailable');
  });
  for (const language of ['zh', 'en']) {
    const panel = path.join(root, language);
    await fs.mkdir(path.join(panel, 'data/scripts'), { recursive: true });
    await fs.writeFile(path.join(panel, 'data/scripts/job.sh'), 'exit 0');
    const context = createContext(
      { root: panel },
      {
        PATH: `/usr/bin:/bin:${process.env.PATH}`,
        ID: '12',
        QL_LANG: language,
        QL_CLI_LIFECYCLE: 'extended',
        no_tee: 'true',
      },
    );
    const task = await executeTask(context, { argv: ['job.sh'], mode: 'now' });
    assert.equal(task.exitCode, 0);
    const taskLog = await fs.readFile(
      path.join(context.paths.dir_log, task.logPath),
      'utf8',
    );
    assert.match(
      taskLog,
      language === 'en'
        ? /Task lifecycle reporting failed/
        : /任务状态上报失败/,
    );
    assert.match(
      taskLog,
      language === 'en'
        ? /Task statistics reporting failed/
        : /任务统计上报失败/,
    );
    const command = await loggedOperation(context, 'extra', async () => true);
    const commandLog = await fs.readFile(
      path.join(context.paths.dir_log, command.logPath),
      'utf8',
    );
    assert.match(
      commandLog,
      language === 'en'
        ? /Command lifecycle reporting failed/
        : /命令状态上报失败/,
    );
    let warning = '';
    const subscription = await withOperationOutput(
      (chunk) => {
        warning += chunk.toString();
      },
      () =>
        syncRepository(context, {
          url: source,
          autoAdd: true,
          autoDelete: false,
        }),
    );
    assert.equal(subscription.added, 1);
    assert.match(
      warning,
      language === 'en'
        ? /Subscription synchronized, but notification delivery failed/
        : /订阅同步已完成，但通知发送失败/,
    );
  }
  assert.equal(created, 2);
  assert.equal(notifications, 2);
});
