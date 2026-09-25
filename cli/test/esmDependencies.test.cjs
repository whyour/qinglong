const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createContext } = require('../dist/local/context');
const { executeTask } = require('../dist/local/taskRunner');

test('ESM resolves global packages and exported subpaths with native import conditions and local fallback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-esm-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const global = path.join(root, 'global # percent % space', 'node_modules');
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, 'pnpm'),
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(global)});`,
    { mode: 0o755 },
  );
  const context = createContext(
    { root },
    { PATH: `${bin}${path.delimiter}${process.env.PATH}`, no_tee: 'true' },
  );
  for (const dir of [
    context.paths.dir_preload,
    context.paths.dir_config,
    context.paths.dir_scripts,
  ])
    await fs.mkdir(dir, { recursive: true });
  for (const [name, contents] of Object.entries({
    'env.sh': '',
    'env.js': '',
    'client.js': 'module.exports={};',
    '__ql_notify__.js': 'exports.sendNotify=()=>{};',
  }))
    await fs.writeFile(path.join(context.paths.dir_preload, name), contents);
  await fs.copyFile(
    path.resolve(__dirname, '../../shell/preload/esm-loader.mjs'),
    path.join(context.paths.dir_preload, 'esm-loader.mjs'),
  );
  await fs.writeFile(context.paths.file_task_before, 'true\n');
  await fs.writeFile(context.paths.file_task_before_js, '');
  const packages = [
    [
      global,
      'ql-fixture',
      {
        type: 'module',
        exports: {
          '.': { import: './entry.mjs', require: './entry.cjs' },
          './feature': './actual/feature.mjs',
        },
      },
      {
        'entry.mjs': 'export default "global-import";',
        'entry.cjs': 'module.exports="global-require";',
        'actual/feature.mjs': 'export default "global-feature";',
        'private.mjs': 'export default "private";',
      },
    ],
    [
      global,
      '@ql/fixture',
      {
        type: 'module',
        exports: { '.': './entry.mjs', './feature': './feature.mjs' },
        imports: { '#internal': './internal.mjs' },
      },
      {
        'entry.mjs': 'import value from "#internal"; export default value;',
        'internal.mjs': 'export default "scoped";',
        'feature.mjs': 'export default "scoped-feature";',
      },
    ],
    [
      context.paths.dir_scripts + '/node_modules',
      'ql-fixture',
      { type: 'module', main: 'index.mjs' },
      { 'index.mjs': 'export default "local-shadow";' },
    ],
    [
      context.paths.dir_scripts + '/node_modules',
      'local-only',
      { type: 'module', main: 'index.mjs' },
      { 'index.mjs': 'export default "local-only";' },
    ],
    [
      global,
      'common-fixture',
      { main: 'index.cjs' },
      { 'index.cjs': 'module.exports="commonjs";' },
    ],
  ];
  for (const [base, name, manifest, files] of packages) {
    const dir = path.join(base, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, ...manifest }),
    );
    for (const [file, source] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await fs.writeFile(path.join(dir, file), source);
    }
  }
  // A pnpm-style global link points into the content store, not a copied package.
  const link = path.join(global, '@ql/fixture');
  const stored = path.join(
    global,
    '.pnpm',
    '@ql+fixture@1',
    'node_modules',
    '@ql',
    'fixture',
  );
  await fs.mkdir(path.dirname(stored), { recursive: true });
  await fs.rename(link, stored);
  await fs.symlink(stored, link);
  await fs.writeFile(
    path.join(context.paths.dir_scripts, 'relative.mjs'),
    'export default "relative";',
  );
  const expected = {
    'ql-fixture': 'global-import',
    'ql-fixture/feature': 'global-feature',
    '@ql/fixture': 'scoped',
    '@ql/fixture/feature': 'scoped-feature',
    'local-only': 'local-only',
    'common-fixture': 'commonjs',
    './relative.mjs': 'relative',
    'data:text/javascript,export default "data"': 'data',
    'ql-fixture/private.mjs': 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  };
  await fs.writeFile(
    path.join(context.paths.dir_scripts, 'fixture.mjs'),
    `import fs from 'node:fs'; import path from 'path'; const result={}; for (const name of ${JSON.stringify(
      Object.keys(expected),
    )}) { try { result[name]=(await import(name)).default; } catch(error) { result[name]=error.code; } } console.log('RESULT:'+JSON.stringify(result));`,
  );
  const result = await executeTask(context, {
    argv: ['fixture.mjs'],
    mode: 'now',
  });
  const log = await fs.readFile(
    path.join(context.paths.dir_log, result.logPath),
    'utf8',
  );
  assert.equal(result.exitCode, 0, log);
  const line = log.split('\n').find((line) => line.startsWith('RESULT:'));
  assert.ok(line, log);
  assert.deepEqual(JSON.parse(line.slice(7)), expected);
});
