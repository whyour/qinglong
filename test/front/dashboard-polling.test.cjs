const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

function dashboard() {
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
    config: { apiPrefix: '/api/' }, REFRESH_INTERVAL: 30000,
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
