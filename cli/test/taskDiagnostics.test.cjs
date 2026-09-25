const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  executeTask,
  selectedAccounts,
  durationMs,
} = require('../dist/local/taskRunner');
const { createContext } = require('../dist/local/context');

for (const language of ['zh', 'en', 'unsupported']) {
  test(`task validation exposes localized JSON and never starts invalid tasks: ${language}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-task-language-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'data/scripts'), { recursive: true });
    const marker = path.join(root, 'executed');
    const env = {
      PATH: process.env.PATH,
      QL_LANG: language,
      QL_DIR: root,
      TEST_ACCOUNTS: 'one&two',
    };
    const context = createContext({ root }, env);
    await assert.rejects(executeTask(context, { argv: [] }), (error) => {
      assert.equal(error.exitCode, 2);
      assert.match(
        error.message,
        language === 'en' ? /script or executable/ : /脚本或可执行程序/,
      );
      return true;
    });
    assert.deepEqual(selectedAccounts('2-1 max', 2, env), [2, 1]);
    assert.equal(durationMs('1.5m', env), 90000);
    for (const [before, body, chinese, english] of [
      [
        ['--timeout', 'invalid'],
        ['/usr/bin/touch'],
        /超时必须为正时长/,
        /positive duration/,
      ],
      [
        ['--timeout', '0'],
        ['/usr/bin/touch'],
        /超时时长超出支持范围/,
        /outside the supported range/,
      ],
      [
        [],
        ['/usr/bin/touch', 'desi', 'INVALID-NAME', '1'],
        /有效的账号环境变量名/,
        /valid account environment variable/,
      ],
      [
        [],
        ['/usr/bin/touch', 'desi', 'TEST_ACCOUNTS', 'bad'],
        /账号选择格式无效/,
        /Invalid account selection/,
      ],
      [
        [],
        ['/usr/bin/touch', 'desi', 'TEST_ACCOUNTS', '3'],
        /账号选择超出/,
        /outside the environment variable range/,
      ],
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve(__dirname, '../dist/runner.js'),
          '--json',
          '--root',
          root,
          ...before,
          ...body,
          '--',
          marker,
        ],
        {
          env,
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      const error = JSON.parse(result.stderr.trim().split('\n').at(-1));
      assert.equal(error.code, 2);
      assert.match(error.message, language === 'en' ? english : chinese);
      await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    }
  });
}
