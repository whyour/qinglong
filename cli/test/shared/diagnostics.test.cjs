const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

test('legacy and worker entrypoints localize invalid input before accessing an installation', () => {
  const cases = [
    ['compat', ['absent'], '', /未知旧命令/, /Unknown legacy command/],
    [
      'compat',
      ['update', 'invalid'],
      '',
      /用法：ql-compat update/,
      /Usage: ql-compat update/,
    ],
    [
      'compat',
      ['reload', 'invalid'],
      '',
      /用法：ql-compat reload/,
      /Usage: ql-compat reload/,
    ],
    [
      'subscription-worker',
      ['absent'],
      '',
      /用法：ql-subscription-worker/,
      /Usage: ql-subscription-worker/,
    ],
    [
      'subscription-worker',
      ['raw', 'https://example.invalid/job.js', '', 'yes'],
      '',
      /订阅布尔参数无效/,
      /Invalid subscription boolean/,
    ],
    [
      'compat',
      ['raw', 'https://example.invalid/job.js', '', 'yes'],
      '',
      /订阅布尔参数无效/,
      /Invalid subscription boolean/,
    ],
    [
      'subscription-worker',
      ['raw', 'https://example.invalid/job.js', '', '', '', 'extra'],
      '',
      /订阅参数过多/,
      /Too many subscription arguments/,
    ],
    [
      'subscription-worker',
      ['raw', 'https://example.invalid/job.js'],
      '-1',
      /SUB_ID 无效/,
      /Invalid SUB_ID/,
    ],
  ];
  for (const [entry, args, subscriptionId, chinese, english] of cases) {
    for (const language of ['zh', 'en', 'unsupported']) {
      const result = spawnSync(
        process.execPath,
        [path.resolve(__dirname, `../../dist/${entry}.js`), ...args],
        {
          env: {
            ...process.env,
            QL_LANG: language,
            QL_DIR: '',
            QL_DATA_DIR: '',
            SUB_ID: subscriptionId,
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      const error = JSON.parse(result.stderr);
      assert.equal(error.code, 2);
      assert.match(error.message, language === 'en' ? english : chinese);
      assert.doesNotMatch(error.message, /example\.invalid/);
    }
  }
});

function invoke(entry, args, language) {
  return spawnSync(
    process.execPath,
    [path.resolve(__dirname, `../../dist/${entry}.js`), ...args, '--json'],
    {
      env: { ...process.env, QL_LANG: language, QL_DIR: '', QL_DATA_DIR: '' },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
}

test('runner JSON error handling respects the script and option-terminator boundaries', () => {
  const entry = path.resolve(__dirname, '../../dist/runner.js');
  for (const args of [
    ['sample.js', '--json'],
    ['--unknown-option', '--', '--json'],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      env: { ...process.env, QL_DIR: '', QL_DATA_DIR: '' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.throws(
      () => JSON.parse(result.stderr),
      SyntaxError,
      'child --json must not select CLI JSON output',
    );
  }
  const result = invoke('runner', ['--json', '--unknown-option'], 'en');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).code, 2);
});

test('actual argument failures honor locale, preserve usage status, and keep stdout empty', () => {
  const cases = [
    [
      'runner',
      ['--unknown-option'],
      /任务执行器选项无效/,
      /Invalid runner options/,
    ],
    ['index', ['absent'], /未知命令/, /Unknown command/],
    [
      'index',
      ['task', 'list', '--absent'],
      /选项未知/,
      /Unknown or missing option/,
    ],
    [
      'index',
      ['task', 'list', '--page', '1', '-p', '2'],
      /选项重复/,
      /Duplicate option/,
    ],
    ['index', ['task', 'get'], /缺少必要参数/, /missing required argument/],
    ['index', ['login'], /缺少 --url/, /Missing --url/],
    [
      'index',
      ['auth', 'status', '--scope', 'all'],
      /--scope 无效/,
      /Invalid --scope/,
    ],
    ['index', ['task', 'get', '0'], /支持范围内的整数/, /supported range/],
    ['admin', ['absent'], /ql --help/, /ql --help/],
  ];
  for (const [entry, args, chinese, english] of cases) {
    for (const language of ['zh', 'en', 'unsupported']) {
      const result = invoke(entry, args, language);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      const error = JSON.parse(result.stderr);
      assert.equal(error.code, 2);
      assert.match(error.message, language === 'en' ? english : chinese);
    }
  }
});

test('unexpected local configuration failures use localized generic diagnostics without exposing config output', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-diagnostic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data/config'), { recursive: true });
  await fs.writeFile(path.join(root, 'data/config/config.sh'), 'exit 7\n');
  for (const language of ['zh', 'en']) {
    const result = invoke('admin', ['extra', '--root', root], language);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr);
    assert.equal(error.code, 1);
    assert.match(
      error.message,
      language === 'en' ? /Check local configuration/ : /检查本机配置和权限/,
    );
  }
});

test('legacy and worker failures preserve stderr diagnostics and localize the final JSON', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql-worker-diagnostic-'),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data/config'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'data/config/config.sh'),
    'echo private-config-marker >&2\nexit 7\n',
  );
  for (const [entry, args, chinese, english] of [
    [
      'compat',
      ['extra'],
      /旧命令适配器执行失败/,
      /Legacy command adapter failed/,
    ],
    [
      'subscription-worker',
      ['raw', 'https://example.invalid/job.js'],
      /订阅执行器失败/,
      /Subscription worker failed/,
    ],
  ]) {
    for (const language of ['zh', 'en']) {
      const result = spawnSync(
        process.execPath,
        [path.resolve(__dirname, `../../dist/${entry}.js`), ...args],
        {
          env: {
            ...process.env,
            QL_LANG: language,
            QL_DIR: root,
            QL_DATA_DIR: path.join(root, 'data'),
            SUB_ID: '',
          },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      const lines = result.stderr.trim().split('\n');
      assert.equal(lines[0], 'private-config-marker');
      const error = JSON.parse(lines.at(-1));
      assert.equal(error.code, 1);
      assert.match(error.message, language === 'en' ? english : chinese);
      assert.doesNotMatch(
        error.message,
        /private-config-marker|example\.invalid/,
      );
    }
  }
});

test('container entry rejects positional configuration in the selected language before startup', () => {
  for (const language of ['zh', 'en', 'unsupported']) {
    const result = spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../../dist/container.js'), 'invalid'],
      { env: { QL_LANG: language }, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr);
    assert.equal(error.event, 'error');
    assert.match(
      error.message,
      language === 'en'
        ? /environment variables only/
        : /仅接受通过环境变量配置/,
    );
  }
});
