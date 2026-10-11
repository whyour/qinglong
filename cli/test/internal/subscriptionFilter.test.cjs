const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { matchSubscriptionPaths } = require('../../dist/internal/subscription/subscriptionFilter');

test('subscription filters preserve legacy POSIX classes, escaping, anchors and option-like patterns', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-filter-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = [
    'job12.js',
    'jobdd.js',
    'Job3.py',
    'lib/helper.js',
    'name space.js',
    '-leading.js',
    '$(touch injected).js',
  ];
  const env = { ...process.env, LC_ALL: 'C', QL_LANG: 'en' };
  for (const pattern of [
    '^job[[:digit:]]+\\.js$',
    '[[:space:]]',
    '\\d+',
    '^lib/|^Job',
    '-leading',
    'no-match',
    '[$]',
  ]) {
    let expected;
    try {
      expected = execFileSync('grep', ['-E', '-e', pattern], {
        input: files.join('\n') + '\n',
        encoding: 'utf8',
        env,
      })
        .trimEnd()
        .split('\n')
        .filter(Boolean);
    } catch (error) {
      if (error.status !== 1) throw error;
      expected = [];
    }
    assert.deepEqual(
      [...(await matchSubscriptionPaths(files, pattern, root, env))],
      expected,
    );
  }
  await assert.rejects(
    matchSubscriptionPaths(files, '[', root, env),
    /Invalid subscription POSIX/,
  );
  await assert.rejects(
    matchSubscriptionPaths(['line\nbreak.js'], 'job', root, env),
    /line breaks/,
  );
  assert.deepEqual(await fs.readdir(root), []);
});

for (const language of ['zh', 'en', 'unsupported']) {
  test(`filter errors localize without leaking paths or leaving temporary files: ${language}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-filter-errors-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const env = { PATH: process.env.PATH, QL_LANG: language };
    const expectError = (code, chinese, english) => (error) => {
      assert.equal(error.exitCode, code);
      assert.match(error.message, language === 'en' ? english : chinese);
      assert.doesNotMatch(error.message, /private-path/);
      return true;
    };
    await assert.rejects(
      matchSubscriptionPaths(['private-path\nbad'], '.', root, env),
      expectError(2, /无法安全过滤/, /cannot be filtered safely/),
    );
    await assert.rejects(
      matchSubscriptionPaths(['private-path'], '[', root, env),
      expectError(2, /正则表达式无效/, /Invalid subscription POSIX/),
    );
    assert.deepEqual(await fs.readdir(root), []);
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(
      path.join(bin, 'grep'),
      `#!${process.execPath}\nprocess.exitCode=7;`,
      { mode: 0o755 },
    );
    await assert.rejects(
      matchSubscriptionPaths(['private-path'], '.', root, {
        ...env,
        PATH: bin,
      }),
      expectError(1, /退出码 7/, /exit 7/),
    );
    assert.deepEqual(await fs.readdir(root), ['bin']);
  });
}
