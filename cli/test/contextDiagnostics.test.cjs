const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourceEnvironment } = require('../dist/local/context');

test('developer entry localizes invalid release arguments without invoking Git or publishing', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql-release-diagnostics-'),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [args, chinese, english] of [
    [['absent'], /请使用 release --root/, /Expected release --root/],
    [
      ['release', '--root', root, '--apply'],
      /--apply 需要通过 --commit/,
      /--apply requires --commit/,
    ],
    [
      ['release', '--root', root, '--commit', 'abc'],
      /--commit 必须与 --apply/,
      /--commit requires --apply/,
    ],
    [
      ['release', '--unknown-option'],
      /发布选项无效/,
      /Invalid release options/,
    ],
  ]) {
    for (const language of ['zh', 'en']) {
      const result = spawnSync(
        process.execPath,
        [path.resolve(__dirname, '../dist/developer.js'), ...args, '--json'],
        {
          env: { QL_LANG: language, PATH: '' },
          cwd: root,
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, '');
      const error = JSON.parse(result.stderr);
      assert.equal(error.code, 2);
      assert.match(error.message, language === 'en' ? english : chinese);
    }
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test('all local entrypoints report missing, relative and non-directory roots before doing work', async (t) => {
  const base = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql-context-diagnostics-'),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const file = path.join(base, 'file');
  await fs.writeFile(file, 'unchanged');
  for (const [entry, args] of [
    ['admin', ['extra', '--json']],
    ['startup', ['--json']],
    ['runner', ['--json', 'sample.js']],
    ['compat', ['extra']],
    ['subscription-worker', ['raw', 'https://example.invalid/script.js']],
  ]) {
    for (const root of [
      '',
      'relative-root',
      path.join(base, 'missing'),
      file,
    ]) {
      for (const language of ['zh', 'en']) {
        const child = spawnSync(
          process.execPath,
          [path.resolve(__dirname, `../dist/${entry}.js`), ...args],
          {
            env: {
              ...process.env,
              QL_LANG: language,
              QL_DIR: root,
              QL_DATA_DIR: '',
              SUB_ID: '',
            },
            encoding: 'utf8',
            timeout: 5000,
          },
        );
        assert.equal(child.status, 2, `${entry}: ${child.stderr}`);
        assert.equal(child.stdout, '');
        const error = JSON.parse(child.stderr);
        assert.equal(error.code, 2);
        assert.match(
          error.message,
          path.isAbsolute(root)
            ? language === 'en'
              ? /Panel root does not exist/
              : /面板安装目录不存在或不是目录/
            : language === 'en'
            ? /absolute --root or QL_DIR/
            : /--root 或 QL_DIR 指定绝对路径/,
        );
      }
    }
  }
  assert.equal(await fs.readFile(file, 'utf8'), 'unchanged');
  assert.deepEqual(await fs.readdir(base), ['file']);
});

test('configuration bridge localizes execution, invalid-data and cancellation errors without changing their types', async () => {
  for (const language of ['zh', 'en']) {
    const env = { PATH: process.env.PATH, QL_LANG: language };
    for (const [command, chinese, english] of [
      ['exit 7', /用户配置加载失败/, /User configuration evaluation failed/],
      ['exit 0', /无效的环境数据/, /invalid environment data/],
    ]) {
      await assert.rejects(
        sourceEnvironment(env, [], [], { command }),
        (error) => {
          assert.equal(error.name, 'Error');
          assert.match(error.message, language === 'en' ? english : chinese);
          return true;
        },
      );
    }
    const controller = new AbortController();
    const execution = sourceEnvironment(env, [], [], {
      command: 'printf ready; sleep 30',
      signal: controller.signal,
      output: () => controller.abort(),
    });
    await assert.rejects(execution, (error) => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.code, 'ABORT_ERR');
      assert.match(
        error.message,
        language === 'en' ? /evaluation cancelled/ : /用户配置加载已取消/,
      );
      return true;
    });
  }
});
