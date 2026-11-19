const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

function dashboard(anomaly) {
  const source = fs.readFileSync(require.resolve('../../src/pages/dashboard/index.tsx'), 'utf8');
  const ast = ts.createSourceFile('dashboard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' &&
      node.arguments[0].getText(ast).includes('setOverview')) effect = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(effect);
  const requests = [], results = [], failures = [], timers = new Set();
  const noop = () => {};
  const bindings = {
    performance: { now: () => 1000 },
    anomaly, config: { apiPrefix: '/api/' }, REFRESH_INTERVAL: 30000,
    setOverview: value => results.push(value), setOverviewFailed: value => failures.push(value),
    setLoading: noop, setTrend: noop, setSystem: noop, setTopTime: noop, setTopCount: noop, setLabels: noop, setRuntime: noop,
    setInterval(fn) { timers.add(fn); return fn; }, clearInterval(fn) { timers.delete(fn); },
    request: { get(url, options) {
      return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
    } },
  };
  const js = ts.transpile('const start = ' + effect, { target: ts.ScriptTarget.ES2022 });
  return {
    start: Function(...Object.keys(bindings), js + '\nreturn start;')(...Object.values(bindings)),
    tick() { for (const fn of timers) fn(); }, timers, results, failures,
    requests: section => requests.filter(r => r.url === '/api/dashboard/' + section),
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a first anomaly request that never succeeds still expires using the overview deadline', async () => {
  const v = anomalies(), selection = { source: 'panel', kind: 'missing', at: 100, deadline: 10000 };
  const close = v.start(selection, { page: 1 });
  v.tick(10000);
  assert.deepEqual(v.invalidated, [{ selection, reason: 'expired' }]);
  assert.equal(v.requests[0].signal.aborted, true);
  v.requests[0].resolve({ code: 200, data: { rows: ['yesterday'], summary: {} } });
  await flush();
  assert.deepEqual(v.received, []);
  close();
});

test('a first failure and manual retry cannot reset the overview deadline', async () => {
  const v = anomalies(), selection = { source: 'system', kind: 'unconfirmed', at: 100, deadline: 10000 };
  const close = v.start(selection, { page: 1 });
  v.requests[0].reject(new Error('offline'));
  await flush();
  v.advance(7000);
  close();
  const cancel = v.start(selection, { page: 1 });
  v.tick(3000);
  assert.equal(v.requests[1].signal.aborted, true);
  assert.deepEqual(v.invalidated, [{ selection, reason: 'expired' }]);
  cancel();
});

test('opening an already expired overview does not send an obsolete detail request', () => {
  const v = anomalies(), selection = { source: 'panel', kind: 'missing', at: 100, deadline: 1000 };
  v.advance(1001);
  const close = v.start(selection, { page: 1 });
  assert.equal(v.requests.length, 0);
  assert.deepEqual(v.invalidated, [{ selection, reason: 'expired' }]);
  close();
});

test('overview deadlines use server time and request start, independent of the browser wall clock', async () => {
  const v = dashboard(), close = v.start();
  const serverNow = 1795017590000;
  v.requests('overview')[0].resolve({ code: 200, data: { serverNow, expiresAt: serverNow + 10000 } });
  await flush();
  assert.equal(v.results[0].anomalyDeadline, 11000);
  close();
});

test('slow dashboard cards do not block crond counts, overlap a pending refresh or restart polling after unmount', async () => {
  const view = dashboard(), leave = view.start();
  view.tick();
  assert.equal(view.requests('overview').length, 1);
  view.requests('overview')[0].resolve({ code: 200, data: { actualSkips: 0 } });
  await flush();
  view.tick();
  assert.equal(view.requests('trend').length, 1);
  const pending = view.requests('overview')[1];
  assert.equal(pending.options.retryInPlace, true);
  pending.reject(new Error('502 during restart'));
  await flush();
  assert.deepEqual(view.results, [{ actualSkips: 0 }]);
  assert.deepEqual(view.failures, [false, true]);
  view.tick();
  view.requests('overview')[2].resolve({ code: 200, data: { actualSkips: 1 } });
  await flush();
  assert.deepEqual(view.failures, [false, true, false]);
  view.tick();
  const stale = view.requests('overview')[3];
  leave();
  assert.equal(stale.options.signal.aborted, true);
  assert.equal(view.timers.size, 0);
  const closeAgain = view.start();
  view.requests('overview')[4].resolve({ code: 200, data: { actualSkips: 2 } });
  await flush();
  stale.resolve({ code: 200, data: { actualSkips: 0 } });
  await flush();
  assert.deepEqual(view.results, [{ actualSkips: 0 }, { actualSkips: 1 }, { actualSkips: 2 }]);
  assert.deepEqual(view.failures, [false, true, false, false]);
  assert.equal(view.timers.size, 1);
  closeAgain();
});

test('system crond results distinguish missing records, unknown exits and recorded skips', async () => {
  const intl = require('react-intl-universal');
  const messages = require('../../src/locales/zh-CN.json');
  await intl.init({ currentLocale: 'zh-CN', locales: { 'zh-CN': messages } });
  const source = fs.readFileSync(require.resolve('../../src/pages/dashboard/index.tsx'), 'utf8');
  const ast = ts.createSourceFile('dashboard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let renderer;
  function visit(node) {
    if (ts.isObjectLiteralExpression(node) && node.properties.some(p =>
      ts.isPropertyAssignment(p) && p.name.getText(ast) === 'title' &&
      p.initializer.getText(ast) === "intl.get('执行情况')")) {
      renderer = node.properties.find(p => p.name.getText(ast) === 'render').initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(renderer);
  const js = ts.transpileModule('const render = ' + renderer.getText(ast), {
    fileName: 'cell.tsx', compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const cell = Function('React', 'intl', js + '\nreturn render;')(require('react'), intl);
  const html = row => require('react-dom/server').renderToStaticMarkup(cell(null, row));
  assert.equal(html({ status: 'missing', triggerCount: 0 }), '未收到触发记录');
  assert.equal(html({ status: 'skipped', triggerCount: 1, skipCount: 1 }), '已跳过');
  assert.equal(html({ status: 'started' }), '命令已启动');
  assert.equal(html({ status: 'started', triggerCount: 1, startCount: 1, unknownExitCount: 1 }),
    '命令已启动 · 结果未知');
  assert.equal(html({ status: 'started', triggerCount: 2, startCount: 1, skipCount: 1, unknownExitCount: 1 }),
    '启动 1 次 · 跳过 1 次 · 其中 1 次执行结果未知');
});

test('dashboard timing preserves millisecond precision, rounds long waits and distinguishes zero from no samples', async () => {
  const intl = require('react-intl-universal');
  const locales = { 'zh-CN': require('../../src/locales/zh-CN.json'), 'en-US': require('../../src/locales/en-US.json') };
  const source = fs.readFileSync(require.resolve('../../src/pages/dashboard/timingStatistic.tsx'), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } });
  const component = {};
  Function('require', 'exports', outputText)(require, component);
  await intl.init({ currentLocale: 'zh-CN', locales });
  assert.deepEqual([null, 0, 136, 1000, 5989, 59999, 60000, 119999, 1703994].map(component.formatTiming),
    ['—', '0 ms', '136 ms', '1 秒', '5.989 秒', '59.999 秒', '1 分 0 秒', '2 分 0 秒', '28 分 24 秒']);
  const render = ms => require('react-dom/server').renderToStaticMarkup(
    require('react').createElement(component.default, { title: 'P95', ms }));
  assert.match(render(1703994), /title="1703994 ms">28 分 24 秒/);
  assert.match(render(null), /—/);
  assert.doesNotMatch(render(136), /个样本/);
  await intl.init({ currentLocale: 'en-US', locales });
  assert.equal(component.formatTiming(1703994), '28 min 24 s');
});

function anomalies() {
  const filename = require.resolve('../../src/pages/dashboard/scheduleAnomalies.tsx');
  const source = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect')
      effect = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const js = ts.transpile('const start = ' + effect, { target: ts.ScriptTarget.ES2022 });
  const requests = [], received = [], failed = [], summaries = [], invalidated = [], timers = new Map();
  let now = 0;
  const bindings = {
    expiresAt: { current: undefined },
    config: { apiPrefix: '/api/' },
    request: { get(url, options) {
      assert.equal(url, '/api/dashboard/schedule-anomalies');
      return new Promise((resolve, reject) => requests.push({ ...options, resolve, reject }));
    } },
    setResponse: data => received.push(data.result), setFailed: flag => failed.push(flag), setLoading() {},
    onUpdate: (selection, summary) => summaries.push(summary),
    onInvalidate: (selection, reason) => invalidated.push({ selection, reason }),
    performance: { now: () => now },
    setTimeout(fn, ms) { timers.set(fn, ms); return fn; }, clearTimeout(fn) { timers.delete(fn); },
  };
  return {
    start: (selection, query) => Function(...Object.keys(bindings), 'selection', 'query',
      js + '\nreturn start();')(...Object.values(bindings), selection, query),
    requests, received, failed, summaries, invalidated, timers,
    advance(ms) { now += ms; },
    tick(delay = 5000) { for (const [fn, ms] of [...timers]) if (ms === delay) { timers.delete(fn); fn(); } },
  };
}

test('anomaly pagination pins its plan window, advances revisions after resets and stops old polling across source changes', async () => {
  const v = anomalies(), selection = { source: 'panel', kind: 'missing', at: 100 };
  const close = v.start(selection, { page: 2, revision: 'old' });
  assert.deepEqual(v.requests[0].params, { ...selection, live: true, page: 2, revision: 'old' });
  const updated = { rows: ['remaining'], page: 1, revision: 'new', total: 26, changed: true, summary: { audit: { missing: 26 } } };
  v.requests[0].resolve({ code: 200, data: updated });
  await flush();
  assert.deepEqual(v.received, [updated]);
  assert.deepEqual(v.summaries, [updated.summary]);
  v.tick(); v.tick();
  assert.equal(v.requests.length, 2);
  assert.deepEqual(v.requests[1].params, { ...selection, live: true, page: 1, revision: 'new' });
  close();
  assert.equal(v.requests[1].signal.aborted, true);
  const leave = v.start({ source: 'system', kind: 'unconfirmed', at: 200 }, { page: 1 });
  v.requests[1].resolve({ code: 200, data: { ...updated, total: 99 } });
  v.requests[2].reject(new Error('timeout'));
  await flush();
  assert.equal(v.failed.at(-1), true);
  assert.equal(v.received.length, 1);
  assert.equal(v.timers.size, 0);
  leave();
  const finish = v.start({ source: 'system', kind: 'unconfirmed', at: 200 }, { page: 1 });
  const empty = { rows: [], page: 1, revision: 'empty', total: 0, summary: { systemAudit: { actualUnconfirmed: 0 } } };
  v.requests[3].resolve({ code: 200, data: empty });
  await flush();
  assert.equal(v.failed.at(-1), false);
  assert.deepEqual(v.summaries, [updated.summary, empty.summary]);
  finish();
  v.tick();
  assert.equal(v.requests.length, 4);
});

test('opening anomaly details cancels older overview responses and keeps its counts owned by the detail snapshot', async () => {
  const v = dashboard(), close = v.start();
  close();
  v.requests('overview')[0].resolve({ code: 200, data: { triggers: { audit: { missing: 55 } } } });
  await flush();
  assert.deepEqual(v.results, []);
  const opened = dashboard({ source: 'panel' }), leave = opened.start();
  opened.tick();
  assert.equal(opened.requests('overview').length, 0);
  assert.equal(opened.requests('runtime').length, 1);
  leave();
});

for (const source of ['panel', 'system']) test(source + ' partial cleanup resets pagination and abandoned page replies cannot restore deleted rows after switching source', async () => {
  const v = anomalies(), selection = { source, kind: 'unconfirmed', at: 100, session: 1 };
  const stop = v.start(selection, { page: 3, revision: 'before-cleanup' });
  const retained = { page: 1, total: 40, revision: 'after-cleanup', changed: true,
    rows: [{ trigger: 'retained', hasLog: true }], summary: source === 'panel'
      ? { audit: { unconfirmed: 40 } } : { systemAudit: { actualUnconfirmed: 40 } } };
  v.requests[0].resolve({ code: 200, data: retained });
  await flush();
  v.tick();
  assert.equal(v.requests[1].params.page, 1);
  assert.equal(v.requests[1].params.revision, 'after-cleanup');
  stop();
  const next = { ...selection, source: source === 'panel' ? 'system' : 'panel', session: 2 };
  const close = v.start(next, { page: 1 });
  const fresh = { ...retained, rows: [{ trigger: 'other-source', hasLog: true }], total: 1, revision: 'fresh',
    summary: next.source === 'panel' ? { audit: { unconfirmed: 1 } } : { systemAudit: { actualUnconfirmed: 1 } } };
  v.requests[2].resolve({ code: 200, data: fresh });
  await flush();
  v.requests[1].resolve({ code: 200, data: { ...retained, total: 60, rows: [{ trigger: 'deleted' }] } });
  await flush();
  assert.deepEqual(v.received, [retained, fresh]);
  assert.deepEqual(v.summaries, [retained.summary, fresh.summary]);
  close();
  assert.equal(v.timers.size, 0);
});

test('midnight cancels a hung anomaly refresh and a late reply cannot publish yesterday counts', async () => {
  const v = anomalies(), selection = { source: 'panel', kind: 'missing', at: 100, session: 1 };
  const leave = v.start(selection, { page: 1 });
  const data = { page: 1, revision: 'before-midnight', rows: ['old'], summary: { audit: { missing: 1 } }, serverNow: 1000, expiresAt: 11000 };
  v.requests[0].resolve({ code: 200, data });
  await flush();
  v.tick();
  assert.equal(v.requests.length, 2);
  v.tick(10000);
  assert.equal(v.requests[1].signal.aborted, true);
  assert.deepEqual(v.invalidated, [{ selection, reason: 'expired' }]);
  v.requests[1].resolve({ code: 200, data });
  await flush();
  assert.deepEqual(v.summaries, [data.summary]);
  assert.equal(v.timers.size, 0);
  leave();
});

test('pagination and retry preserve the midnight deadline while their requests remain hung', async () => {
  const v = anomalies(), selection = { source: 'panel', kind: 'missing', at: 100, session: 1 };
  const leave = v.start(selection, { page: 1 });
  const data = { page: 1, revision: 'old', rows: ['old'], summary: { audit: { missing: 30 } }, serverNow: 1000, expiresAt: 11000 };
  v.requests[0].resolve({ code: 200, data });
  await flush();
  v.advance(3000);
  leave();
  const cancelPage = v.start(selection, { page: 2, revision: 'old' });
  assert.ok([...v.timers.values()].includes(7000));
  v.requests[1].reject(new Error('timeout'));
  await flush();
  v.advance(2000);
  cancelPage();
  const cancelRetry = v.start(selection, { page: 2, revision: 'old' });
  v.tick(5000);
  assert.equal(v.requests[2].signal.aborted, true);
  assert.deepEqual(v.invalidated, [{ selection, reason: 'expired' }]);
  v.requests[2].resolve({ code: 200, data });
  await flush();
  assert.deepEqual(v.received, [data]);
  assert.equal(v.timers.size, 0);
  cancelRetry();
});

for (const status of ['expired', 'unavailable']) test('anomaly ' + status + ' closes the old session without republishing old rows or retrying', async () => {
  const v = anomalies(), selection = { source: 'system', kind: 'unconfirmed', at: 100, session: 1 };
  const leave = v.start(selection, { page: 2, revision: 'old' });
  v.requests[0].resolve({ code: 200, data: { status } });
  await flush();
  assert.deepEqual(v.invalidated, [{ selection, reason: status }]);
  assert.deepEqual(v.received, []);
  assert.deepEqual(v.summaries, []);
  assert.equal(v.timers.size, 0);
  leave();
  const next = { ...selection, session: 2 }, close = v.start(next, { page: 1 });
  const data = { page: 1, revision: 'new', rows: [], total: 0, summary: { systemAudit: { actualUnconfirmed: 0 } } };
  v.requests[1].resolve({ code: 200, data });
  await flush();
  assert.deepEqual(v.received, [data]);
  close();
});

test('an expired response that arrived across midnight cannot be rendered for even one poll', async () => {
  const v = anomalies(), selection = { source: 'panel', kind: 'missing', at: 100 };
  const close = v.start(selection, { page: 1 });
  v.requests[0].resolve({ code: 200, data: { serverNow: 1000, expiresAt: 999, summary: { audit: { missing: 7 } }, rows: ['old'] } });
  await flush();
  assert.equal(v.invalidated[0].reason, 'expired');
  assert.deepEqual(v.received, []);
  assert.deepEqual(v.summaries, []);
  close();
});

test('a queued summary update is fenced even when closing and reopening happens before effect cleanup', () => {
  const file = require.resolve('../../src/pages/dashboard/index.tsx');
  const source = fs.readFileSync(file, 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'updateAnomalySummary')
      callback = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback);
  const old = { session: 1 }, next = { session: 2 }, anomalySession = { current: old }, queued = [];
  const js = ts.transpile('const update = ' + callback, { target: ts.ScriptTarget.ES2022 });
  const update = Function('anomalySession', 'setOverview', js + '\nreturn update;')(anomalySession, updater => queued.push(updater));
  update(old, { audit: { missing: 8 } });
  anomalySession.current = next;
  update(old, { audit: { missing: 9 } });
  assert.equal(queued.length, 1);
  const fresh = { triggers: { audit: { missing: 0 } } };
  assert.strictEqual(queued[0](fresh), fresh);
});

test('an old invalidation cannot close a reopened session or clear its freshly queued summary', () => {
  const file = require.resolve('../../src/pages/dashboard/index.tsx');
  const source = fs.readFileSync(file, 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'invalidateAnomaly')
      callback = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback);
  const old = { session: 1 }, current = { session: 2 };
  const anomalySession = { current }, anomalyVersion = { current: 2 };
  const summaries = [], logs = [], messages = [];
  let closes = 0;
  const bindings = { anomalySession, anomalyVersion,
    closeAnomaly() { closes++; anomalySession.current = undefined; },
    setOverview: update => summaries.push(update), setLogCron: update => logs.push(update),
    message: { info: text => messages.push(text) }, intl: { get: text => text },
  };
  const js = ts.transpile('const invalidate = ' + callback, { target: ts.ScriptTarget.ES2022 });
  const invalidate = Function(...Object.keys(bindings), js + '\nreturn invalidate;')(...Object.values(bindings));
  invalidate(old, 'unavailable');
  assert.equal(closes, 0);
  assert.equal(summaries.length, 0);
  invalidate(current, 'expired');
  assert.equal(closes, 1);
  assert.equal(logs[0]({ anomalySession: 2 }), null);
  const next = { session: 3 };
  anomalySession.current = next;
  anomalyVersion.current = 3;
  const fresh = { triggers: { audit: { missing: 0 } } }, freshLog = { anomalySession: 3 };
  assert.strictEqual(summaries[0](fresh), fresh);
  assert.strictEqual(logs[0](freshLog), freshLog);
  assert.equal(messages.length, 1);
});
