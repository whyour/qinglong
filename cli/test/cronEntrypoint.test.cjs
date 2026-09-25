const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { installCronEntrypoint } = require('../dist/local/cronEntrypoint');

test('cron bridge scopes environment to the panel table and preserves native reads, failures and unrelated tables', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-cron-entry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const native = path.join(root, 'native'),
    bin = path.join(root, 'selected bin');
  await fs.mkdir(native);
  await fs.mkdir(bin);
  const state = path.join(root, 'installed');
  await fs.writeFile(
    path.join(native, 'crontab'),
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='-l')process.stdout.write(fs.readFileSync(process.env.TABLE));else if(args[0]==='-r'){process.stderr.write('native failure');process.exitCode=9;}else fs.writeFileSync(process.env.TABLE,fs.readFileSync(args[0]));`,
    { mode: 0o755 },
  );
  const source = path.join(root, 'panel table');
  const original =
    '# retain this original comment as is\n* * * * * task "job with spaces.js"\n';
  await fs.writeFile(source, original);
  const env = {
    QL_LANG: 'en',
    PATH: `${bin}:${native}`,
    QL_DIR: root,
    QL_DATA_DIR: path.join(root, 'data'),
    PYTHONPATH: "/python 'path' $(literal)",
    QL_CLIENT_SECRET: 'must-not-be-captured',
  };
  const install = () =>
    installCronEntrypoint(bin, path.resolve(__dirname, '..'), source, env);
  await install();
  await install();
  const wrapper = await fs.readFile(path.join(bin, 'crontab'), 'utf8');
  assert.doesNotMatch(wrapper, /must-not-be-captured|QL_CLIENT_SECRET/);
  const run = (args) =>
    spawnSync(path.join(bin, 'crontab'), args, {
      env: { TABLE: state },
      encoding: 'utf8',
    });
  assert.equal(run([source]).status, 0);
  const installed = await fs.readFile(state, 'utf8');
  assert.ok(installed.endsWith('task "job with spaces.js"\n'));
  assert.ok(installed.includes(`PATH='${bin}:${native}'`));
  assert.ok(installed.includes('# retain this original comment as is\n'));
  const job = installed
    .split('\n')
    .find((line) => line.startsWith('* * * * * '));
  const prefix = job.slice('* * * * * '.length, job.indexOf('task "'));
  const shell = spawnSync(
    '/bin/sh',
    ['-c', prefix + 'printf "%s" "$PYTHONPATH"'],
    { encoding: 'utf8', env: {} },
  );
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.stdout, env.PYTHONPATH);
  assert.equal(await fs.readFile(source, 'utf8'), original);
  assert.equal(run(['-l']).stdout, original);
  const failed = run(['-r']);
  assert.equal(failed.status, 9);
  assert.equal(failed.stderr, 'native failure');
  const other = path.join(root, 'other');
  await fs.writeFile(other, 'OTHER\n');
  assert.equal(run([other]).status, 0);
  assert.equal(await fs.readFile(state, 'utf8'), 'OTHER\n');
  env.QL_DIR = 'invalid\nvalue';
  await install();
  assert.equal(run([source]).status, 1);
  assert.equal(await fs.readFile(state, 'utf8'), 'OTHER\n');
  await fs.writeFile(path.join(bin, 'crontab'), '# unrelated command\n');
  await assert.rejects(install(), /Refusing to replace/);
  assert.equal(
    await fs.readFile(path.join(bin, 'crontab'), 'utf8'),
    '# unrelated command\n',
  );
});
