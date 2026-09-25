const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createContext } = require('../dist/local/context');
const { reloadPanel } = require('../dist/local/upgrade');
const operator = require('../dist/local/operator');
const selectedLoader =
  '// QL_CLI_ROOT dist/local/entrypoints.js dist/local/cronEntrypoint.js\n';

async function fixture(t) {
  const base = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql-upgrade-selection-'),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'panel'),
    source = path.join(base, 'source'),
    staticRoot = path.join(base, 'static'),
    cliRoot = path.join(base, 'cli');
  for (const dir of [
    root,
    path.join(source, 'sample'),
    path.join(staticRoot, 'build/loaders'),
    path.join(cliRoot, 'dist/local'),
  ])
    await fs.mkdir(dir, { recursive: true });
  for (const file of ['entrypoints.js', 'cronEntrypoint.js'])
    await fs.writeFile(path.join(cliRoot, 'dist/local', file), '');
  const ctx = createContext({ root }, { QL_CLI_ROOT: cliRoot, QL_LANG: 'en' });
  await fs.mkdir(path.join(ctx.paths.dir_static, 'build/loaders'), {
    recursive: true,
  });
  await fs.writeFile(path.join(root, 'package.json'), '{"version":"2.19.0"}');
  await fs.writeFile(path.join(source, 'package.json'), '{"version":"2.20.1"}');
  await fs.writeFile(
    path.join(source, 'sample/config.sample.sh'),
    'new sample',
  );
  const loader = path.join(ctx.paths.dir_static, 'build/loaders/deps.js');
  const incoming = path.join(staticRoot, 'build/loaders/deps.js');
  await fs.writeFile(loader, selectedLoader);
  await fs.writeFile(incoming, '// original released loader');
  await fs.writeFile(path.join(ctx.paths.dir_static, 'build/app.js'), 'old');
  await fs.writeFile(path.join(staticRoot, 'build/app.js'), 'new');
  return { ctx, source, staticRoot, loader, incoming };
}

for (const failure of [false, true])
  test(`selected loader is preserved transactionally; startup failure=${failure}`, async (t) => {
    const f = await fixture(t);
    let starts = 0;
    t.mock.method(operator, 'stopPanel', async () => {});
    t.mock.method(operator, 'startPanel', async () => {
      starts++;
      assert.equal(await fs.readFile(f.loader, 'utf8'), selectedLoader);
      assert.equal(
        await fs.readFile(
          path.join(f.ctx.paths.dir_static, 'build/app.js'),
          'utf8',
        ),
        starts === 1 ? 'new' : 'old',
      );
      if (failure && starts === 1) throw new Error('new startup failed');
      return { manager: 'fixture' };
    });
    const operation = reloadPanel(f.ctx, 'system', {
      source: f.source,
      static: f.staticRoot,
    });
    if (failure) await assert.rejects(operation, /new startup failed/);
    else assert.deepEqual((await operation).retainedBackups, []);
    assert.equal(starts, failure ? 2 : 1);
    assert.equal(
      await fs.readFile(f.incoming, 'utf8'),
      '// original released loader',
    );
    assert.deepEqual(await fs.readdir(f.ctx.paths.dir_tmp), []);
  });

test('unsupported target and unrecognized loader fail before service stop', async (t) => {
  const f = await fixture(t);
  let stopped = false;
  t.mock.method(operator, 'stopPanel', async () => {
    stopped = true;
  });
  await fs.writeFile(
    path.join(f.source, 'package.json'),
    '{"version":"3.0.0"}',
  );
  await assert.rejects(
    reloadPanel(f.ctx, 'system', { source: f.source, static: f.staticRoot }),
    /verified 2.x/,
  );
  await fs.writeFile(
    path.join(f.source, 'package.json'),
    '{"version":"2.20.1"}',
  );
  await fs.writeFile(f.loader, 'unrecognized');
  await assert.rejects(
    reloadPanel(f.ctx, 'system', { source: f.source, static: f.staticRoot }),
    /Cannot verify/,
  );
  assert.equal(stopped, false);
  assert.equal(await fs.readFile(f.loader, 'utf8'), 'unrecognized');
});
