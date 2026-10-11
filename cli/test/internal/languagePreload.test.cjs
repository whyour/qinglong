const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createContext } = require('../../dist/internal/runtime/context');
const { withOperationOutput } = require('../../dist/internal/runtime/output');
const { executeTask } = require('../../dist/internal/execution/taskRunner');

test('language hooks receive literal script arguments and temporary adapters are removed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql language literal '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = createContext(
    { root },
    { PATH: process.env.PATH, no_tee: 'true' },
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
    'env.py': '',
    'client.js': 'module.exports={};',
    'client.py': 'class Client:\n    pass\n',
    '__ql_notify__.js': 'exports.sendNotify=()=>{};',
    '__ql_notify__.py': 'def send(*args, **kwargs):\n    pass\n',
  }))
    await fs.writeFile(path.join(context.paths.dir_preload, name), contents);
  await fs.copyFile(
    path.resolve(__dirname, '../../../shell/preload/esm-loader.mjs'),
    path.join(context.paths.dir_preload, 'esm-loader.mjs'),
  );
  await fs.writeFile(
    context.paths.file_task_before,
    `export HOOK_ARGS="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "$@")"\n`,
  );
  await fs.writeFile(context.paths.file_task_before_js, '');
  await fs.writeFile(context.paths.file_task_before_py, '');
  for (const extension of ['js', 'py']) {
    const actualName = `job ' "$HOME" ;.${extension}`;
    const args = [
      'two words',
      '"quote"',
      "a'b",
      '$(touch SHOULD_NOT_EXIST)',
      '',
      '--flag',
    ];
    const script =
      extension === 'js'
        ? 'console.log("RESULT:"+JSON.stringify([JSON.parse(process.env.HOOK_ARGS), Object.keys(require.cache).find(file=>file.endsWith("/sitecustomize.js")), process.env.NODE_OPTIONS]));'
        : 'import os,json\nprint("RESULT:"+json.dumps([json.loads(os.environ["HOOK_ARGS"]),__import__("sitecustomize").__file__,os.environ.get("PYTHONPATH")]))\n';
    await fs.writeFile(
      path.join(context.paths.dir_scripts, actualName),
      script,
    );
    let diagnostics = '';
    const result = await withOperationOutput(
      (chunk) => {
        diagnostics += chunk;
      },
      () =>
        executeTask(context, {
          argv: [actualName],
          scriptArgs: args,
          mode: 'now',
        }),
    );
    const log = await fs.readFile(
      path.join(context.paths.dir_log, result.logPath),
      'utf8',
    );
    assert.equal(result.exitCode, 0, log + diagnostics);
    const line = log.split('\n').find((line) => line.startsWith('RESULT:'));
    assert.ok(line, log);
    const data = JSON.parse(line.slice(7));
    assert.deepEqual(data[0], [actualName, ...args]);
    assert.equal(data[2], '');
    await assert.rejects(fs.stat(path.dirname(data[1])), { code: 'ENOENT' });
    assert.doesNotMatch(log, /run task before error|run builtin code error/);
  }
  await assert.rejects(
    fs.stat(path.join(context.paths.dir_scripts, 'SHOULD_NOT_EXIST')),
    { code: 'ENOENT' },
  );
});
