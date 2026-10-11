const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createContext } = require('../../dist/internal/runtime/context');
const { syncRepository } = require('../../dist/internal/subscription/subscriptionRunner');
const { fileExcludedFromSync } = require('../../dist/internal/subscription/syncExclusions');

test('sync exclusions match exact relative files/directories without excluding siblings', () => {
  for (const name of ['env.js', 'config/a.js', 'config/deep/b.py']) assert.equal(fileExcludedFromSync(name, 'env.js\nconfig/\r\n'), true);
  for (const name of ['env.js.bak', 'other/env.js', 'config-other/a.js']) assert.equal(fileExcludedFromSync(name, 'env.js\nconfig/\r\n'), false);
});

test('CLI subscription updates preserve excluded selected, dependency and bundled files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-cli-exclusions-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const repo = path.join(root, 'owner/repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = args => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init']);
  for (const file of ['main.js', 'helper.js', 'absent.js']) fs.writeFileSync(path.join(repo, file), 'REMOTE');
  git(['add', '.']); git(['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-m', 'fixture']);
  const context = createContext({ root }, { ...process.env, QL_SUB_SKIP_FILES: 'main.js\nhelper.js\nsendNotify.js\nabsent.js' });
  const destination = path.join(context.paths.dir_scripts, 'owner_repo');
  fs.mkdirSync(destination, { recursive: true });
  for (const file of ['main.js', 'helper.js', 'sendNotify.js']) fs.writeFileSync(path.join(destination, file), 'LOCAL');
  fs.mkdirSync(path.dirname(context.paths.file_notify_js), { recursive: true });
  fs.writeFileSync(context.paths.file_notify_js, 'BUNDLED');
  fs.mkdirSync(context.paths.dir_dep, { recursive: true });
  fs.writeFileSync(path.join(context.paths.dir_dep, 'helper.js'), 'OVERLAY');
  const input = { url: repo, include: 'main|absent', exclude: 'helper', dependencies: 'helper', autoAdd: false, autoDelete: false };
  const result = await syncRepository(context, input);
  assert.deepEqual(result.files, ['owner_repo/main.js']);
  for (const file of ['main.js', 'helper.js', 'sendNotify.js']) assert.equal(fs.readFileSync(path.join(destination, file), 'utf8'), 'LOCAL');
  assert.equal(fs.existsSync(path.join(destination, 'absent.js')), false);
  context.env.QL_SUB_SKIP_FILES = '';
  await syncRepository(context, input);
  assert.equal(fs.readFileSync(path.join(destination, 'main.js'), 'utf8'), 'REMOTE');
  assert.equal(fs.readFileSync(path.join(destination, 'helper.js'), 'utf8'), 'OVERLAY');
});
