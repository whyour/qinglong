const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createContext } = require('../../dist/internal/runtime/context');
const { listTaskScripts } = require('../../dist/internal/execution/scriptInventory');

test('no-argument runner lists legacy JS candidates without evaluating scripts or config', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-inventory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = createContext({ root }, { PATH: process.env.PATH });
  const scripts = context.paths.dir_scripts;
  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(context.paths.dir_config, { recursive: true });
  await fs.writeFile(context.paths.file_config_user, 'exit 99\n');
  await fs.writeFile(
    path.join(scripts, 'job.js'),
    'throw Error("must not execute");\nconst $ = new Env("Daily job");\n',
  );
  await fs.writeFile(
    path.join(scripts, 'plain.js'),
    'throw Error("must not execute")',
  );
  await fs.writeFile(path.join(scripts, 'sendNotify.js'), '');
  await fs.writeFile(path.join(scripts, 'python.py'), '');
  await fs.mkdir(path.join(scripts, 'directory.js'));
  const old = await fs.readFile(
    path.resolve(__dirname, '../../../shell/otask.sh'),
    'utf8',
  );
  const definition = old.slice(
    old.indexOf('gen_array_scripts() {'),
    old.indexOf('## 使用说明'),
  );
  const legacy = execFileSync(
    'bash',
    [
      '-c',
      definition + '\ngen_array_scripts\nprintf "%s\\n" "${array_scripts[@]}"',
    ],
    {
      env: { PATH: process.env.PATH, dir_scripts: scripts },
      encoding: 'utf8',
    },
  )
    .trim()
    .split('\n')
    .sort();
  const expected = [
    { file: 'job.js', name: 'Daily job' },
    { file: 'plain.js', name: null },
  ];
  assert.deepEqual(await listTaskScripts(context), expected);
  assert.deepEqual(
    expected.map((x) => x.file),
    legacy,
  );
  const entry = path.resolve(__dirname, '../../dist/runner.js');
  const run = (args) =>
    execFileSync(process.execPath, [entry, '--root', root, ...args], {
      env: { PATH: process.env.PATH, QL_LANG: 'en' },
      encoding: 'utf8',
    });
  assert.deepEqual(JSON.parse(run(['--json'])).data.scripts, expected);
  assert.match(run([]), /Available scripts:/);
  assert.equal(JSON.parse(run(['--help', '--json'])).data.scripts, undefined);
  await fs.rm(scripts, { recursive: true });
  assert.deepEqual(JSON.parse(run(['--json'])).data.scripts, []);
  assert.match(run([]), /No scripts available/);
});
