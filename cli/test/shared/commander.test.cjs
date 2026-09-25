const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../helpers/commands.cjs');
const { parseExecution } = require('../../dist/runner');
const fs = require('node:fs');
const path = require('node:path');

test('Commander adapter preserves literal values, option polarity, duplicate errors and IDs', () => {
  assert.equal(parse(['task','list','--search','00123']).values.search, '00123');
  assert.equal(parse(['local','start','--no-startup'], 'local').values['no-startup'], true);
  assert.equal(parse(['local','start'], 'local').values['no-startup'], undefined);
  assert.equal(parse(['auth','login','--url=--json']).values.url, '--json');
  assert.deepEqual(parse(['local','resetpwd','--','-literal'], 'local').positionals, ['-literal']);
  for (const args of [
    ['task','list','--search','--json'], ['auth','login','--url','--json'],
    ['task','list','-p','2','--page','3'], ['task','list','--json','--json'],
    ['--json','task','list','--json'], ['task','list','unexpected'],
    ['task','run','0'], ['task','run','script.js'], ['task','list','--size','201'],
    ['task','list','--json=false'],
  ]) assert.throws(() => parse(args), { exitCode:2 }, JSON.stringify(args));
  assert.ok(parse(['auth','login','--help']).help);
  assert.ok(parse(['--help']).help);
});

test('Commander task parsing stops at the script and preserves the execution separator', () => {
  const args = ['--root','/isolated','--json','script.sh','now','--','--json','--root','-literal'];
  const parsed = parseExecution(args);
  assert.equal(parsed.values.root, '/isolated');
  assert.equal(parsed.values.json, true);
  assert.deepEqual(parsed.execution.scriptArgs, ['--json','--root','-literal']);
  assert.deepEqual(parseExecution(['script.sh','--json']).execution.argv, ['script.sh','--json']);
  assert.deepEqual(parseExecution(['--','-script','--','-x']).execution.scriptArgs, ['-x']);
  assert.throws(() => parseExecution(['--root','--json','script.sh']), { exitCode:2 });
});

test('Commander is bundled once with its license and has no external runtime resolution', () => {
  const manifest = require('../../package.json');
  assert.equal(manifest.devDependencies.commander, '15.0.0');
  assert.equal(Object.keys(manifest.dependencies || {}).length, 0);
  const bundled = fs.readFileSync(path.join(__dirname,'../../dist/shared/cli/commander.js'), 'utf8');
  assert.doesNotMatch(bundled, /require\(["']commander["']\)/);
  assert.match(fs.readFileSync(path.join(__dirname,'../../dist/licenses/commander-LICENSE'), 'utf8'), /MIT/);
});
