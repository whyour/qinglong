const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createContext } = require('../../dist/internal/runtime/context');
const { loggedOperation } = require('../../dist/internal/runtime/commandLog');

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

test('managed CLI tasks and maintenance commands report against the parent receipt', async (t) => {
  const { LocalApi } = require('../../dist/internal/runtime/api');
  const { executeTask } = require('../../dist/internal/execution/taskRunner');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-managed-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = 'parent-receipt-7';
  const context = createContext(
    { root },
    {
      PATH: process.env.PATH,
      ID: '7',
      no_tee: 'true',
      QL_TRIGGER_ID: id,
      QL_CLI_LIFECYCLE: 'extended',
      QL_EXECUTION_ORIGIN: 'scheduled_system',
    },
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
  const result = await executeTask(context, {
    argv: ['fixture.sh'],
    mode: 'now',
  });
  assert.equal(result.exitCode, 7);
  assert.deepEqual(
    calls.map((r) => r.endpoint),
    ['crons/status', 'crons/status', 'dashboard/record'],
  );
  await loggedOperation(context, 'extra', async () => true);
  assert.equal(calls.length, 5);
  for (const { body } of calls) {
    assert.equal(body.trigger_id, id);
    assert.equal(body.execution_id, undefined);
  }
  calls.length = 0;
  context.env.QL_CLI_LIFECYCLE = 'legacy';
  await loggedOperation(context, 'extra', async () => true);
  assert.ok(calls.length);
  assert.ok(calls.every((r) => !('trigger_id' in r.body)));
});

test('distinct managed triggers in the same clock tick have separate maintenance and task logs', async (t) => {
  const { executeTask } = require('../../dist/internal/execution/taskRunner');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-same-tick-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.mock.method(Date, 'now', () => 1800000000000);
  const run = async (id) => {
    const context = createContext(
      { root },
      {
        QL_CLI_LIFECYCLE: 'extended',
        QL_TRIGGER_ID: id,
        PATH: process.env.PATH,
        no_tee: 'true',
        log_name: 'shared',
      },
    );
    await fs.mkdir(context.paths.dir_scripts, { recursive: true });
    await fs.writeFile(
      path.join(context.paths.dir_scripts, id + '.sh'),
      'echo ' + id,
    );
    const command = await loggedOperation(context, 'extra', async () => {});
    const task = await executeTask(context, {
      argv: [id + '.sh'],
      mode: 'now',
    });
    return {
      command: command.logPath,
      file: task.logPath,
      content: await fs.readFile(
        path.join(context.paths.dir_log, task.logPath),
        'utf8',
      ),
    };
  };
  const [a, b] = await Promise.all([run('marker-alpha'), run('marker-bravo')]);
  assert.notEqual(a.command, b.command);
  assert.notEqual(a.file, b.file);
  assert.match(a.content, /marker-alpha/);
  assert.doesNotMatch(a.content, /marker-bravo/);
  assert.match(b.content, /marker-bravo/);
  assert.doesNotMatch(b.content, /marker-alpha/);
});

test('same-tick standalone tasks and commands share a receipt only within one invocation', async (t) => {
  const { LocalApi } = require('../../dist/internal/runtime/api');
  const { executeTask } = require('../../dist/internal/execution/taskRunner');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-client-receipts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.mock.method(Date, 'now', () => 1800000000000);
  const context = createContext(
    { root },
    {
      ID: '5',
      QL_CLI_LIFECYCLE: 'extended',
      no_tee: 'true',
      real_log_path: 'shared.log',
      PATH: process.env.PATH,
    },
  );
  await fs.mkdir(context.paths.dir_scripts, { recursive: true });
  await fs.writeFile(
    path.join(context.paths.dir_scripts, 'receipt.sh'),
    'exit 0',
  );
  const groups = new Map();
  t.mock.method(LocalApi.prototype, 'call', async (endpoint, method, body) => {
    const id = body.execution_id;
    assert.match(id, /^client-[0-9a-f-]{36}$/);
    groups.set(id, [...(groups.get(id) || []), body.status ?? 'stat']);
    return { code: 200 };
  });
  await Promise.all([
    executeTask(context, { argv: ['receipt.sh'], mode: 'now' }),
    executeTask(context, { argv: ['receipt.sh'], mode: 'now' }),
    loggedOperation(context, 'extra', async () => {}),
  ]);
  assert.deepEqual(
    [...groups.values()].map((sequence) => sequence.join(',')).sort(),
    ['0,1', '0,1,stat', '0,1,stat'],
  );
});
