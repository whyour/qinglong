const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.createSourceFile(
  'index.tsx',
  fs.readFileSync(
    path.join(__dirname, '../../src/pages/dependence/index.tsx'),
    'utf8',
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const names = new Set([
  'scheduleRefresh',
  'finishRefresh',
  'attachRefresh',
  'recoverRefresh',
  'pollRefresh',
  'startRefresh',
]);
const declarations = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(source))) {
    declarations.push(`var ${node.getText(source)};`);
  }
  ts.forEachChild(node, visit);
}
visit(source);

function fixture() {
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const state = { refreshing: false, type: null, reloads: 0 };
  const request = (url) => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    requests.push({ url, resolve, reject });
    return promise;
  };
  const context = {
    config: { apiPrefix: '/api/' },
    type: 'python3',
    alive: { current: true },
    activeRefreshId: { current: null },
    refreshRequestVersion: { current: 0 },
    refreshTimer: {},
    request: { get: request, post: request },
    setRefreshing: (value) => {
      state.refreshing = value;
    },
    setRefreshingType: (value) => {
      state.type = value;
    },
    setRefreshGeneration: () => {
      state.reloads += 1;
    },
    message: { error() {}, warning() {} },
    intl: { get: (value) => value },
    setTimeout: (fn, delay) => {
      timers.set(++timerId, { fn, delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.createContext(context);
  vm.runInContext(
    ts.transpile(declarations.join('\n'), { target: ts.ScriptTarget.ES2020 }),
    context,
  );
  return { context, requests, timers, state };
}

const settle = () => new Promise(setImmediate);
const newJob = { id: 'new-job', type: 'python3' };

test('late recovery cannot replace a newly attached job or clear it as idle', async () => {
  for (const data of [{ id: 'old-job', type: 'nodejs' }, null]) {
    const f = fixture();
    f.context.recoverRefresh(true, true);
    f.context.attachRefresh(newJob);
    f.requests[0].resolve({ code: 200, data });
    await settle();
    assert.equal(f.context.activeRefreshId.current, newJob.id);
    assert.equal(f.state.refreshing, true);
    assert.equal(f.state.reloads, 0);
    assert.equal([...f.timers.values()][0].delay, 0);
  }
});

test('late recovery failure cannot replace the new job poll timer', async () => {
  const f = fixture();
  f.context.recoverRefresh(false, true);
  f.context.attachRefresh(newJob);
  f.requests[0].reject(new Error('offline'));
  await settle();
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 0);
});

test('a queued recovery retry is invalidated when a new job starts', async () => {
  const f = fixture();
  f.context.recoverRefresh(false, true);
  f.requests[0].reject(new Error('offline'));
  await settle();
  const retry = [...f.timers.values()][0].fn;
  f.context.startRefresh();
  retry();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve({ code: 200, data: newJob });
  await settle();
  assert.equal(f.context.activeRefreshId.current, newJob.id);
});

test('starting a job invalidates recovery before the start response arrives', async () => {
  const f = fixture();
  f.context.recoverRefresh(false, true);
  f.context.startRefresh();
  f.requests[0].resolve({ code: 200, data: { id: 'old-job', type: 'nodejs' } });
  await settle();
  assert.equal(f.context.activeRefreshId.current, null);
  f.requests[1].resolve({ code: 200, data: newJob });
  await settle();
  assert.equal(f.context.activeRefreshId.current, newJob.id);
});

test('current recovery still attaches and polls the running job', async () => {
  const f = fixture();
  f.context.recoverRefresh();
  f.requests[0].resolve({ code: 200, data: newJob });
  await settle();
  [...f.timers.values()][0].fn();
  assert.equal(f.requests[1].url, '/api/dependencies/refresh/new-job');
  f.requests[1].resolve({ code: 200, data: { ...newJob, state: 'completed' } });
  await settle();
  assert.equal(f.state.refreshing, false);
  assert.equal(f.state.reloads, 1);
});
