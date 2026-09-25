const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { within } = require('../../dist/internal/runtime/files');
const { createContext } = require('../../dist/internal/runtime/context');
const { loggedOperation } = require('../../dist/internal/runtime/commandLog');
const { executeTask } = require('../../dist/internal/execution/taskRunner');
const { syncRaw, repositoryName } = require('../../dist/internal/subscription/subscriptionRunner');
const { LocalApi } = require('../../dist/internal/runtime/api');
const subprocess = require('../../dist/internal/runtime/process');

for (const language of ['zh', 'en', 'unsupported']) {
  test(`path and subscription failures use their own operation language: ${language}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-path-language-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const env = { QL_LANG: language, real_log_path: '../../outside' };
    const context = createContext({ root }, env);
    const expected = (zh, en) => (language === 'en' ? en : zh);
    const boundaryError = (error) => {
      assert.equal(error.exitCode, 2);
      assert.match(error.message, expected(/管理目录内部/, /descendant/));
      return true;
    };
    for (const relative of ['', '..', '../outside', path.dirname(root)])
      assert.throws(() => within(root, relative, env), boundaryError);
    assert.equal(
      within(root, 'safe/file.js', env),
      path.join(root, 'safe/file.js'),
    );
    let called = false;
    await assert.rejects(
      loggedOperation(context, 'extra', async () => {
        called = true;
      }),
      boundaryError,
    );
    assert.equal(called, false);
    await assert.rejects(
      executeTask(context, { argv: ['must-not-execute'] }),
      boundaryError,
    );
    assert.throws(
      () =>
        repositoryName('https://example.invalid/invalid\nname', undefined, env),
      expected(/仓库路径无效/, /Invalid repository path/),
    );
    await assert.rejects(
      syncRaw(context, { url: 'file:///private/example.js' }),
      expected(/需要 HTTP\(S\)/, /require HTTP\(S\)/),
    );
    assert.deepEqual(await fs.readdir(root), []);
    t.mock.method(subprocess, 'checkedProcess', async (program, args) => {
      assert.equal(program, 'curl');
      await fs.writeFile(
        args[args.indexOf('--output') + 1],
        'console.log("fixture")',
      );
      return { code: 0 };
    });
    const calls = [];
    t.mock.method(LocalApi.prototype, 'call', async (...args) => {
      calls.push(args);
      return { data: null };
    });
    await assert.rejects(
      syncRaw(context, {
        url: 'https://example.invalid/job.js',
        autoAdd: true,
      }),
      (error) => {
        assert.equal(error.exitCode, 1);
        assert.match(
          error.message,
          expected(/无效任务列表/, /Invalid task list/),
        );
        return true;
      },
    );
    assert.deepEqual(calls, [['crons']]);
  });
}
