const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createContext } = require('../dist/local/context');
const { replaceAndReload, reloadPanel } = require('../dist/local/upgrade');
const { installCronEntrypoint } = require('../dist/local/cronEntrypoint');

for (const language of ['zh', 'en', 'unsupported']) {
  test(`upgrade failures preserve files and localize using operation language: ${language}`, async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ql-upgrade-language-'),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const context = createContext({ root }, { QL_LANG: language });
    const expected = (zh, en) => (language === 'en' ? en : zh);
    let stops = 0;
    const lifecycle = {
      stop: async () => {
        stops++;
      },
      start: async () => {},
    };
    await assert.rejects(
      replaceAndReload(context, [{ source: root, target: root }], lifecycle),
      expected(/源与目标相同/, /equals destination/),
    );
    assert.equal(stops, 0);
    await fs.mkdir(context.paths.dir_tmp);
    await fs.writeFile(
      path.join(context.paths.dir_tmp, 'upgrade-ready-master.json'),
      JSON.stringify({ directory: '../outside' }),
    );
    await assert.rejects(
      reloadPanel(context, 'system'),
      expected(/指针无效/, /Invalid staged upgrade pointer/),
    );
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await fs.mkdir(source);
    await fs.mkdir(target);
    await fs.writeFile(path.join(source, 'version'), 'new');
    await fs.writeFile(path.join(target, 'version'), 'old');
    await fs.symlink(target, path.join(source, 'external'));
    await assert.rejects(
      reloadPanel(context, 'system', { source, static: source }),
      expected(/外部的符号链接/, /external symlink/),
    );
    await fs.unlink(path.join(source, 'external'));
    const cause = new Error('fixture startup failed');
    await assert.rejects(
      replaceAndReload(context, [{ source, target }], {
        stop: async () => {},
        start: async () => {
          throw cause;
        },
      }),
      (error) => {
        assert.match(
          error.message,
          expected(
            /文件已恢复.*原服务无法/,
            /files restored.*previous service/,
          ),
        );
        assert.equal(error.cause, cause);
        return true;
      },
    );
    assert.equal(
      await fs.readFile(path.join(target, 'version'), 'utf8'),
      'old',
    );
  });

  test(`installed cron bridge localizes failure without exposing values: ${language}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-cron-language-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const native = path.join(root, 'native');
    const bin = path.join(root, 'bin');
    await fs.mkdir(native);
    const touched = path.join(root, 'touched');
    await fs.writeFile(
      path.join(native, 'crontab'),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(
        touched,
      )},'called');`,
      { mode: 0o755 },
    );
    const source = path.join(root, 'table');
    await fs.writeFile(source, '* * * * * task job.js\n');
    const environment = {
      PATH: native,
      QL_LANG: language,
      QL_DIR: 'private-path\ninvalid',
    };
    await installCronEntrypoint(
      bin,
      path.resolve(__dirname, '..'),
      source,
      environment,
    );
    const run = (env) =>
      spawnSync(path.join(bin, 'crontab'), [source], { env, encoding: 'utf8' });
    const result = run({});
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      language === 'en' ? /Cannot install or read/ : /无法安装或读取/,
    );
    assert.doesNotMatch(result.stderr, /private-path/);
    await assert.rejects(fs.access(touched), { code: 'ENOENT' });
    assert.match(run({ QL_LANG: 'en' }).stderr, /Cannot install or read/);
    await assert.rejects(
      installCronEntrypoint('relative', root, source, environment),
      language === 'en' ? /must be absolute/ : /必须为绝对路径/,
    );
    await fs.writeFile(path.join(bin, 'crontab'), 'unrelated');
    await assert.rejects(
      installCronEntrypoint(bin, root, source, environment),
      language === 'en' ? /Refusing to replace/ : /拒绝覆盖/,
    );
    assert.equal(
      await fs.readFile(path.join(bin, 'crontab'), 'utf8'),
      'unrelated',
    );
  });
}
