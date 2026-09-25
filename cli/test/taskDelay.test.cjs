const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { matchesDelayExtension } = require('../dist/local/taskDelay');
const { createContext } = require('../dist/local/context');
const { executeTask } = require('../dist/local/taskRunner');

test('delay extension ERE matching agrees with unchanged legacy function', async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, '../../shell/otask.sh'),
    'utf8',
  );
  const fn = source.match(/random_delay\(\) \{[\s\S]*?\n\}/)[0];
  for (const [filename, extensions] of [
    ['a.js', undefined],
    ['a.sh', undefined],
    ['a.sh', ''],
    ['a.sh', 'js sh'],
    ['a.sh', 's[h]'],
    ['a.sh', '(js|sh)'],
    ['a.sh', '[[:alpha:]]{2}'],
    ['a.sh', '   '],
    ['a.sh', 'js\tsh'],
    ['a.sh', '['],
    ['a.sh', '-sh'],
    ['a.sh', '$(printf sh)'],
  ]) {
    const env = {
      PATH: process.env.PATH,
      RandomDelay: '1',
      RandomDelayIgnoredMinutes: '99',
      ...(extensions === undefined
        ? {}
        : { RandomDelayFileExtensions: extensions }),
    };
    const legacy = spawnSync(
      '/bin/bash',
      [
        '-c',
        `${fn}
date() { printf 0; }
gen_random_num() { printf 0; }
t() { :; }
sleep() { printf DELAYED; }
random_delay "$1"
`,
        'fixture',
        filename,
      ],
      { env, encoding: 'utf8' },
    );
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(
      await matchesDelayExtension(filename, env),
      legacy.stdout.includes('DELAYED'),
      JSON.stringify([filename, extensions]),
    );
  }
});

test('task runner applies ERE delay selection and still executes the script', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-delay-ere-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data/scripts'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'data/scripts/fixture.sh'),
    'printf TASK_RAN',
  );
  const env = {
    PATH: process.env.PATH,
    RandomDelay: '1',
    RandomDelayIgnoredMinutes: '99',
    RandomDelayFileExtensions: 's[h]',
  };
  let output = '';
  const result = await executeTask(createContext({ root }, env), {
    argv: ['fixture.sh'],
    output: (chunk) => {
      output += chunk.toString();
    },
  });
  assert.equal(result.exitCode, 0, output);
  assert.match(output, /任务随机延迟/);
  assert.match(output, /TASK_RAN/);
});

test('cancelled extension filtering uses the runner abort contract', async () => {
  const controller = new AbortController();
  controller.abort('SIGTERM');
  await assert.rejects(
    matchesDelayExtension(
      'a.js',
      { PATH: process.env.PATH },
      controller.signal,
    ),
    (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR',
  );
});

for (const language of ['zh', 'en', 'unsupported']) {
  test(`delay filtering failure and cancellation retain locale and status: ${language}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-delay-language-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(root, 'grep'),
      `#!${process.execPath}\nprocess.exitCode=7;`,
      { mode: 0o755 },
    );
    const env = { PATH: root, QL_LANG: language };
    await assert.rejects(matchesDelayExtension('job.js', env), (error) => {
      assert.equal(error.exitCode, 1);
      assert.match(error.message, language === 'en' ? /exit 7/ : /退出码 7/);
      return true;
    });
    const controller = new AbortController();
    controller.abort('SIGTERM');
    await assert.rejects(
      matchesDelayExtension('job.js', env, controller.signal),
      (error) => {
        assert.equal(error.name, 'AbortError');
        assert.equal(error.code, 'ABORT_ERR');
        assert.match(
          error.message,
          language === 'en' ? /filtering cancelled/ : /过滤已取消/,
        );
        return true;
      },
    );
  });
}
