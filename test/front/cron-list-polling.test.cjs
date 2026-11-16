const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Exercise the real list effect while explicitly releasing each HTTP response.
function listEffect() {
  const source = fs.readFileSync(path.join(__dirname, '../../src/pages/crontab/index.tsx'), 'utf8');
  const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effects = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' &&
      node.arguments[1]?.getText(ast).includes('searchText')) effects.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(effects.length, 1);
  const js = ts.transpile('const effect = ' + effects[0].getText(ast), {target: ts.ScriptTarget.ES2022});
  const requests = [], timers = new Set(), rows = [], totals = [], failures = [];
  const bindings = {
    pageConf: { page: 1, size: 20 }, viewConf: null, config: {apiPrefix: '/api/'},
    request: { get(url, options) {
      return new Promise((resolve, reject) => requests.push({url, options, resolve, reject}));
    } }, setValue: value => rows.push(value), setTotal: value => totals.push(value),
    setLoading() {}, setListFailed(failed) { failures.push(failed); },
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); },
  };
  return { requests, timers, rows, totals, failures, start(searchText) {
    return Function('searchText', ...Object.keys(bindings), js + '\nreturn effect();')(searchText, ...Object.values(bindings));
  } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const page = (id, sub_id) => ({code: 200, data: {data: [{id, sub_id}], total: 1}});

test('switching searches discards stale list and subscription responses and cancels old polling', async () => {
  for (const delaySubscription of [false, true]) {
    const view = listEffect();
    const closeA = view.start('A');
    if (delaySubscription) { view.requests[0].resolve(page(1, 7)); await flush(); }
    const stale = view.requests.at(-1);
    closeA();
    assert.ok(stale.options.signal.aborted);
    const closeB = view.start('B&+');
    const fresh = view.requests.at(-1);
    assert.equal(fresh.options.params.searchValue, 'B&+');
    fresh.resolve(page(2));
    await flush();
    stale.resolve(delaySubscription ? {code: 200, data: [{id: 7}]} : page(1, 7));
    await flush();
    assert.deepEqual(view.rows.map(rows => rows.map(r => r.id)), [[2]]);
    assert.deepEqual(view.totals, [1]);
    assert.equal(view.requests.length, delaySubscription ? 3 : 2);
    assert.equal(view.timers.size, 1);
    closeB();
    assert.equal(view.timers.size, 0);
  }
});

test('list polling recovers on the next tick after a network failure', async () => {
  const view = listEffect();
  const stop = view.start('same query');
  view.requests[0].reject(Error('interrupted'));
  await flush();
  assert.deepEqual(view.failures, [true]);
  const [tick] = view.timers;
  view.timers.delete(tick);
  const poll = tick();
  view.requests[1].resolve(page(3));
  await poll;
  assert.deepEqual(view.failures, [true, false]);
  assert.equal(view.rows[0][0].id, 3);
  assert.equal(view.timers.size, 1);
  stop();
});

test('the next search can be submitted while the table request is in flight', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/pages/crontab/index.tsx'), 'utf8');
  const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const controls = [];
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'Search') controls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(controls.length, 1);
  const attributes = controls[0].attributes.properties.map(p => p.name?.getText(ast));
  assert.ok(attributes.includes('onSearch'));
  assert.ok(!attributes.includes('loading') && !attributes.includes('disabled'));
});

test('a failed subscription lookup still displays the current task list', async () => {
  const view = listEffect();
  const stop = view.start('updated');
  view.requests[0].resolve(page(42, 1));
  await flush();
  view.requests[1].reject(Error('offline'));
  await flush();
  assert.deepEqual(view.rows[0].map(row => row.id), [42]);
  assert.deepEqual(view.totals, [1]);
  stop();
});
