const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t, language) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-lazy-notify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extension = language === 'python' ? 'py' : 'js';
  fs.copyFileSync(`shell/preload/sitecustomize.${extension}`, path.join(root, `sitecustomize.${extension}`));
  fs.writeFileSync(path.join(root, `env.${extension}`), '');
  fs.writeFileSync(path.join(root, 'before.sh'), 'export FROM_SHELL=before\n');
  fs.writeFileSync(path.join(root, 'before.js'), 'process.env.FROM_LANGUAGE = "javascript";\n');
  fs.writeFileSync(path.join(root, 'task_before.py'), 'import os\nos.environ["FROM_LANGUAGE"] = "python"\n');
  fs.writeFileSync(path.join(root, 'client.js'), 'module.exports = { getEnvs: () => "client-ready" };\n');
  fs.copyFileSync('shell/preload/client.py', path.join(root, 'client.py'));
  fs.copyFileSync('shell/preload/esm-loader.mjs', path.join(root, 'esm-loader.mjs'));
  const env = {
    ...process.env,
    PYTHONPATH: root,
    PREV_PYTHONPATH: '',
    NODE_OPTIONS: '',
    PREV_NODE_OPTIONS: '',
    QL_NODE_GLOBAL_PATH: '',
    file_task_before: path.join(root, 'before.sh'),
    file_task_before_js: path.join(root, 'before.js'),
    dir_scripts: root,
    task_before: 'export FROM_COMMAND=command',
    envParam: 'ACCOUNTS',
    numParam: '2-3',
    ACCOUNTS: 'first&second&third',
  };
  const write = (name, text) => fs.writeFileSync(path.join(root, name), text);
  const run = (body, extensionOverride = extension) => {
    const entry = path.join(root, `entry.${extensionOverride}`);
    write(path.basename(entry), body);
    const python = language === 'python';
    const result = spawnSync(python ? 'python3' : process.execPath,
      python ? [entry] : ['--require', path.join(root, 'sitecustomize.js'), entry],
      { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  return { root, env, write, run };
}

for (const extension of ['js', 'mjs']) {
  test(`${extension} startup preserves hooks, environment selection and client without importing notifications`, (t) => {
    const f = fixture(t, 'javascript');
    f.write('__ql_notify__.js', 'throw Error("notification dependencies must not load at startup");');
    f.run(`
      const assert = ${extension === 'mjs' ? '(await import("node:assert/strict")).default' : 'require("node:assert/strict")'};
      assert.equal(process.env.FROM_SHELL, 'before');
      assert.equal(process.env.FROM_LANGUAGE, 'javascript');
      assert.equal(process.env.FROM_COMMAND, 'command');
      assert.equal(process.env.ACCOUNTS, 'second&third');
      assert.equal(QLAPI.getEnvs(), 'client-ready');
      assert.equal(typeof QLAPI.notify, 'function');
    `, extension);
  });
}

test('JavaScript first notification imports once and preserves arguments, this, promises and errors', (t) => {
  const f = fixture(t, 'javascript');
  f.write('__ql_notify__.js', `
    global.notificationLoads = (global.notificationLoads || 0) + 1;
    exports.sendNotify = function (...args) {
      if (args[0] === 'fail') throw new Error('send failed');
      global.notificationResult = Promise.resolve({ args, receiver: this });
      return global.notificationResult;
    };
  `);
  f.run(`
    const assert = require('node:assert/strict');
    assert.equal(global.notificationLoads, undefined);
    (async () => {
      const options = { channel: 'fixture' };
      const promise = QLAPI.notify('title', 'content', options);
      assert.equal(promise, global.notificationResult);
      const result = await promise;
      assert.deepEqual(result.args, ['title', 'content', options]);
      assert.equal(result.receiver, QLAPI);
      await QLAPI.notify('second');
      assert.equal(global.notificationLoads, 1);
      assert.throws(() => QLAPI.notify('fail'), /send failed/);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
});

test('JavaScript reports import failures on notify and permits a later retry', (t) => {
  const f = fixture(t, 'javascript');
  f.write('__ql_notify__.js', `
    if (!process.env.NOTIFY_READY) throw Error('notification dependency unavailable');
    exports.sendNotify = (...args) => args;
  `);
  f.run(`
    const assert = require('node:assert/strict');
    assert.equal(QLAPI.getEnvs(), 'client-ready');
    assert.throws(() => QLAPI.notify('first'), /notification dependency unavailable/);
    process.env.NOTIFY_READY = '1';
    assert.deepEqual(QLAPI.notify('retry'), ['retry']);
  `);
});

test('Python startup preserves hooks, environment selection and client without importing notifications', (t) => {
  const f = fixture(t, 'python');
  f.write('__ql_notify__.py', 'raise RuntimeError("notification dependencies must not load at startup")\n');
  f.run(`
import os, sys
assert os.environ['FROM_SHELL'] == 'before'
assert os.environ['FROM_LANGUAGE'] == 'python'
assert os.environ['FROM_COMMAND'] == 'command'
assert os.environ['ACCOUNTS'] == 'second&third'
assert '__ql_notify__' not in sys.modules
assert callable(QLAPI.notify)
assert callable(QLAPI.getEnvs)
`);
});

test('Python first notification imports once and preserves args, kwargs, return values and errors', (t) => {
  const f = fixture(t, 'python');
  f.write('__ql_notify__.py', `
import builtins
builtins.notification_loads = getattr(builtins, 'notification_loads', 0) + 1
def send(*args, **kwargs):
    if args[0] == 'fail':
        raise ValueError('send failed')
    return args, kwargs
`);
  f.run(`
import builtins, sys
assert '__ql_notify__' not in sys.modules
assert QLAPI.notify('title', 'content', channel='fixture') == (('title', 'content'), {'channel': 'fixture'})
assert QLAPI.notify('second') == (('second',), {})
assert builtins.notification_loads == 1
try:
    QLAPI.notify('fail')
except ValueError as error:
    assert str(error) == 'send failed'
else:
    raise AssertionError('notification exception was swallowed')
`);
});

test('Python reports import failures on notify and permits a later retry', (t) => {
  const f = fixture(t, 'python');
  f.write('__ql_notify__.py', `
import os
if not os.environ.get('NOTIFY_READY'):
    raise RuntimeError('notification dependency unavailable')
def send(*args, **kwargs):
    return args
`);
  f.run(`
import os, sys
assert '__ql_notify__' not in sys.modules
try:
    QLAPI.notify('first')
except RuntimeError as error:
    assert str(error) == 'notification dependency unavailable'
else:
    raise AssertionError('import exception was swallowed')
os.environ['NOTIFY_READY'] = '1'
assert QLAPI.notify('retry') == ('retry',)
`);
});
