const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createContext } = require('../dist/local/context');
const { executeTask } = require('../dist/local/taskRunner');

test('real language preloaders inject generated environment, hooks and designated accounts', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql-preload-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = createContext(
    { root },
    {
      PATH: `${path.resolve(__dirname, '../../node_modules/.bin')}${
        path.delimiter
      }${process.env.PATH}`,
      no_tee: 'true',
      TS_NODE_COMPILER_OPTIONS: JSON.stringify({
        module: 'CommonJS',
        moduleResolution: 'Node',
      }),
    },
  );
  for (const dir of [
    context.paths.dir_preload,
    context.paths.dir_config,
    context.paths.dir_scripts,
  ])
    await fs.mkdir(dir, { recursive: true });
  for (const file of ['sitecustomize.js', 'sitecustomize.py', 'esm-loader.mjs'])
    await fs.copyFile(
      path.resolve(__dirname, '../../shell/preload', file),
      path.join(context.paths.dir_preload, file),
    );
  // Transport adapters are inert; the actual preloader and generated env formats run.
  const fixtures = {
    'client.js': 'module.exports={};',
    '__ql_notify__.js': 'exports.sendNotify=()=>{};',
    'client.py': 'class Client:\n    pass\n',
    '__ql_notify__.py': 'def send(*args, **kwargs):\n    pass\n',
    'env.sh': 'export ACCOUNTS="one&two&three"\n',
    'env.js': 'process.env.ACCOUNTS="one&two&three";',
    'env.py': 'import os\nos.environ["ACCOUNTS"]="one&two&three"\n',
  };
  for (const [file, text] of Object.entries(fixtures))
    await fs.writeFile(path.join(context.paths.dir_preload, file), text);
  await fs.writeFile(
    context.paths.file_task_before,
    'export FROM_SHELL=before\n',
  );
  await fs.writeFile(
    context.paths.file_task_before_js,
    'process.env.FROM_LANGUAGE="javascript";',
  );
  await fs.writeFile(
    context.paths.file_task_before_py,
    'import os\nos.environ["FROM_LANGUAGE"]="python"\n',
  );
  await fs.writeFile(
    context.paths.file_task_after,
    'printf "after:%s\\n" "$_task_exit_code"',
  );
  for (const extension of ['js', 'mjs', 'py', 'pyc', 'ts']) {
    await t.test(extension, async () => {
      const script = extension.startsWith('py')
        ? 'import os,json\nprint("RESULT:"+json.dumps([os.getenv("ACCOUNTS"),os.getenv("FROM_SHELL"),os.getenv("FROM_LANGUAGE"),hasattr(__import__("builtins"),"QLAPI")]))\n'
        : 'console.log("RESULT:"+JSON.stringify([process.env.ACCOUNTS,process.env.FROM_SHELL,process.env.FROM_LANGUAGE,!!globalThis.QLAPI]));';
      await fs.writeFile(
        path.join(
          context.paths.dir_scripts,
          `fixture.${extension === 'pyc' ? 'py' : extension}`,
        ),
        extension === 'ts'
          ? `const fixtureTypedValue: number = 1;\n${script}`
          : script,
      );
      if (extension === 'pyc')
        execFileSync('python3', [
          '-c',
          'import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)',
          path.join(context.paths.dir_scripts, 'fixture.py'),
          path.join(context.paths.dir_scripts, 'fixture.pyc'),
        ]);
      const result = await executeTask(context, {
        argv: [`fixture.${extension}`],
        mode: 'desi',
        variable: 'ACCOUNTS',
        selection: '3 1',
      });
      assert.equal(result.exitCode, 0);
      const log = await fs.readFile(
        path.join(context.paths.dir_log, result.logPath),
        'utf8',
      );
      const line = log.split('\n').find((line) => line.startsWith('RESULT:'));
      assert.ok(line, log);
      assert.deepEqual(JSON.parse(line.slice(7)), [
        'three&one',
        'before',
        extension.startsWith('py') ? 'python' : 'javascript',
        true,
      ]);
      assert.match(log, /after:0/);
      assert.doesNotMatch(log, /run task before error|run builtin code error/);
    });
  }
});
