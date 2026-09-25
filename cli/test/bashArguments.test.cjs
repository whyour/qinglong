const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runProcess } = require('../dist/local/process');
const { sourceEnvironment } = require('../dist/local/context');

test('shell option restoration never rewrites -c passed as a script argument', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-bash-argv-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'script.sh');
  await fs.writeFile(script, 'printf "%s\\0" "$@"\n');
  const env = await sourceEnvironment({ PATH: process.env.PATH }, []);
  const parameters = ['-c', 'literal $(printf injected)', '', 'space value'];
  for (const prefix of [
    [],
    ['--'],
    ['--noprofile', '--norc'],
    ['-o', 'pipefail'],
  ]) {
    const result = await runProcess(
      'bash',
      [...prefix, script, ...parameters],
      { env, capture: true },
    );
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout.split('\0'), [...parameters, '']);
  }
});

test('known Bash command forms restore options and preserve positional command arguments', async () => {
  const env = await sourceEnvironment({ PATH: process.env.PATH }, [], [], {
    command: 'set +o braceexpand',
  });
  for (const prefix of [[], ['--noprofile', '--norc']]) {
    const result = await runProcess(
      'bash',
      [
        ...prefix,
        '-c',
        'printf "%s\\0" {a,b} "$@"',
        'fixture',
        '-c',
        'original command data',
      ],
      { env, capture: true },
    );
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout.split('\0'), [
      '{a,b}',
      '-c',
      'original command data',
      '',
    ]);
  }
});
