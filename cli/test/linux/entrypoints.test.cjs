const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { installCliEntrypoints } = require('../../dist/local/entrypoints');

test('2.x startup selection survives repeated linking and can return to original Shell', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-entrypoints-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const cliRoot = path.join(root, 'CLI with spaces');
  const bin = path.join(home, 'bin');
  await fs.mkdir(path.join(root, 'shell'), { recursive: true });
  for (const name of ['update.sh', 'task.sh'])
    await fs.writeFile(path.join(root, 'shell', name), 'original');
  await fs.mkdir(path.join(cliRoot, 'dist/local'), { recursive: true });
  for (const [file, method] of [
    ['ql', 'qlMain'],
    ['task', 'taskMain'],
  ])
    await fs.writeFile(
      path.join(cliRoot, 'dist', `${file}.js`),
      `exports.${method}=async()=>{console.log(JSON.stringify(process.argv.slice(2)));return 7;};`,
    );
  await fs.writeFile(
    path.join(cliRoot, 'dist/local/entrypoints.js'),
    `exports.installCliEntrypoints=require(${JSON.stringify(
      path.resolve(__dirname, '../../dist/local/entrypoints'),
    )}).installCliEntrypoints;`,
  );
  await fs.writeFile(
    path.join(cliRoot, 'dist/local/cronEntrypoint.js'),
    `module.exports=require(${JSON.stringify(
      path.resolve(__dirname, '../../dist/local/cronEntrypoint'),
    )});`,
  );
  const code = ts.transpileModule(
    await fs.readFile(
      path.resolve(__dirname, '../../../back/loaders/deps.ts'),
      'utf8',
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const errors = [];
  const legacyBin = path.join(root, 'legacy-bin');
  await fs.mkdir(legacyBin);
  for (const name of ['ql', 'task'])
    await fs.writeFile(path.join(legacyBin, name), '#!/bin/sh\nexit 99\n', {
      mode: 0o755,
    });
  await fs.writeFile(path.join(legacyBin, 'crontab'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  const originalPath = [legacyBin, bin, '/usr/bin', '/bin'].join(
    path.delimiter,
  );
  const environment = { PATH: originalPath };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    process: { env: environment },
    require: (id) => {
      if (id === 'os') return { homedir: () => home };
      if (id === '../config/index')
        return {
          rootPath: root,
          dataPath: path.join(root, 'data'),
          crontabFile: path.join(root, 'data/config/crontab.list'),
        };
      if (id === './logger') return { error: (...args) => errors.push(args) };
      return require(id);
    },
  });
  await module.exports.default();
  assert.equal(
    await fs.readlink(path.join(bin, 'ql')),
    path.join(root, 'shell/update.sh'),
  );
  assert.equal(environment.PATH, originalPath);
  assert.equal(spawnSync('ql', [], { env: environment }).status, 99);
  environment.QL_CLI_ROOT = cliRoot;
  for (let i = 0; i < 2; i++) {
    await module.exports.default();
    assert.equal(environment.PATH.split(path.delimiter)[0], bin);
    assert.equal(
      environment.PATH.split(path.delimiter).filter((value) => value === bin)
        .length,
      1,
    );
    for (const name of ['ql', 'task']) {
      const result = spawnSync(name, ['--literal', 'a b', '$(nothing)'], {
        encoding: 'utf8',
        env: { ...process.env, ...environment },
      });
      assert.equal(result.status, 7, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [
        '--literal',
        'a b',
        '$(nothing)',
      ]);
    }
  }
  assert.match(
    await fs.readFile(path.join(bin, 'crontab'), 'utf8'),
    /QingLong CLI crontab bridge/,
  );
  assert.deepEqual(errors, []);
  const before = await fs.readFile(path.join(bin, 'ql'), 'utf8');
  environment.QL_CLI_ROOT = 'relative';
  await module.exports.default();
  assert.equal(errors.length, 1);
  assert.equal(await fs.readFile(path.join(bin, 'ql'), 'utf8'), before);
  delete environment.QL_CLI_ROOT;
  await module.exports.default();
  await assert.rejects(fs.lstat(path.join(bin, 'crontab')), { code: 'ENOENT' });
  await fs.writeFile(path.join(bin, 'crontab'), '# unrelated user command');
  await module.exports.default();
  assert.equal(
    await fs.readFile(path.join(bin, 'crontab'), 'utf8'),
    '# unrelated user command',
  );
  assert.equal(
    await fs.readlink(path.join(bin, 'task')),
    path.join(root, 'shell/task.sh'),
  );
  assert.equal(
    await fs.readFile(path.join(root, 'shell/task.sh'), 'utf8'),
    'original',
  );
});

test('incomplete CLI installation leaves both existing entrypoints untouched', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-entry-incomplete-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'dist/ql.js'), '');
  for (const name of ['ql', 'task'])
    await fs.writeFile(path.join(bin, name), 'keep');
  await assert.rejects(installCliEntrypoints(bin, root));
  for (const name of ['ql', 'task'])
    assert.equal(await fs.readFile(path.join(bin, name), 'utf8'), 'keep');
});
