const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

test('publishes bounded help without bootstrapping storage or a listener', () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../dist/cli.js'), '--help'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(
    result.stdout,
    'Usage: ql3-local-api --config /absolute/private-config.json\n',
  );
});
