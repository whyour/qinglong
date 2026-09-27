const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('shell translations print leading dashes, placeholders and newlines', () => {
  const result = spawnSync('bash', ['-c', String.raw`
    source shell/share.sh
    t '---> 服务诊断信息'
    t '---> 最近的系统日志: %s' '/tmp/test.log'
    t 'first\nsecond'
  `], { encoding: 'utf8', env: { ...process.env, QL_DIR: process.cwd() } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout,
    '---> 服务诊断信息\n---> 最近的系统日志: /tmp/test.log\nfirst\nsecond\n');
});
