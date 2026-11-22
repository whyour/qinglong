const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { createTriggerPoll } = require('../../src/pages/crontab/triggerUpdates');

// Run one tick to settlement for the filtering and single-round tests.
async function refreshExpandedHistory(
  rows,
  head,
  read,
  active,
  onHead,
  onBatch,
  open = new Set(),
) {
  let failed = false;
  createTriggerPoll(
    head,
    read,
    active,
    onHead,
    onBatch,
    (value) => {
      failed = value;
    },
    open,
  )(rows);
  await new Promise((resolve) => setImmediate(resolve));
  return !failed;
}

const entry = (id, state = 'finished', reason) => ({
  id: String(id),
  observed_at: 100,
  state,
  reason,
});

test('expanded terminal history checks for new triggers without fetching stable rows', async () => {
  for (const [latest, expected] of [
    [[], false],
    [[entry('a')], false],
    [[entry('b')], true],
    [[{ ...entry('0'), observed_at: 101 }], true],
  ]) {
    let notice;
    const ok = await refreshExpandedHistory(
      [entry('a')],
      entry('a'),
      async (params) => {
        assert.equal(params.toString(), 'limit=1');
        return latest;
      },
      () => true,
      (newer) => {
        notice = newer;
      },
      assert.fail,
    );
    assert.equal(ok, true);
    assert.equal(notice, expected);
  }
});

test('refreshes recovered receipts and applies successful batches even if another request fails', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => entry(i, 'running'));
  rows.push(
    entry('replay', 'skipped', 'restart'),
    entry('late', 'unknown', 'restart'),
    entry('wait', 'queued'),
    entry('done'),
    entry('skipped', 'skipped', 'changed'),
  );
  for (const failing of [true, false]) {
    const applied = [];
    const ok = await refreshExpandedHistory(
      rows,
      rows[0],
      async (params) => {
        const ids = params.getAll('ids');
        if (failing && (!ids.length || ids.includes('0')))
          throw new Error('temporary');
        return ids.filter((id) => id !== 'late').map((id) => entry(id));
      },
      () => true,
      () => {},
      (ids, updated) => applied.push([ids, updated.map((row) => row.id)]),
    );
    assert.equal(ok, !failing);
    assert.equal(applied.length, failing ? 1 : 2);
    assert.deepEqual(applied.at(-1), [
      ['replay', 'late', 'wait'],
      ['replay', 'wait'],
    ]);
  }
});

test('an in-flight response after leaving expanded history cannot update the page', async () => {
  let active = true;
  let calls = 0;
  await refreshExpandedHistory(
    [entry('r', 'running')],
    entry('a'),
    async (params) => {
      calls++;
      if (params.has('ids')) active = false;
      return [entry('b')];
    },
    () => active,
    () => {},
    assert.fail,
  );
  assert.equal(calls, 2);
});

// Run the component's actual action and refresh handlers against controlled requests.
const source = fs.readFileSync(
  path.join(__dirname, '../../src/pages/crontab/detail.tsx'),
  'utf8',
);
const ast = ts.createSourceFile(
  'detail.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function handler(name, bindings) {
  let body;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name)
      body = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const js = ts.transpileModule('const implementation = ' + body, {
    fileName: 'handler.tsx',
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return Function(
    ...Object.keys(bindings),
    js + '\nreturn implementation;',
  )(...Object.values(bindings));
}

test('fresh task status survives an older detail poll without reading all instances', async () => {
  let task;
  const pending = [];
  const refresh = handler('refreshDetails', {
    cron: { id: 7 },
    config: { apiPrefix: '/api/' },
    refreshVersion: { current: 0 },
    session: { current: new AbortController() },
    setRefreshFailed() {},
    request: {
      get(url) {
        return new Promise((resolve) => pending.push({ url, resolve }));
      },
    },
    setCurrentCron: (value) => {
      task = value;
    },
  });
  const old = refresh();
  const fresh = refresh();
  assert.deepEqual(
    pending.map((q) => q.url),
    ['/api/crons/7', '/api/crons/7'],
  );
  pending[1].resolve({ code: 200, data: { status: 3 } });
  await fresh;
  pending[0].resolve({ code: 200, data: { status: 0 } });
  await old;
  assert.deepEqual(task, { status: 3 });
});

test('opening a historical log preserves the filename and lets the log reader issue the first request', () => {
  let selected,
    opened = false;
  const open = handler('viewInstanceLog', {
    cron: { id: 7 },
    config: { apiPrefix: '/api/' },
    URLSearchParams,
    setLogUrl(url) {
      selected = url;
    },
    setIsLogModalVisible(value) {
      opened = value;
    },
  });
  open({ log_path: 'a & b/x#+%&.log' });
  assert.equal(opened, true);
  const query = new URL(selected, 'http://localhost').searchParams;
  assert.equal(query.get('file'), 'x#+%&.log');
  assert.equal(query.get('path'), 'a & b');
  open({ id: 42, log_path: 'a & b/x#+%&.log' });
  assert.equal(selected, '/api/crons/7/log?instanceId=42');
  open({ id: 'selected', log_path: 'old.log' }, 'selected');
  assert.equal(selected, '/api/crons/7/log?triggerId=selected');
});

test('cancelled page load cannot append, replace the cursor or restart its timer after a task switch', async () => {
  const file = fs.readFileSync(
    path.join(__dirname, '../../src/pages/crontab/triggerList.tsx'),
    'utf8',
  );
  const tree = ts.createSourceFile(
    'triggerList.tsx',
    file,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const effects = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'useEffect' &&
      node.arguments[1]?.getText(tree).includes('before')
    )
      effects.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(effects.length, 1);
  const compiled = ts.transpile('const effect = ' + effects[0].getText(tree), {
    target: ts.ScriptTarget.ES2022,
  });
  let rows = [],
    cursor;
  const pending = [],
    timers = new Set();
  const bindings = {
    config: { apiPrefix: '/api/' },
    pageSize: 25,
    pageRequest: {},
    paused: false,
    request: {
      get(url, options) {
        return new Promise((resolve) =>
          pending.push({ url, options, resolve }),
        );
      },
    },
    setRows(fn) {
      rows = fn(rows);
    },
    setLoading() {},
    setFailed() {},
    setNextCursor(row) {
      cursor = row;
    },
    setTimeout(fn) {
      timers.add(fn);
      return fn;
    },
    clearTimeout(fn) {
      timers.delete(fn);
    },
  };
  const start = Function(
    'id',
    'before',
    ...Object.keys(bindings),
    compiled + '\nreturn effect();',
  );
  const begin = (id, before) => start(id, before, ...Object.values(bindings));
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const page = Array.from({ length: 26 }, (_, i) => entry('A' + i));
  const stopFirst = begin(1, null);
  pending[0].resolve({ data: page });
  await flush();
  assert.equal(rows.length, 25);
  stopFirst();
  const stopOlder = begin(1, cursor);
  assert.equal(pending[1].options.params.beforeId, 'A24');
  stopOlder();
  const stopB = begin(2, null);
  pending[2].resolve({ data: [entry('B')] });
  await flush();
  pending[1].resolve({ data: page });
  await flush();
  assert.deepEqual(
    rows.map((row) => row.id),
    ['B'],
  );
  assert.equal(cursor, null);
  assert.equal(timers.size, 1);
  stopB();
});

test('multiple clicks before React commits the loading state admit just one page transition', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/pages/crontab/triggerList.tsx'),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'triggerList.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let body;
  function visit(node) {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(ast) === 'onClick' &&
      node.initializer?.getText(ast).includes('setBefore(nextCursor)')
    )
      body = node.initializer.expression.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(body);
  const compiled = ts.transpile('const click = ' + body, {
    target: ts.ScriptTarget.ES2022,
  });
  const controller = new AbortController();
  const cursor = entry('tail'),
    transitions = [];
  const bindings = {
    loading: false,
    pageRequest: { current: controller },
    expanded: false,
    rows: [entry('head')],
    headRef: {},
    failed: false,
    nextCursor: cursor,
    setBefore: (value) => transitions.push(value),
    setLoading() {},
  };
  const click = Function(
    ...Object.keys(bindings),
    compiled + '\nreturn click;',
  )(...Object.values(bindings));
  click();
  click();
  click();
  assert.deepEqual(transitions, [cursor]);
  assert.ok(controller.signal.aborted);
});

test('an operation completing after closing the task cannot launch another detail poll', async () => {
  const controller = new AbortController();
  const resolveReads = [];
  const refresh = handler('refreshDetails', {
    cron: { id: 1 },
    config: { apiPrefix: '/api/' },
    refreshVersion: { current: 0 },
    session: { current: controller },
    setRefreshFailed: assert.fail,
    setCurrentCron: assert.fail,
    setRunningInstances: assert.fail,
    request: {
      get(url, { signal }) {
        assert.equal(signal, controller.signal);
        return new Promise((resolve) => resolveReads.push(resolve));
      },
    },
  });
  const old = refresh();
  controller.abort();
  await refresh();
  assert.equal(resolveReads.length, 1);
  resolveReads.forEach((resolve) => resolve({ code: 200, data: 'old' }));
  await old;
});

test('failed script read remains unavailable until a retry successfully loads the selected file', async () => {
  const controller = new AbortController();
  const states = [],
    values = [];
  let response = Promise.resolve({ code: 500, data: '' });
  const get = handler('getScript', {
    cron: { command: 'test' },
    session: { current: controller },
    getCommandScript: () => ['a#b.sh', 'dir'],
    config: { apiPrefix: '/api/' },
    tabList: [],
    setValidTabs() {},
    setScriptInfo() {},
    setScriptState: (state) => states.push(state),
    setValue: (value) => values.push(value),
    request: {
      get(url, options) {
        assert.equal(url, '/api/scripts/detail');
        assert.equal(options.params.file, 'a#b.sh');
        assert.equal(options.signal, controller.signal);
        return response;
      },
    },
  });
  get();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(states, ['loading', 'failed']);
  assert.deepEqual(values, []);
  response = Promise.resolve({ code: 200, data: 'loaded' });
  get();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.at(-1), 'ready');
  assert.deepEqual(values, ['loaded']);
});

test('switching to trigger history refreshes the task header without waiting for the next poll', () => {
  const events = [];
  const change = handler('onTabChange', {
    setActiveTabKey: (key) => events.push(key),
    refreshDetails: () => events.push('refresh'),
  });
  change('triggers');
  assert.deepEqual(events, ['triggers', 'refresh']);
});

test('dashboard live rows open the clicked instance even when the task ID is shared', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/pages/dashboard/index.tsx'),
    'utf8',
  );
  const tree = ts.createSourceFile(
    'dashboard.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let click, url;
  function visit(node) {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(tree) === 'onClick' &&
      node.initializer?.expression?.getText(tree).includes('setLogCron({')
    )
      click = node.initializer.expression;
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(tree) === 'CronLogModal'
    ) {
      url = node.attributes.properties.find(
        (p) => p.name?.getText(tree) === 'logUrl',
      )?.initializer.expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(click && url);
  for (const instanceId of [41, 42]) {
    let selection;
    Function(
      'setLogCron',
      'record',
      'id',
      '(' + click.getText(tree) + ')()',
    )(
      (value) => {
        selection = value;
      },
      { name: 'concurrent', instanceId },
      7,
    );
    const endpoint = Function(
      'config',
      'logCron',
      'return ' + url.getText(tree),
    )({ apiPrefix: '/api/' }, selection);
    assert.equal(endpoint, '/api/crons/7/log?instanceId=' + instanceId);
  }
});

test('a double click opens a single stop confirmation and natural completion refreshes the selected task', async () => {
  const dialogs = [],
    messages = [],
    requests = [];
  const open = handler('stopRunningInstance', {
    stopDialogs: { current: new Set() },
    Modal: { confirm: (opts) => dialogs.push(opts) },
    React: require('react'),
    intl: { get: (text) => text },
    cron: { id: 7 },
    config: { apiPrefix: '/api/' },
    request: {
      post: async (url) => {
        requests.push(url);
        return { code: 200, data: { outcome: 'ended' } };
      },
    },
    message: { info: (text) => messages.push(text), success: assert.fail },
    refreshAfterChange: () => messages.push('refresh'),
  });
  open({ id: 11, pid: 101 });
  open({ id: 11, pid: 101 });
  open({ id: 12, pid: 102 });
  assert.equal(dialogs.length, 2);
  await dialogs[0].onOk();
  assert.deepEqual(requests, ['/api/crons/7/instances/11/stop']);
  assert.deepEqual(messages, ['实例已结束', 'refresh']);
  dialogs[0].afterClose();
  open({ id: 11, pid: 101 });
  assert.equal(dialogs.length, 3);
});

test('retrying the same stop confirmation retains its key and selections, and a fresh action gets a new key', async () => {
  const load = require('../helpers/load-security-module.cjs');
  const sent = [];
  const notices = [];
  const { createStopRequest } = load('src/pages/crontab/stopRequest.ts', {
    antd: { message: { error: (m) => notices.push(m) } },
    'react-intl-universal': { get: (s) => s },
    '@/utils/config': { apiPrefix: '/api/' },
    '@/utils/http': {
      request: {
        put: async (url, ids, options) => {
          sent.push([url, [...ids], options.headers['Idempotency-Key']]);
          if (sent.length === 1) throw Error('connection lost');
          return { code: 200 };
        },
      },
    },
  });
  const ids = [3, 1];
  const confirm = createStopRequest(ids);
  ids.push(7);
  await assert.rejects(confirm(), /connection lost/);
  await confirm();
  await createStopRequest(ids)();
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(sent[0][1], [3, 1]);
  assert.notEqual(sent[0][2], sent[2][2]);
  assert.deepEqual(notices, ['停止请求未确认，可重试本次操作']);
});

test('expanded history refreshes a pending exit until the repaired result replaces it', async () => {
  let rows = [entry('older', 'unknown', 'exit_pending'), entry('stable')];
  const requested = [];
  const refresh = () =>
    refreshExpandedHistory(
      rows,
      rows[0],
      async (params) => {
        if (!params.has('ids')) return [rows[0]];
        requested.push(params.getAll('ids'));
        return [entry('older', 'failed')];
      },
      () => true,
      () => {},
      (_, updates) => {
        rows = [updates[0], rows[1]];
      },
    );
  await refresh();
  await refresh();
  assert.deepEqual(requested, [['older']]);
  assert.equal(rows[0].state, 'failed');
});

test('expanded history follows a booked legacy exit through dispute and definitive resolution', async () => {
  let rows = [
    { ...entry('old', 'finished'), legacy_exit_booking: 1 },
    entry('sibling', 'finished'),
  ];
  const requests = [];
  for (const next of [
    entry('old', 'unknown', 'exit_conflict'),
    entry('old', 'failed'),
    null,
  ]) {
    await refreshExpandedHistory(
      rows,
      rows[0],
      async (params) => {
        if (!params.has('ids')) return [rows[0]];
        requests.push(params.getAll('ids'));
        assert.ok(next);
        return [next];
      },
      () => true,
      () => {},
      (_, updates) => {
        rows = [updates[0], rows[1]];
      },
    );
  }
  assert.deepEqual(requests, [['old'], ['old']]);
  assert.deepEqual(
    rows.map((row) => row.state),
    ['failed', 'finished'],
  );
});

test('dashboard never rounds a missed plan up to 100 percent or treats an empty denominator as punctual', () => {
  const file = fs.readFileSync(
    path.join(__dirname, '../../src/pages/dashboard/index.tsx'),
    'utf8',
  );
  const tree = ts.createSourceFile(
    'dashboard.tsx',
    file,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const component = tree.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'ScheduleRate',
  );
  const { outputText } = ts.transpileModule(component.getText(tree), {
    fileName: 'rate.tsx',
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 },
  });
  const rate = new Function(
    'React',
    'Statistic',
    outputText + ';return ScheduleRate;',
  )({ createElement: (_type, props) => props }, 'Statistic');
  for (const [count, total, value] of [
    [9999, 10000, '>99.9%'],
    [10000, 10000, '100.0%'],
    [0, 1, '0.0%'],
    [0, 0, '—'],
  ]) {
    assert.equal(rate({ title: 'on time', count, total }).value, value);
  }
});

test('opened terminal timelines keep receiving late samples by trigger ID alongside live siblings', async () => {
  const sameSecond = [entry('old'), entry('sibling'), entry('live', 'queued')];
  const open = new Set(['old', 'live']);
  const states = new Map(sameSecond.map((row) => [row.id, row]));
  for (const state of ['running', 'finished']) {
    await refreshExpandedHistory(
      [...states.values()],
      sameSecond[0],
      async (params) => {
        const ids = params.getAll('ids');
        if (!ids.length) return [entry('new')];
        assert.deepEqual(ids, ['old', 'live']);
        return [
          { ...entry('live', state), started_at: 22 },
          { ...entry('old'), script_started_at: 17 },
        ];
      },
      () => true,
      (newer) => assert.equal(newer, false),
      (_, rows) => {
        for (const row of rows) states.set(row.id, row);
      },
      open,
    );
    assert.equal(states.get('old').script_started_at, 17);
    assert.equal(states.get('live').state, state);
    assert.equal(states.get('sibling').script_started_at, undefined);
  }
});

test('opening a timeline cancels an in-flight first page and pins its head until the last detail closes', async () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/pages/crontab/triggerList.tsx'),
    'utf8',
  );
  const tree = ts.createSourceFile(
    'triggerList.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let toggle, fetchPage, pageDeps;
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'onToggle')
      toggle = node.initializer.expression;
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'useEffect' &&
      node.arguments[1]?.getText(tree).includes('before')
    )
      [fetchPage, pageDeps] = node.arguments;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const rows = [entry('newer'), entry('subject')],
    headRef = {},
    pageRequest = {},
    requests = [];
  let opened = new Set(),
    paused = false,
    visible = rows,
    attempt = 0;
  const context = {
    rows,
    row: rows[1],
    headRef,
    pageRequest,
    statusRequest: {},
    before: null,
    id: 7,
    pageSize: 25,
    config: { apiPrefix: '/api/' },
    expanded: false,
    get pinned() {
      return opened.size > 0;
    },
    get paused() {
      return paused;
    },
    get attempt() {
      return attempt;
    },
    setAttempt(fn) {
      attempt = fn(attempt);
    },
    setOpenIds(fn) {
      opened = fn(opened);
    },
    request: { get: () => new Promise((resolve) => requests.push(resolve)) },
    setRows(fn) {
      visible = fn(visible);
    },
    setRefreshFailed() {},
    setHasNew() {},
    setLoading() {},
    setNextCursor() {},
    setFailed() {},
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
  };
  const invoke = (body) =>
    Function(
      ...Object.keys(context),
      ts.transpile('const fn = ' + body.getText(tree), {
        target: ts.ScriptTarget.ES2022,
      }) + '\nreturn fn();',
    )(...Object.values(context));
  const stopFirst = invoke(fetchPage);
  invoke(toggle);
  assert.ok(pageRequest.current.signal.aborted);
  assert.equal(headRef.current.id, 'newer');
  assert.deepEqual([...opened], ['subject']);
  stopFirst();
  paused = true;
  const leavePinned = invoke(fetchPage);
  assert.equal(requests.length, 1);
  requests[0]({ data: [entry('late-first-page')] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(visible, rows);
  invoke(toggle);
  assert.equal(opened.size, 0);
  leavePinned();
  paused = false;
  const close = invoke(fetchPage);
  requests[1]({ data: [entry('current-first-page')] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(visible[0].id, 'current-first-page');
  // Two activations in a single commit leave the first page visible.
  const dependencies = () =>
    Function(
      ...Object.keys(context),
      'return ' + pageDeps.getText(tree),
    )(...Object.values(context));
  const prior = dependencies();
  const click = Function(
    ...Object.keys(context),
    ts.transpile('const fn = ' + toggle.getText(tree), {
      target: ts.ScriptTarget.ES2022,
    }) + '\nreturn fn;',
  )(...Object.values(context));
  click();
  click();
  assert.equal(opened.size, 0);
  assert.ok(pageRequest.current.signal.aborted);
  assert.notDeepEqual(
    dependencies(),
    prior,
    'the aborted first-page poll needs a replacement even when the page stays unpinned',
  );
  close();
});

test('reopening a timeline with its sibling still open supersedes stale running and queued responses', async () => {
  const file = fs.readFileSync(
    path.join(__dirname, '../../src/pages/crontab/triggerList.tsx'),
    'utf8',
  );
  const tree = ts.createSourceFile(
    'triggerList.tsx',
    file,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let toggle, pollEffect, deps;
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'onToggle')
      toggle = node.initializer.expression;
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'useEffect' &&
      node.arguments[1]?.getText(tree).includes('pinned')
    )
      [pollEffect, deps] = node.arguments;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const old = [
    entry('a', 'running'),
    { ...entry('b', 'queued'), queue_wait_ms: 1000 },
  ];
  const latest = [
    {
      ...entry('b', 'finished'),
      started_at: 1200,
      queued_at: 1000,
      script_started_at: 1300,
    },
    { ...entry('a', 'failed'), exit_code: 7, script_started_at: 1100 },
  ];
  const requests = [],
    timers = new Set();
  let rows = old,
    opened = new Set(['a', 'b']);
  const headRef = { current: old[0] },
    statusRequest = {},
    pageRequest = {};
  const context = {
    id: 1,
    pinned: true,
    updateStatus: {},
    row: old[1],
    rows: old,
    headRef,
    rowsRef: { current: old },
    get openIds() {
      return opened;
    },
    get firstPageSelection() {
      return opened;
    },
    expanded: false,
    statusRequest,
    pageRequest,
    setOpenIds(update) {
      opened = update(opened);
    },
    createTriggerPoll,
    config: { apiPrefix: '/api/' },
    setHasNew() {},
    setRefreshFailed() {},
    setRows(update) {
      rows = update(rows);
    },
    setTimeout(fn) {
      timers.add(fn);
      return fn;
    },
    clearTimeout(fn) {
      timers.delete(fn);
    },
    request: {
      get(url, { params, signal }) {
        return params.has('ids')
          ? new Promise((resolve) => requests.push({ signal, resolve }))
          : Promise.resolve({ data: [old[0]] });
      },
    },
  };
  function evaluate(body) {
    return Function(
      ...Object.keys(context),
      ts.transpile('const result = ' + body, {
        target: ts.ScriptTarget.ES2022,
      }) + '\nreturn result;',
    )(...Object.values(context));
  }
  let previousDeps, dispose;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  async function commit() {
    const next = evaluate(deps.getText(tree));
    if (!previousDeps || next.some((value, i) => value !== previousDeps[i])) {
      dispose?.();
      dispose = evaluate(pollEffect.getText(tree))();
    }
    previousDeps = next;
    await flush();
  }
  await commit();
  evaluate(toggle.getText(tree))();
  assert.ok(
    requests[0].signal.aborted,
    'close must revoke the old response before effects run',
  );
  await commit();
  evaluate(toggle.getText(tree))();
  await commit();
  assert.equal(requests.length, 3);
  requests[2].resolve({ data: latest });
  await flush();
  for (const stale of requests.slice(0, 2).reverse())
    stale.resolve({ data: old });
  await flush();
  assert.deepEqual(rows, [latest[1], latest[0]]);
  assert.deepEqual([...opened].sort(), ['a', 'b']);
  assert.equal(timers.size, 1);
  dispose();
  assert.equal(timers.size, 0);
});

test('opening a detail and loading an older page in the same commit keep the page request and its loading indicator', () => {
  const file = fs.readFileSync(
    path.join(__dirname, '../../src/pages/crontab/triggerList.tsx'),
    'utf8',
  );
  const tree = ts.createSourceFile(
    'triggerList.tsx',
    file,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let toggle, load;
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'onToggle')
      toggle = node.initializer.expression;
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(tree) === 'onClick' &&
      node.initializer.getText(tree).includes('setBefore(nextCursor)')
    )
      load = node.initializer.expression;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const order of [
    [toggle, load, load],
    [load, toggle, load],
  ]) {
    const rows = [entry('first'), entry('tail')],
      cursors = [];
    let loading = false;
    const bindings = {
      row: rows[0],
      rows,
      pageRequest: { current: new AbortController() },
      statusRequest: {},
      pinned: false,
      loading: false,
      expanded: false,
      failed: false,
      nextCursor: rows[1],
      headRef: {},
      setBefore: (value) => cursors.push(value),
      setLoading: (value) => {
        loading = value;
      },
      setOpenIds() {},
      setHasNew() {},
      setFailed() {},
      setRefreshFailed() {},
      setAttempt() {},
    };
    for (const action of order) {
      const compiled = ts.transpile('const action=' + action.getText(tree), {
        target: ts.ScriptTarget.ES2022,
      });
      Function(
        ...Object.keys(bindings),
        compiled + '\naction();',
      )(...Object.values(bindings));
    }
    assert.deepEqual(
      cursors,
      [rows[1]],
      'a click must request the cursor exactly once',
    );
    assert.equal(
      loading,
      true,
      'pinning details must not clear an accepted page load',
    );
  }
});

test('a stalled head and first status batch do not hold up a later batch with a late entry sample', async () => {
  const rows = Array.from({ length: 51 }, (_, i) => entry(i, 'running'));
  const batches = [],
    resolved = [];
  let head;
  let failed;
  const tick = createTriggerPoll(
    rows[0],
    (params) => {
      const ids = params.getAll('ids');
      if (!ids.length)
        return new Promise((resolve) => {
          head = resolve;
        });
      return new Promise((resolve, reject) =>
        batches.push({ ids, resolve, reject }),
      );
    },
    () => true,
    () => {},
    (_, updates) => resolved.push(...updates),
    (value) => {
      failed = value;
    },
    new Set(),
  );
  tick(rows);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      batches.map((x) => x.ids.length),
      [25, 25],
    );
    const late = { ...entry('30', 'finished'), script_started_at: 421 };
    batches[1].resolve([late]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(resolved, [late]);
    assert.deepEqual(batches[2].ids, ['50']);
    batches[2].resolve([]);
    batches[0].reject(new Error('timeout'));
    head([]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failed, true);
    assert.deepEqual(resolved, [late]);
  } finally {
    head([]);
    for (const batch of batches) batch.resolve([]);
  }
});

test('page and status retries can settle in either order before both abandoned reads return', async () => {
  const file = fs.readFileSync(
    path.join(__dirname, '../../src/pages/crontab/triggerList.tsx'),
    'utf8',
  );
  const tree = ts.createSourceFile(
    'triggerList.tsx',
    file,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const effects = {};
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'useEffect'
    ) {
      const dependencies = node.arguments[1]?.getText(tree);
      if (dependencies?.includes('pinned')) effects.status = node.arguments[0];
      if (dependencies?.includes('before')) effects.page = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  for (const pageFirst of [false, true]) {
    const first = entry('simultaneous-B', 'running');
    const tail = entry('simultaneous-A', 'queued');
    const completed = {
      ...first,
      state: 'failed',
      exit_code: 7,
      script_started_at: 1220,
    };
    const dispatched = {
      ...tail,
      state: 'running',
      queued_at: 1110,
      started_at: 1200,
    };
    const older = entry('earlier');
    let rows = [first, tail];
    let nextCursor = tail;
    const calls = { page: [], status: [] };
    const openIds = new Set(rows.map((row) => row.id));
    const timers = new Set();
    const bindings = {
      rowsRef: { current: rows },
      headRef: { current: first },
      pageRequest: {},
      statusRequest: {},
      updateStatus: {},
      before: tail,
      id: 17,
      openIds,
      pinned: true,
      paused: false,
      pageSize: 25,
      createTriggerPoll,
      config: { apiPrefix: '/api/' },
      request: {
        get(url, { params, signal }) {
          if (params instanceof URLSearchParams && !params.has('ids'))
            return Promise.resolve({ data: [first] });
          const kind = params instanceof URLSearchParams ? 'status' : 'page';
          return new Promise((resolve) =>
            calls[kind].push({ params, signal, resolve }),
          );
        },
      },
      setNextCursor(value) {
        nextCursor = value;
      },
      setRows(update) {
        rows = update(rows);
      },
      setHasNew() {},
      setLoading() {},
      setRefreshFailed() {},
      setFailed() {},
      setTimeout(fn) {
        timers.add(fn);
        return fn;
      },
      clearTimeout(fn) {
        timers.delete(fn);
      },
    };
    function start(kind) {
      const js = ts.transpile('const effect = ' + effects[kind].getText(tree), {
        target: ts.ScriptTarget.ES2022,
      });
      return Function(
        ...Object.keys(bindings),
        js + '\nreturn effect();',
      )(...Object.values(bindings));
    }
    const endOldPage = start('page');
    const endOldStatus = start('status');
    endOldPage();
    endOldStatus();
    const endPage = start('page');
    const endStatus = start('status');
    try {
      assert.deepEqual(
        calls.page.map((call) => call.params.beforeId),
        [tail.id, tail.id],
      );
      assert.deepEqual(calls.status[1].params.getAll('ids'), [...openIds]);
      const sequence = pageFirst ? ['page', 'status'] : ['status', 'page'];
      for (const kind of sequence) {
        calls[kind][1].resolve({
          data: kind === 'page' ? [older] : [dispatched, completed],
        });
        await flush();
      }
      for (const kind of sequence.reverse()) {
        const old = calls[kind][0];
        assert.ok(old.signal.aborted);
        old.resolve({ data: kind === 'page' ? [older] : [first, tail] });
        await flush();
        assert.deepEqual(rows, [completed, dispatched, older]);
        assert.equal(nextCursor, null);
      }
      assert.equal(timers.size, 1);
    } finally {
      endPage();
      endStatus();
    }
    assert.equal(timers.size, 0);
  }
});

test('a held batch cannot delay later polls of other IDs or hide its failure on a sibling success', async () => {
  const rows = Array.from({ length: 76 }, (_, i) => entry(i));
  const open = new Set(rows.map((row) => row.id));
  const requests = [],
    notices = [],
    errors = [],
    updates = [];
  let active = true;
  const tick = createTriggerPoll(
    rows[0],
    (params) =>
      new Promise((resolve, reject) => {
        requests.push({ ids: params.getAll('ids'), resolve, reject });
      }),
    () => active,
    (value) => notices.push(value),
    (ids, data) => updates.push(...data),
    (value) => errors.push(value),
    open,
  );
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const cycle = () => {
    tick(rows);
  };
  const headReads = () => requests.filter((r) => !r.ids.length);
  const batches = () => requests.filter((r) => r.ids.length);
  cycle();
  const slow = batches()[0];
  const latest = {
    ...rows[25],
    script_started_at: 321,
    state: 'failed',
    exit_code: 7,
  };
  for (let round = 0; round < 3; round++) {
    for (let offset = 25; offset < rows.length; offset += 25) {
      const batch = batches().at(-1);
      assert.deepEqual(
        batch.ids,
        rows.slice(offset, offset + 25).map((r) => r.id),
      );
      batch.resolve(offset === 25 && round === 2 ? [latest] : []);
      await flush();
    }
    if (round < 2) cycle();
  }
  assert.ok(updates.includes(latest));
  assert.equal(batches().filter((r) => r.ids.includes('0')).length, 1);
  assert.equal(headReads().length, 1);
  slow.reject(new Error('timeout'));
  await flush();
  assert.equal(errors.at(-1), true);
  headReads()[0].resolve([entry('new')]);
  await flush();
  assert.equal(errors.at(-1), true);
  cycle();
  const retry = batches().findLast((r) => r.ids.includes('0'));
  assert.notEqual(retry, slow);
  retry.resolve(rows.slice(0, 25));
  await flush();
  assert.equal(errors.at(-1), false);
  active = false;
  const prior = {
    updates: updates.length,
    notices: notices.length,
    errors: errors.length,
  };
  requests.forEach((r) => r.resolve([entry('stale', 'running')]));
  await flush();
  assert.deepEqual(
    { updates: updates.length, notices: notices.length, errors: errors.length },
    prior,
  );
});

test('the mounted list keeps its five-second timer while a status batch is pending and cancels it on exit', async () => {
  const file = fs.readFileSync(
    path.join(__dirname, '../../src/pages/crontab/triggerList.tsx'),
    'utf8',
  );
  const tree = ts.createSourceFile(
    'triggerList.tsx',
    file,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let effect;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'useEffect' &&
      node.arguments[1]?.getText(tree).includes('pinned')
    )
      effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const rows = Array.from({ length: 51 }, (_, i) => entry(i, 'running'));
  const reads = [],
    timers = new Map(),
    changes = [];
  const bindings = {
    rowsRef: { current: rows },
    headRef: { current: rows[0] },
    statusRequest: {},
    updateStatus: {},
    id: 23,
    pinned: true,
    openIds: new Set(rows.map((row) => row.id)),
    createTriggerPoll,
    config: { apiPrefix: '/api/' },
    setHasNew() {},
    setRefreshFailed() {},
    setRows(update) {
      changes.push(update(rows));
    },
    setTimeout(fn, ms) {
      timers.set(fn, ms);
      return fn;
    },
    clearTimeout(fn) {
      timers.delete(fn);
    },
    request: {
      get(url, { params, signal }) {
        const ids = params.getAll('ids');
        if (!ids.length) return Promise.resolve({ data: [rows[0]] });
        if (ids.includes('25'))
          return new Promise((resolve) => reads.push({ ids, signal, resolve }));
        reads.push({ ids, signal });
        return Promise.resolve({
          data: rows.filter((row) => ids.includes(row.id)),
        });
      },
    },
  };
  const js = ts.transpile('const setup = ' + effect.getText(tree), {
    target: ts.ScriptTarget.ES2022,
  });
  const dispose = Function(
    ...Object.keys(bindings),
    js + '\nreturn setup();',
  )(...Object.values(bindings));
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    for (let tick = 0; tick < 2; tick++) {
      await flush();
      assert.equal(timers.size, 1);
      const [[next, ms]] = timers;
      assert.equal(ms, 5000);
      timers.delete(next);
      next();
    }
    await flush();
    assert.equal(reads.filter((read) => read.ids.includes('0')).length, 3);
    assert.equal(reads.filter((read) => read.ids.includes('25')).length, 1);
  } finally {
    dispose();
  }
  const count = changes.length;
  const old = reads.find((read) => read.resolve);
  assert.ok(old.signal.aborted);
  old.resolve({ data: rows });
  await flush();
  assert.equal(changes.length, count);
  assert.equal(timers.size, 0);
});

test('pending IDs keep their place when pages change between ticks and each ID has at most one outstanding read', async () => {
  const initial = Array.from({ length: 85 }, (_, i) => entry(i, 'running'));
  let active = true;
  const calls = [];
  const tick = createTriggerPoll(
    initial[0],
    (params) => {
      if (!params.has('ids')) return Promise.resolve([]);
      return new Promise((resolve) =>
        calls.push({ ids: params.getAll('ids'), resolve }),
      );
    },
    () => active,
    () => {},
    () => {},
    () => {},
    new Set(),
  );
  tick(initial);
  assert.equal(calls.length, 2);
  // Drop one queued row, append two newly loaded rows, then reverse display order.
  const changed = [
    ...initial.filter((r) => r.id !== '60'),
    entry('85', 'queued'),
    entry('86', 'queued'),
  ];
  tick(changed.toReversed());
  tick(changed);
  assert.equal(calls.length, 2);
  calls[1].resolve([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls[2].ids,
    changed.slice(50, 75).map((r) => r.id),
  );
  tick(changed);
  calls[2].resolve([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[3].ids.slice(0, 11), [
    ...initial.slice(76).map((r) => r.id),
    '86',
    '85',
  ]);
  assert.ok(!calls[3].ids.some((id) => calls[0].ids.includes(id)));
  active = false;
  calls[3].resolve([]);
  calls[0].resolve([]);
});

test('consecutive double timeouts give the waiting tail its turn and retries leave healthy reads alone', async () => {
  const rows = Array.from({ length: 75 }, (_, i) => entry(i, 'running'));
  const calls = [],
    errors = [],
    updated = [];
  let heads = 0;
  const poll = createTriggerPoll(
    rows[0],
    (params) => {
      if (!params.has('ids')) {
        heads++;
        return Promise.resolve([]);
      }
      return new Promise((resolve, reject) =>
        calls.push({ ids: params.getAll('ids'), resolve, reject }),
      );
    },
    () => true,
    () => {},
    (_, data) => updated.push(...data),
    (value) => errors.push(value),
    new Set(),
  );
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  poll(rows);
  assert.equal(calls.length, 2);
  calls[0].reject(new Error('timeout'));
  calls[1].reject(new Error('timeout'));
  await flush();
  assert.deepEqual(
    calls[2].ids,
    rows.slice(50).map((r) => r.id),
  );
  poll(rows, 'retry');
  poll(rows, 'retry');
  assert.equal(calls.length, 4);
  assert.equal(heads, 1, 'retry must not restart the successful head check');
  const late = { ...rows[60], state: 'finished', script_started_at: 1234 };
  calls[2].resolve([late]);
  await flush();
  assert.equal(calls.length, 5);
  assert.deepEqual(
    calls.slice(3).flatMap((c) => c.ids),
    rows.slice(0, 50).map((r) => r.id),
  );
  calls[3].reject(new Error('timeout again'));
  calls[4].reject(new Error('timeout again'));
  await flush();
  poll(rows);
  const newest = {
    ...rows[60],
    state: 'finished',
    script_started_at: 1234,
    exit_code: 0,
  };
  calls[5].resolve([]);
  calls[6].resolve([]);
  await flush();
  assert.deepEqual(
    calls[7].ids,
    rows.slice(50).map((r) => r.id),
  );
  calls[7].resolve([newest]);
  await flush();
  assert.deepEqual(updated, [late, newest]);
  assert.equal(errors.at(-1), false);
  const before = calls.length;
  poll(rows, 'retry');
  assert.equal(
    calls.length,
    before,
    'retry with no remaining failure must not query healthy rows',
  );
});

test('retry button preserves pending responses and bounds the two status reads in the mounted list', async () => {
  const file = fs.readFileSync(
    path.join(__dirname, '../../src/pages/crontab/triggerList.tsx'),
    'utf8',
  );
  const tree = ts.createSourceFile(
    'triggerList.tsx',
    file,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let effect, retry;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'useEffect' &&
      node.arguments[1]?.getText(tree).includes('pinned')
    )
      effect = node.arguments[0];
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(tree) === 'Button' &&
      node.children.some((child) =>
        child.getText(tree).includes("intl.get('重试')"),
      )
    ) {
      retry = node.openingElement.attributes.properties.find(
        (a) => a.name?.getText(tree) === 'onClick',
      ).initializer.expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const rows = Array.from({ length: 76 }, (_, i) => entry(i, 'running'));
  const calls = [],
    mutations = [];
  const bindings = {
    id: 4,
    pinned: true,
    openIds: new Set(),
    createTriggerPoll,
    rowsRef: { current: rows },
    headRef: { current: rows[0] },
    statusRequest: {},
    updateStatus: {},
    config: { apiPrefix: '/api/' },
    setHasNew() {},
    setRefreshFailed() {},
    setRows(update) {
      mutations.push(update(rows));
    },
    setTimeout() {},
    clearTimeout() {},
    request: {
      get(url, { signal, timeout, params }) {
        if (!params.has('ids')) return Promise.resolve({ data: [] });
        return new Promise((resolve, reject) =>
          calls.push({
            ids: params.getAll('ids'),
            signal,
            timeout,
            resolve,
            reject,
          }),
        );
      },
    },
  };
  function run(node) {
    const js = ts.transpile('const action=' + node.getText(tree), {
      target: ts.ScriptTarget.ES2022,
    });
    return Function(
      ...Object.keys(bindings),
      js + '\nreturn action();',
    )(...Object.values(bindings));
  }
  const dispose = run(effect);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.timeout === 10000));
    calls[0].reject(new Error('timeout'));
    await flush();
    run(retry);
    run(retry);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => !call.signal.aborted));
    const terminal = {
      ...rows[60],
      state: 'failed',
      exit_code: 7,
      script_started_at: 721,
    };
    calls[2].resolve({ data: [terminal] });
    await flush();
    assert.ok(mutations.at(-1).includes(terminal));
    assert.equal(
      calls[3].ids[0],
      '75',
      'oldest waiting ID must precede the manual retry',
    );
  } finally {
    dispose();
  }
  const count = mutations.length;
  for (const call of calls) call.resolve({ data: rows });
  await flush();
  assert.equal(mutations.length, count);
});

test('selection churn and retries cannot move waiting IDs behind the front pages or cancel an unrelated read', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => entry(i, 'finished'));
  const open = new Set(rows.map((r) => r.id));
  const calls = [],
    updates = [];
  let heads = 0;
  const poll = createTriggerPoll(
    rows[0],
    (params) => {
      if (!params.has('ids')) {
        heads++;
        return Promise.resolve([]);
      }
      return new Promise((resolve, reject) =>
        calls.push({ ids: params.getAll('ids'), resolve, reject }),
      );
    },
    () => true,
    () => {},
    (_, entries) => updates.push(...entries),
    () => {},
    open,
  );
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  poll(rows);
  for (const id of ['2', '29', '50', '75']) {
    const closed = new Set(open);
    closed.delete(id);
    poll(rows, closed);
    poll(rows, 'retry');
    poll(rows, open);
  }
  assert.equal(calls.length, 2);
  assert.equal(heads, 1);
  calls[0].reject(new Error('timeout'));
  calls[1].reject(new Error('timeout'));
  await flush();
  assert.deepEqual(
    calls.slice(2).map((c) => c.ids),
    [rows.slice(50, 75), rows.slice(75)].map((group) => group.map((r) => r.id)),
  );
  const closed = new Set(open);
  closed.delete('0');
  poll(rows, closed);
  poll(rows, 'retry');
  calls[2].resolve([]);
  calls[3].resolve([{ ...rows[78], script_started_at: 1234 }]);
  await flush();
  assert.ok(updates.some((r) => r.id === '78' && r.script_started_at === 1234));
  assert.ok(!calls.slice(4).some((c) => c.ids.includes('0')));
  for (const call of calls.slice(4)) call.resolve([]);
});

test('an opened in-flight row gets one fresh read after its peers, even after several close and reopen events', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => entry(i));
  const open = new Set(rows.map((r) => r.id));
  const closed = new Set(open);
  closed.delete('4');
  const calls = [],
    applied = [];
  const poll = createTriggerPoll(
    rows[0],
    (params) => {
      if (!params.has('ids')) return Promise.resolve([]);
      return new Promise((resolve) =>
        calls.push({ ids: params.getAll('ids'), resolve }),
      );
    },
    () => true,
    () => {},
    (_, values) => applied.push(...values),
    () => {},
    open,
  );
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  poll(rows);
  for (let i = 0; i < 5; i++) {
    poll(rows, closed);
    poll(rows, open);
  }
  assert.equal(calls.length, 2);
  calls[0].resolve([rows[4]]);
  await flush();
  assert.deepEqual(calls[2].ids, [...rows.slice(50).map((r) => r.id), '4']);
  const sampled = { ...rows[4], script_started_at: 12345, exit_code: 0 };
  calls[2].resolve([sampled]);
  calls[1].resolve([]);
  await flush();
  assert.deepEqual(applied, [rows[4], sampled]);
  assert.equal(calls.length, 3);
});

test('the paginated list keeps its polling session when details change and forwards the new selection', () => {
  const file = fs.readFileSync(
    path.join(__dirname, '../../src/pages/crontab/triggerList.tsx'),
    'utf8',
  );
  const tree = ts.createSourceFile(
    'triggerList.tsx',
    file,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let toggle, dependencies, firstPage, notify;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(tree) === 'firstPageSelection'
    )
      firstPage = node.initializer;
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'onToggle')
      toggle = node.initializer.expression;
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === 'useEffect'
    ) {
      if (node.arguments[0].getText(tree).includes('createTriggerPoll('))
        dependencies = node.arguments[1];
      if (node.arguments[1]?.getText(tree) === '[expanded, openIds]')
        notify = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const rows = Array.from({ length: 100 }, (_, i) => entry(i));
  let opened = new Set();
  const requests = [];
  const controller = new AbortController();
  const bindings = {
    id: 1,
    pinned: true,
    expanded: true,
    rows,
    rowsRef: { current: rows },
    row: rows[76],
    get openIds() {
      return opened;
    },
    setOpenIds(change) {
      opened = change(opened);
    },
    statusRequest: { current: controller },
    updateStatus: {
      current: (visible, selection) => requests.push({ visible, selection }),
    },
  };
  function evaluate(expression, extra = {}) {
    const scope = { ...bindings, ...extra };
    return Function(
      ...Object.keys(scope),
      'return (' + expression.getText(tree) + ');',
    )(...Object.values(scope));
  }
  const deps = () =>
    evaluate(dependencies, { firstPageSelection: evaluate(firstPage) });
  const before = deps();
  for (const index of [76, 32, 76, 2, 76]) {
    bindings.row = rows[index];
    evaluate(toggle)();
    assert.deepEqual(deps(), before);
    assert.ok(!controller.signal.aborted);
    evaluate(notify)();
    assert.equal(requests.at(-1).selection, opened);
    assert.equal(requests.at(-1).visible, rows);
  }
});
