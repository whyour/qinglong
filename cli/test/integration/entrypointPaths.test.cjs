const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installCliEntrypoints } = require('../../dist/local/entrypoints');

test('generated entries treat quotes, newlines and code-like paths as data', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-entry-paths-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cliRoot = path.join(root, "CLI '中文\n\");throw new Error('injected');//");
  const bin = path.join(root, 'bin');
  await fs.mkdir(path.join(cliRoot, 'dist'), { recursive: true });
  await fs.writeFile(path.join(cliRoot, 'dist/ql.js'), 'exports.qlMain=async()=>{console.log(JSON.stringify(process.argv.slice(2)));return 7;};');
  await fs.writeFile(path.join(cliRoot, 'dist/task.js'), 'exports.taskMain=async()=>{throw new Error("secret-value");};');
  await installCliEntrypoints(bin, cliRoot);
  const ql = spawnSync(process.execPath, [path.join(bin, 'ql'), '--literal', 'value'], { encoding: 'utf8' });
  assert.equal(ql.status, 7, ql.stderr);
  assert.deepEqual(JSON.parse(ql.stdout), ['--literal', 'value']);
  for (const language of ['en', 'zh']) {
    const result = spawnSync(process.execPath, [path.join(bin, 'task')], { encoding: 'utf8', env: { QL_LANG: language } });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, language === 'en' ? 'CLI invocation failed.\n' : 'CLI 调用失败。\n');
    assert.doesNotMatch(result.stderr, /secret-value/);
  }
});
