const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function action(file, name, bindings) {
  const filename = path.join(__dirname, '../../src', file);
  const ast = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let body;
  function visit(node) {
    if (node.name?.getText(ast) === name) {
      if (ts.isFunctionDeclaration(node)) body = node.getText(ast);
      if (ts.isVariableDeclaration(node)) body = 'const ' + node.getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(body, name);
  const js = ts.transpileModule(body.replace(/^export /, ''), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return Function(
    ...Object.keys(bindings),
    js + '\nreturn ' + name,
  )(...Object.values(bindings));
}
function transport() {
  const calls = [];
  return {
    calls,
    get(url, config) {
      return new Promise((resolve, reject) =>
        calls.push({ url, config, resolve, reject }),
      );
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const pastCursor = action('components/fileBrowser/index.tsx', 'pastCursor', {});

test('a retry at the top restores the next visible file when the first file was deleted', () => {
  const row = (title, top) => ({
    title,
    getBoundingClientRect: () => ({ top, bottom: top + 24 }),
  });
  const element = {
    scrollTop: 0,
    clientHeight: 48,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => [
      row('gone', 100),
      row('survivor', 124),
      row('below', 148),
    ],
    querySelector: (selector) =>
      selector === 'button[title="survivor"]' ? row('survivor', 364) : null,
  };
  const viewport = { current: element },
    position = {};
  action('components/fileBrowser/index.tsx', 'rememberPosition', {
    viewport,
    position,
  })();
  assert.deepEqual(
    [...position.current.offsets],
    [
      ['gone', 0],
      ['survivor', 24],
    ],
  );
  const emptyListing = { rows: [], next: '', versions: new Map() };
  action('components/fileBrowser/index.tsx', 'Entries', {
    React: require('react'),
    emptyListing,
    Spin: 'i',
    CSS: { escape: (key) => key },
    useRef: (value) =>
      value === null
        ? viewport
        : value === undefined
        ? position
        : { current: value },
    useState: (value) => [value, () => {}],
    useEffect() {},
    useLayoutEffect: (effect) => effect(),
  })({ source: 'logs', path: '', search: '' });
  assert.equal(element.scrollTop, 240);
  assert.equal(position.current, undefined);
});

test('a new execution has its own title before its log path arrives', () => {
  const readableLogName = action(
    'components/fileBrowser/name.ts',
    'readableLogName',
    {},
  );
  const title = action('pages/crontab/detail.tsx', 'instanceTitle', {
    readableLogName,
    intl: { get: (key, { id }) => key.replace('{id}', id) },
  });
  const next = { id: 34834, status: 0, log_path: null };
  const stopped = { id: 34814, status: 2, log_path: 'task/old.log' };
  assert.equal(title(stopped), 'old.log');
  assert.equal(title(next), '执行实例 #34834');
  assert.equal(title({ ...next, log_path: 'task/new.log' }), 'new.log');
});

test('file rows preserve meaningful suffixes, separate the search directory and expose the full path', () => {
  const React = require('react');
  const names = [
    'async_components___init__',
    'async_components_register.js',
    '中文任务_同步明细.log',
  ];
  const rows = names.map((title) => ({
    title,
    parent: 'workers',
    key: 'workers/' + title,
    type: 'file',
  }));
  const emptyListing = { rows, next: '', versions: new Map() };
  const entries = action('components/fileBrowser/index.tsx', 'Entries', {
    React,
    useRef: (current) => ({ current }),
    useState: (value) => [value, () => {}],
    useEffect() {},
    useLayoutEffect() {},
    emptyListing,
    FileOutlined: 'i',
    Spin: 'i',
    Typography: { Text: 'span' },
    readableLogName: (value) => value,
  })({ source: 'logs', path: '', search: 'work' }).props.children[0];
  const tails = ['___init__', '_register.js', '_同步明细.log'];
  for (const [i, button] of entries.entries()) {
    const [name, parent] = button.props.children[1].props.children;
    const parts = name.props.children.map((span) => span.props.children);
    assert.equal(parts.join(''), names[i]);
    assert.equal(parts[1], tails[i]);
    assert.equal(parent.props.children, 'workers');
    assert.equal(button.props.title, rows[i].key);
    assert.equal(button.props['aria-label'], rows[i].key);
  }
});

for (const remaining of [0, 2, 8]) {
  test(`manual retry retains the requested depth through churn and a network error with ${remaining} files left`, async () => {
    const emptyListing = { rows: [], next: '', versions: new Map() };
    const listing = {
      current: {
        rows: [0, 1, 2, 3],
        next: '4',
        versions: new Map([['a', '1']]),
      },
    };
    const states = [],
      failures = [];
    let checks = 0,
      reads = 0,
      phase = 'churn';
    const read = action('components/fileBrowser/index.tsx', 'read', {
      pastCursor,
      rememberPosition() {},
      listing,
      emptyListing,
      pending: {},
      path: 'a',
      source: 'scripts',
      search: '',
      folders: false,
      config: { apiPrefix: '/api/' },
      setLoading() {},
      setFailed: (v) => failures.push(v),
      setListing: (page) => states.push(page.rows),
      request: {
        async get(_url, { params }) {
          reads++;
          if (phase === 'offline') throw new Error('network unavailable');
          const count = phase === 'churn' ? 8 : remaining;
          const offset = Number(params.after);
          const data = Array.from(
            { length: Math.min(2, count - offset) },
            (_, i) => offset + i,
          );
          return {
            code: 200,
            data,
            next: offset + 2 < count ? String(offset + 2) : null,
            versions: [['a', '1']],
          };
        },
        async post() {
          checks++;
          return { code: 200, current: phase === 'stable' };
        },
      },
    });
    await read(listing.current);
    assert.equal(checks, 3);
    assert.deepEqual(states, [[], [], []]);
    assert.equal(failures.at(-1), true);
    await read(listing.current); // The directory keeps changing during manual retry.
    assert.equal(checks, 6);
    assert.equal(failures.at(-1), true);
    const retry = listing.current;
    phase = 'offline';
    await read(retry);
    assert.equal(failures.at(-1), true);
    phase = 'stable';
    await Promise.all([read(retry), read(retry)]);
    const count = Math.min(6, remaining);
    assert.deepEqual(
      listing.current.rows,
      Array.from({ length: count }, (_, i) => i),
    );
    assert.equal(listing.current.next, remaining > count ? String(count) : '');
    const completedReads = reads;
    await read(retry);
    assert.equal(reads, completedReads);
  });
}

for (const [source, search, boundary, cursors] of [
  ['scripts', '', '1m', ['0z', '1a', '1b', '1l', '1n', '1z']],
  ['logs', '', '1m', ['0z', '1z', '1x', '1n', '1k', '1a']],
  // DFS enters directory "a" before visiting sibling "a-".
  ['logs', 'needle', 'a-', ['a/1', 'a/2', 'a/3', 'a/x', 'a.', 'z']],
]) {
  test(`retry traverses the old boundary after earlier inserts and deletion of the cursor (${source}, ${
    search || 'directory'
  })`, async () => {
    const emptyListing = { rows: [], next: '', versions: new Map() };
    const listing = {
      current: { rows: ['old1', 'old2'], next: boundary, versions: new Map() },
    };
    const failures = [];
    let stable = false;
    const read = action('components/fileBrowser/index.tsx', 'read', {
      pastCursor,
      rememberPosition() {},
      listing,
      emptyListing,
      pending: {},
      source,
      path: '',
      search,
      folders: false,
      config: { apiPrefix: '/api/' },
      setLoading() {},
      setFailed: (v) => failures.push(v),
      setListing() {},
      request: {
        async get(_url, { params }) {
          const index =
            params.after === boundary ? 4 : cursors.indexOf(params.after) + 1;
          assert.ok(index < cursors.length);
          return {
            code: 200,
            next: cursors[index],
            data: search && index === 3 ? [] : [cursors[index]],
            versions: [['', '1']],
          };
        },
        async post() {
          return { code: 200, current: stable };
        },
      },
    });
    await read(listing.current);
    assert.equal(failures.at(-1), true);
    assert.equal(listing.current.retryAfter, boundary);
    stable = true;
    await read(listing.current);
    assert.equal(failures.at(-1), false);
    assert.equal(listing.current.next, cursors[4]);
    assert.deepEqual(
      listing.current.rows,
      cursors.slice(0, 5).filter((_, i) => !search || i !== 3),
    );
  });
}

test('loading more rebuilds the original depth if a delayed last page missed a move into a previous directory', async () => {
  const pages = [
    { data: ['c/old'], next: null, versions: [['c', '1']] },
    {
      data: ['a/moved', 'b/kept'],
      next: 'b/kept',
      versions: [
        ['a', '2'],
        ['b', '1'],
      ],
    },
    { data: ['c/new'], next: null, versions: [['c', '2']] },
  ];
  const cursors = [],
    checks = [],
    commits = [],
    emptyListing = { rows: [], next: '', versions: new Map() };
  const listing = {
    current: {
      rows: ['a/deleted', 'b/kept'],
      next: 'b/kept',
      versions: new Map([
        ['a', '1'],
        ['b', '1'],
      ]),
    },
  };
  const read = action('components/fileBrowser/index.tsx', 'read', {
    pastCursor,
    rememberPosition() {},
    pending: {},
    listing,
    emptyListing,
    source: 'logs',
    path: '',
    search: 'match',
    folders: false,
    config: { apiPrefix: '/api/' },
    setListing: (value) => commits.push(value.rows),
    setLoading() {},
    setFailed(value) {
      assert.equal(value, false);
    },
    request: {
      async get(_url, { params }) {
        cursors.push(params.after);
        return { code: 200, ...pages.shift() };
      },
      async post(_url, stamps) {
        checks.push(Object.fromEntries(stamps));
        return { code: 200, current: checks.length > 1 };
      },
    },
  });
  const previous = listing.current;
  await read(previous);
  await read(previous); // A late second click from the previous render.
  assert.deepEqual(cursors, ['b/kept', '', 'b/kept']);
  assert.deepEqual(checks, [
    { a: '1', b: '1', c: '1' },
    { a: '2', b: '1', c: '2' },
  ]);
  assert.deepEqual(commits, [[], ['a/moved', 'b/kept', 'c/new']]);
});

for (const retrying of [false, true]) {
  test(`abandoning a search discards its delayed validation during ${
    retrying ? 'manual retry' : 'initial load'
  }`, async () => {
    const pending = {},
      commits = [];
    const emptyListing = { rows: [], next: '', versions: new Map() };
    const previous = retrying
      ? { ...emptyListing, retryMinimum: 2 }
      : emptyListing;
    let finish,
      reads = 0;
    const read = action('components/fileBrowser/index.tsx', 'read', {
      pastCursor,
      rememberPosition() {},
      pending,
      listing: { current: previous },
      emptyListing,
      source: 'scripts',
      path: '',
      search: 'old',
      folders: false,
      config: { apiPrefix: '/api/' },
      setListing: (value) => commits.push(value),
      setLoading() {},
      setFailed() {},
      request: {
        async get() {
          reads++;
          return {
            code: 200,
            data: [`old-${reads}.js`],
            next: reads === 1 ? 'more' : null,
            versions: [['', '1']],
          };
        },
        post() {
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    const loading = read(previous);
    await flush();
    pending.current.abort();
    finish({ code: 200, current: true });
    await loading;
    assert.equal(reads, retrying ? 2 : 1);
    assert.deepEqual(commits, []);
  });
}

test('directory navigation shows the current path separately and returns exactly one level', () => {
  const React = require('react');
  for (const source of ['scripts', 'logs']) {
    let directory = 'parent/child';
    const render = (input = '') => {
      const states = [
        [
          directory,
          (next) => {
            directory = next;
          },
        ],
        [input, () => {}],
        [input, () => {}],
      ];
      return action('components/fileBrowser/index.tsx', 'FileBrowser', {
        React,
        Entries: 'div',
        Spin: 'span',
        ArrowUpOutlined: 'i',
        Button: 'button',
        Input: { Search: 'input' },
        Typography: { Text: 'span' },
        intl: { get: (key) => key },
        useEffect() {},
        useState: () => states.shift(),
      })({ source }).props.children[1];
    };
    assert.ok(!render('query'));
    for (const expected of ['parent/child', 'parent']) {
      const [up, location] = render().props.children;
      assert.equal(up.props.children, '上一级');
      assert.equal(location.props.title, expected);
      assert.equal(location.props.children, expected);
      up.props.onClick();
    }
    assert.ok(!render());
  }
});
test('typing a different search removes the old interactive list throughout the debounce', () => {
  const React = require('react');
  function Entries() {}
  function Spin() {}
  let input = 'old';
  let search = 'old';
  const render = () => {
    const values = ['', input, search];
    return action('components/fileBrowser/index.tsx', 'FileBrowser', {
      React,
      Entries,
      Spin,
      Input: { Search: 'input' },
      intl: { get: (key) => key },
      useEffect() {},
      useState: () => [values.shift(), () => {}],
    })({ source: 'logs' }).props.children.at(-1);
  };
  assert.equal(render().type, Entries);
  input = 'new';
  assert.equal(render().type, Spin);
  search = 'new';
  assert.equal(render().props.search, 'new');
});
for (const [source, name] of [
  ['log', 'getLog'],
  ['script', 'getDetail'],
]) {
  test(
    source + ' keeps the newest read when A, B and A resolve in reverse order',
    async () => {
      const request = transport(),
        key = { current: 'A' },
        contents = [];
      const select = action('pages/' + source + '/index.tsx', name, {
        request,
        config: { apiPrefix: '/api/' },
        detailRequest: { current: undefined },
        currentKeyRef: key,
        selectedKey: key,
        savedContentRef: { current: '' },
        setReadState() {},
        setReadFailed() {},
        setValue: (value) => contents.push(value),
      });
      for (const file of ['A', 'B', 'A']) {
        key.current = file;
        select({ key: file, title: file });
      }
      assert.deepEqual(
        request.calls.map((call) => call.config.signal.aborted),
        [true, true, false],
      );
      for (const [n, data] of [
        [2, 'new A'],
        [1, 'B'],
        [0, 'old A'],
      ]) {
        request.calls[n].resolve({ code: 200, data });
        await flush();
      }
      assert.deepEqual(contents, ['new A']);
    },
  );
}
test('expanded history retains its cursor and original head during inserts and retries the failed latest action', async () => {
  const state = {
    current: { rows: [], next: null, head: 0, hasNew: false, expanded: false },
  };
  const request = transport(),
    pending = {},
    paging = {},
    visibleIds = { current: new Set([3]) };
  let failure = '';
  const scrolls = [];
  const load = action('pages/crontab/instanceHistory.tsx', 'load', {
    state,
    request,
    pending,
    paging,
    visibleIds,
    list: { current: { scrollTo: (position) => scrolls.push(position) } },
    pageSize: 2,
    config: { apiPrefix: '/api/' },
    id: 1,
    setBusy() {},
    setView() {},
    setFailed(next) {
      failure = typeof next === 'function' ? next(failure) : next;
    },
  });
  function answer(ids, next) {
    request.calls
      .at(-1)
      .resolve({ code: 200, data: ids.map((id) => ({ id, status: 1 })), next });
  }
  let reading = load('refresh');
  answer([4, 3], 3);
  await reading;
  reading = load('older');
  await load('older');
  assert.deepEqual(request.calls.at(-1).config.params, {
    paged: true,
    limit: 2,
    before: 3,
  });
  assert.equal(request.calls.length, 2);
  request.calls.at(-1).reject(new Error('older request interrupted'));
  await reading;
  assert.equal(failure, 'older');
  reading = load('refresh');
  assert.deepEqual(request.calls.at(-1).config.params, {
    paged: true,
    limit: 1,
  });
  answer([5], null);
  await flush();
  answer([3], null);
  await reading;
  assert.equal(state.current.hasNew, true);
  assert.equal(failure, 'older');
  reading = load(failure);
  assert.deepEqual(request.calls.at(-1).config.params, {
    paged: true,
    limit: 2,
    before: 3,
  });
  answer([2, 1], null);
  await reading;
  reading = load('refresh');
  answer([6], null);
  await flush();
  assert.deepEqual(request.calls.at(-1).config.params, {
    paged: true,
    ids: '3',
  });
  answer([3], null);
  await reading;
  assert.deepEqual(
    state.current.rows.map((r) => r.id),
    [4, 3, 2, 1],
  );
  assert.equal(state.current.hasNew, true);
  reading = load('latest');
  request.calls.at(-1).reject(new Error('offline'));
  await reading;
  assert.equal(failure, 'latest');
  reading = load('refresh');
  answer([6], null);
  await flush();
  answer([3], null);
  await reading;
  assert.equal(failure, 'latest');
  reading = load(failure);
  assert.deepEqual(scrolls, []);
  answer([6, 5], 5);
  await reading;
  assert.deepEqual(
    state.current.rows.map((r) => r.id),
    [6, 5],
  );
  assert.equal(state.current.hasNew, false);
  assert.deepEqual(scrolls, [0]);
});
