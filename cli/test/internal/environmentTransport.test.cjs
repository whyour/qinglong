const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceEnvironment } = require('../../dist/internal/runtime/context');
const { runProcess } = require('../../dist/internal/runtime/process');

test('environment transport preserves multiline values, empty values and exported functions', async () => {
  const value = '中文\nsecond=line\r\n"quoted"\\literal';
  const env = await sourceEnvironment({ PATH: process.env.PATH, VALUE: value }, [], [], {
    command: 'export EMPTY=""; exported_fn() { printf "%s" "$VALUE"; }; export -f exported_fn; set -o pipefail; shopt -s nullglob; printf "user output"',
    output: () => {},
  });
  assert.equal(env.VALUE, value);
  assert.equal(env.EMPTY, '');
  assert.ok(env.QL_CLI_SHELLOPTS.split(':').includes('pipefail'));
  assert.ok(!env.QL_CLI_SHELLOPTS.split(':').includes('allexport'));
  assert.ok(env.QL_CLI_BASHOPTS.split(':').includes('nullglob'));
  assert.ok(!Object.keys(env).some(key => key.startsWith('__ql_')));
  const child = await runProcess('bash', ['--noprofile', '--norc', '-c', 'exported_fn'], { env, capture: true });
  assert.equal(child.code, 0);
  assert.equal(child.stdout, value);
});

test('environment transport does not execute a Node runtime from user configuration', async () => {
  const env = await sourceEnvironment({ PATH: process.env.PATH }, [], [], {
    command: 'export NODE_OPTIONS="--this-option-does-not-exist"; export PATH="/nonexistent"',
  });
  assert.equal(env.NODE_OPTIONS, '--this-option-does-not-exist');
  assert.equal(env.PATH, '/nonexistent');
});

for (const redirect of ['exec 3>/dev/null 9>/dev/null', 'exec 3>&-']) {
  test(`environment transport survives user descriptors: ${redirect}`, async () => {
    const env = await sourceEnvironment({ PATH: process.env.PATH }, [], [], {
      command: `${redirect}; export FIXTURE_VALUE=present`,
    });
    assert.equal(env.FIXTURE_VALUE, 'present');
  });
}
