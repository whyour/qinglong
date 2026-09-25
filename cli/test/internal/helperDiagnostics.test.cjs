const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createContext } = require('../../dist/internal/runtime/context');
const { inspectPanel } = require('../../dist/internal/maintenance/check');
const { loggedOperation } = require('../../dist/internal/runtime/commandLog');
const { installCliEntrypoints } = require('../../dist/local/entrypoints');

for (const language of ['zh', 'en', 'unsupported']) {
  test(`helper validation and generated wrappers honor locale: ${language}`, async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ql-helper-language-'),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const env = { QL_LANG: language, QlPort: '65536' };
    const context = createContext({ root }, env);
    const expected = (zh, en) => (language === 'en' ? en : zh);
    await assert.rejects(
      inspectPanel(context),
      expected(/必须在 1 到 65535/, /between 1 and 65535/),
    );
    let called = false;
    await assert.rejects(
      loggedOperation(context, '../outside', async () => {
        called = true;
      }),
      expected(/日志目录无效/, /Invalid command log directory/),
    );
    assert.equal(called, false);
    assert.deepEqual(await fs.readdir(root), []);
    const bin = path.join(root, 'bin');
    await assert.rejects(
      installCliEntrypoints(bin, 'relative', env),
      expected(/必须为绝对路径/, /must be absolute/),
    );
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'ql'), 'retained');
    await fs.mkdir(path.join(root, 'dist/ql.js'), { recursive: true });
    await assert.rejects(
      installCliEntrypoints(bin, root, env),
      expected(/必须为普通文件/, /not a regular file/),
    );
    assert.equal(await fs.readFile(path.join(bin, 'ql'), 'utf8'), 'retained');
    await fs.rm(path.join(root, 'dist/ql.js'), { recursive: true });
    for (const [file, name] of [
      ['ql', 'qlMain'],
      ['task', 'taskMain'],
    ])
      await fs.writeFile(
        path.join(root, 'dist', file + '.js'),
        `exports.${name}=async()=>{throw new Error('private-detail')};exports.taskMain=exports.${name};`,
      );
    await installCliEntrypoints(bin, root, env);
    for (const name of ['ql', 'task']) {
      const result = spawnSync(path.join(bin, name), [], {
        env,
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(
        result.stderr,
        expected(/CLI 调用失败/, /CLI invocation failed/),
      );
      assert.doesNotMatch(result.stderr, /private-detail/);
    }
  });
}
