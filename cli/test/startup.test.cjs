const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startupMain } = require('../dist/startup');

test('startup compatibility uses the shared host-start handler with exact mode and directory arguments', async (t) => {
  const main = require('../dist/main');
  const calls = [];
  t.mock.method(main, 'main', async (args, surface, signal) => {
    calls.push({ args, surface, signal });
    return 7;
  });
  assert.equal(await startupMain([]), 7);
  assert.equal(
    await startupMain([
      'reload',
      '--root',
      '/a b',
      '--data-dir',
      '/storage/data',
      '--json',
    ]),
    7,
  );
  assert.equal(await startupMain(['--root', '/a b', '--no-startup']), 7);
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      ['start'],
      [
        'start',
        '--reload',
        '--root',
        '/a b',
        '--data-dir',
        '/storage/data',
        '--json',
      ],
      ['start', '--root', '/a b', '--no-startup'],
    ],
  );
  assert.ok(
    calls.every(
      ({ surface, signal }) =>
        surface === 'local' && signal instanceof AbortSignal,
    ),
  );
});

test('installed startup entry has bilingual JSON help and validates before executing host operations', () => {
  const entry = path.resolve(__dirname, '../dist/startup.js');
  const run = (args, language = 'zh') =>
    spawnSync(process.execPath, [entry, ...args], {
      env: { ...process.env, QL_DIR: '', QL_DATA_DIR: '', QL_LANG: language },
      encoding: 'utf8',
      timeout: 5000,
    });
  for (const [language, pattern] of [
    ['zh', /用法/],
    ['en', /Usage:/],
  ]) {
    const result = run(['--help', '--json'], language);
    assert.equal(result.status, 0, result.stderr);
    const help = JSON.parse(result.stdout).data.help;
    assert.match(help, pattern);
    assert.match(help, /qinglong-cli/);
    assert.match(help, /reload/);
  }
  for (const args of [[], ['reload'], ['unexpected'], ['reload', 'extra']]) {
    const result = run([...args, '--json']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 2);
  }
});
