const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createContext } = require('../dist/local/context');
const { extendedLifecycle } = require('../dist/local/lifecycle');
const { loggedOperation } = require('../dist/local/commandLog');

test('installed panel version selects lifecycle schema and unknown versions stay conservative', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = createContext({ root }, {});
  assert.equal(await extendedLifecycle(context), false);
  for (const [version, expected] of [
    ['2.20.1', false],
    ['2.19.0', false],
    ['2.21.0-14', true],
    ['3.0.0', false],
    ['invalid', false],
  ]) {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ version }),
    );
    assert.equal(await extendedLifecycle(context), expected);
  }
  context.env.QL_CLI_LIFECYCLE = 'extended';
  assert.equal(await extendedLifecycle(context), true);
  context.env.QL_CLI_LIFECYCLE = 'legacy';
  assert.equal(await extendedLifecycle(context), false);
});

test('command log preserves scheduler path and rejects escaping the log directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-scheduler-log-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = createContext(
    { root },
    { real_log_path: 'ql/scheduled.log', no_tee: 'true' },
  );
  const result = await loggedOperation(context, 'extra', async () => 'done');
  assert.equal(result.logPath, 'ql/scheduled.log');
  assert.match(
    await fs.readFile(path.join(context.paths.dir_log, result.logPath), 'utf8'),
    /执行结束/,
  );
  context.env.real_log_path = '../outside.log';
  await assert.rejects(
    loggedOperation(context, 'extra', async () => assert.fail('must not run')),
  );
});

test('released version.yaml selects lifecycle only when package version is absent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-release-version-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = createContext({ root }, {});
  await fs.writeFile(
    path.join(root, 'package.json'),
    '{"name":"released-panel"}',
  );
  for (const [release, expected] of [
    ['version: 2.20.1\nchangeLog: |\n  version: 2.99.0\n', false],
    ['version: 2.21.0-14\npublishTime: 2026-09-25\n', true],
    ['version: "2.21.1" # release\n', true],
    ["\ufeffversion: '2.22.0'\r\n", true],
    ['version: 3.0.0\n', false],
    ['version: 2.21.invalid\n', false],
    ['version: 2.21.0\nversion: 2.20.1\n', false],
    ['changeLog: |\n  version: 2.21.0\n', false],
    ['version: !custom 2.21.0\n', false],
  ]) {
    await fs.writeFile(path.join(root, 'version.yaml'), release);
    assert.equal(await extendedLifecycle(context), expected, release);
  }
  await fs.writeFile(path.join(root, 'version.yaml'), 'version: 2.21.1\n');
  await fs.writeFile(path.join(root, 'package.json'), '{"version":"2.20.1"}');
  assert.equal(await extendedLifecycle(context), false);
  context.env.QL_CLI_LIFECYCLE = 'extended';
  assert.equal(await extendedLifecycle(context), true);
  context.env.QL_CLI_LIFECYCLE = 'legacy';
  assert.equal(await extendedLifecycle(context), false);
  delete context.env.QL_CLI_LIFECYCLE;
  await fs.rm(path.join(root, 'package.json'));
  assert.equal(await extendedLifecycle(context), true);
  await fs.rm(path.join(root, 'version.yaml'));
  assert.equal(await extendedLifecycle(context), false);
});

test('release-only version metadata controls actual task and maintenance status payloads', async (t) => {
  const { LocalApi } = require('../dist/local/api');
  const { executeTask } = require('../dist/local/taskRunner');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-release-payload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = createContext(
    { root },
    { PATH: process.env.PATH, ID: '7', no_tee: 'true' },
  );
  await fs.mkdir(context.paths.dir_scripts, { recursive: true });
  await fs.writeFile(
    path.join(context.paths.dir_scripts, 'fixture.sh'),
    'return 7',
  );
  const calls = [];
  t.mock.method(LocalApi.prototype, 'call', async (endpoint, method, body) => {
    calls.push({ endpoint, body });
    return { code: 200 };
  });
  for (const version of ['2.20.1', '2.21.0-14']) {
    await fs.writeFile(
      path.join(root, 'version.yaml'),
      `version: ${version}\n`,
    );
    calls.length = 0;
    const result = await executeTask(context, {
      argv: ['fixture.sh'],
      mode: 'now',
    });
    assert.equal(result.exitCode, 7);
    const final = calls
      .filter((row) => row.endpoint === 'crons/status')
      .at(-1).body;
    assert.equal(final.exit_code, version === '2.20.1' ? undefined : 7);
    assert.equal(
      calls.some((row) => row.endpoint === 'dashboard/record'),
      version !== '2.20.1',
    );
    calls.length = 0;
    await loggedOperation(context, 'extra', async () => true);
    assert.equal(
      calls.at(-1).body.exit_code,
      version === '2.20.1' ? undefined : 0,
    );
  }
});
