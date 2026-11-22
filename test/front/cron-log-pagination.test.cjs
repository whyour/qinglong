const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { readLogChunk } = require('../../back/shared/logReader');

const source = fs.readFileSync(
  path.join(__dirname, '../../src/pages/crontab/logModal.tsx'),
  'utf8',
);
const ast = ts.createSourceFile(
  'logModal.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const declarations = new Map();
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    ['getCronLog', 'stopReading', 'cancel'].includes(node.name.getText(ast))
  )
    declarations.set(node.name.getText(ast), node.initializer.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);

function fixture(get) {
  const timers = new Map();
  const values = { content: '', executing: true };
  const pending = [];
  let timerId = 0;
  const context = {
    logUrl: undefined,
    config: { apiPrefix: '/api/' },
    cron: { id: 1 },
    session: { current: new AbortController() },
    pinnedTrigger: {},
    reading: { current: false },
    drained: {},
    lastPath: {},
    lastCursor: {},
    scrollTimer: {},
    LOG_CHUNK_BYTES: 256 * 1024,
    MAX_LOG_VIEW_CHARS: 1024 * 1024,
    logOffsetRef: { current: undefined },
    valueRef: { current: '' },
    pollTimerRef: {},
    request: {
      get(url, options) {
        const result = get(url, options);
        pending.push(result);
        return result;
      },
    },
    intl: { get: (value) => value },
    setLoading(value) {
      values.loading = value;
    },
    setReadFailed(value) {
      values.failed = value;
    },
    autoScroll() {},
    handleCancel() {},
    setValue(value) {
      values.content = value;
    },
    setExecuting(value) {
      values.executing = value;
    },
    setTimeout(fn, delay) {
      timers.set(++timerId, { fn, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  vm.createContext(context);
  for (const [name, initializer] of declarations)
    vm.runInContext(
      ts.transpile(`var ${name} = ${initializer}`, {
        target: ts.ScriptTarget.ES2020,
      }),
      context,
    );
  async function settle() {
    await Promise.allSettled(pending.splice(0));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    values,
    timers,
    retry() {
      context.getCronLog(context.logOffsetRef.current === undefined);
    },
    start() {
      context.getCronLog(true);
    },
    settle,
    async read() {
      context.getCronLog(true);
      await settle();
    },
    async tick() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.fn();
      await settle();
    },
    close() {
      context.cancel();
    },
  };
}

test('completed tasks drain unread chunks and display the final exit marker', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ql-log-pagination-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'task.log');
  await fsp.writeFile(file, 'started\n');
  let running = true;
  const offsets = [];
  const view = fixture(async (url) => {
    const query = new URL(url, 'http://localhost').searchParams;
    const offset = query.has('offset')
      ? Number(query.get('offset'))
      : undefined;
    offsets.push(offset);
    const chunk = await readLogChunk(file, {
      offset,
      tail: query.get('tail') === 'true',
      follow: query.get('follow') === 'true',
      cursor: query.get('cursor'),
      limit: Number(query.get('limit')),
    });
    return {
      code: 200,
      data: chunk.content,
      logStatus: running ? 'running' : 'completed',
      ...chunk,
    };
  });
  await view.read();
  assert.equal(view.timers.values().next().value.delay, 2000);
  await fsp.appendFile(file, 'x'.repeat(600 * 1024) + '\nFINAL_EXIT_CODE=1\n');
  running = false;
  await view.tick();
  assert.equal(view.values.executing, false);
  assert.equal(view.timers.values().next().value.delay, 0);
  await view.tick();
  await view.tick();
  assert.ok(view.values.content.endsWith('FINAL_EXIT_CODE=1\n'));
  assert.equal(view.timers.size, 0);
  assert.deepEqual(offsets, [undefined, 8, 8 + 256 * 1024, 8 + 512 * 1024]);
});

test('completed tail does not refetch discarded historical data', async () => {
  const view = fixture(async () => ({
    code: 200,
    data: 'tail',
    logStatus: 'completed',
    nextOffset: 900000,
    total: 900000,
    truncated: true,
  }));
  await view.read();
  assert.equal(view.values.content, 'tail');
  assert.equal(view.timers.size, 0);
});

test('running tasks poll without new bytes and closing cancels polling', async () => {
  const view = fixture(async () => ({
    code: 200,
    data: '',
    logStatus: 'running',
    nextOffset: 0,
    total: 0,
  }));
  await view.read();
  assert.equal(view.values.executing, true);
  assert.equal(view.timers.values().next().value.delay, 2000);
  view.close();
  assert.equal(view.timers.size, 0);
});

test('closing ignores an in-flight response with unread data', async () => {
  let resolve;
  const view = fixture(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  view.start();
  view.close();
  resolve({
    code: 200,
    data: 'late',
    logStatus: 'completed',
    nextOffset: 4,
    total: 100,
  });
  await view.settle();
  assert.equal(view.values.content, '');
  assert.equal(view.timers.size, 0);
});

test('legacy and non-advancing completed responses do not loop', async () => {
  for (const pagination of [{}, { nextOffset: 0, total: 100 }]) {
    const view = fixture(async () => ({
      code: 200,
      data: '',
      logStatus: 'completed',
      ...pagination,
    }));
    await view.read();
    assert.equal(view.timers.size, 0);
  }
});

test('first log read failure is recoverable on retry', async () => {
  let calls = 0;
  const view = fixture(async () => {
    if (++calls === 1) throw new Error('connection interrupted');
    return { code: 200, data: 'actual log' };
  });
  await view.read();
  assert.equal(view.values.failed, true);
  await view.read();
  assert.equal(view.values.failed, false);
  assert.equal(view.values.content, 'actual log');
});

test('independent log readers can receive responses in reverse order across close and reopen', async () => {
  let resolveOld;
  const old = fixture(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  old.start();
  old.close();
  const current = fixture(async () => ({ code: 200, data: 'new log' }));
  await current.read();
  resolveOld({ code: 200, data: 'old log', logStatus: 'running' });
  await old.settle();
  assert.equal(current.values.content, 'new log');
  assert.equal(old.values.content, '');
  assert.equal(old.timers.size, 0);
});

test('repeated retries share one in-flight read and closing aborts its transport', async () => {
  const pending = [];
  const view = fixture(
    (url, { signal }) =>
      new Promise((resolve) => pending.push({ signal, resolve })),
  );
  view.start();
  view.retry();
  assert.equal(pending.length, 1);
  view.close();
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve({ code: 200, data: 'old', logStatus: 'running' });
  await view.settle();
  assert.equal(view.timers.size, 0);
  assert.equal(view.values.content, '');
});

test('polling a missing log displays its status once and retries from the last confirmed byte', async () => {
  const calls = [];
  const responses = [
    { data: 'waiting', total: 0, nextOffset: 0 },
    { data: 'waiting', total: 0, nextOffset: 0 },
    { data: 'abc', total: 3, nextOffset: 3, logPath: 'a' },
    null,
    { data: 'd', total: 4, nextOffset: 4, logPath: 'a' },
    {
      data: 'new!',
      total: 4,
      nextOffset: 4,
      logPath: 'b',
      logStatus: 'completed',
    },
  ];
  const view = fixture(async (url) => {
    calls.push(new URL(url, 'http://localhost').searchParams);
    const r = responses.shift();
    if (!r) throw Error('offline');
    return { code: 200, logStatus: 'running', ...r };
  });
  await view.read();
  await view.tick();
  assert.equal(view.values.content, 'waiting');
  await view.tick();
  await view.tick();
  assert.equal(view.values.failed, true);
  assert.equal(view.values.content, 'abc');
  view.retry();
  view.retry();
  await view.settle();
  assert.equal(view.values.content, 'abcd');
  assert.deepEqual(
    calls.slice(3).map((p) => [p.get('offset'), p.get('previousPath')]),
    [
      ['3', 'a'],
      ['3', 'a'],
    ],
  );
  await view.tick();
  assert.equal(view.values.content, 'new!');
  assert.equal(view.timers.size, 0);
});

test('a shortened file during a retry is reread from its new tail', async () => {
  const responses = [
    { data: 'previous log', nextOffset: 12, total: 12 },
    { data: '', nextOffset: 3, total: 3 },
    { data: 'new', nextOffset: 3, total: 3 },
  ];
  const calls = [];
  const view = fixture(async (url) => {
    calls.push(url);
    return {
      code: 200,
      logStatus: responses.length === 3 ? 'running' : 'completed',
      ...responses.shift(),
    };
  });
  await view.read();
  await view.tick();
  await view.tick();
  assert.match(calls[2], /tail=true/);
  assert.equal(view.values.content, 'new');
  assert.equal(view.timers.size, 0);
});

test('retry after a truncate and regrow replaces displayed bytes and drains all pages exactly once', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ql-log-regrow-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.log');
  await fsp.writeFile(file, 'previous run\n');
  let running = true;
  let fail = false;
  const offsets = [];
  const view = fixture(async (url) => {
    const p = new URL(url, 'http://localhost').searchParams;
    const offset = p.has('offset') ? Number(p.get('offset')) : undefined;
    offsets.push(offset);
    if (fail) throw Error('timeout');
    const chunk = await readLogChunk(file, {
      offset,
      follow: p.get('follow') === 'true',
      cursor: p.get('cursor'),
      tail: p.get('tail') === 'true',
      limit: Number(p.get('limit')),
    });
    return {
      ...chunk,
      code: 200,
      data: chunk.content,
      logPath: 'run.log',
      logStatus: running ? 'running' : 'completed',
    };
  });
  await view.read();
  fail = true;
  await view.tick();
  assert.equal(view.values.failed, true);
  const current = Array.from(
    { length: 16000 },
    (_, i) => `${i} · 中文日志🚀\n`,
  ).join('');
  await fsp.writeFile(file, current);
  fail = running = false;
  view.retry();
  view.retry();
  await view.settle();
  while (view.timers.size) await view.tick();
  assert.equal(view.values.content, current);
  assert.equal(view.values.failed, false);
  assert.equal(view.values.executing, false);
  assert.deepEqual(offsets.slice(0, 3), [undefined, 13, 13]);
  assert.equal(offsets.length, 4);
});

test('a fresh list snapshot wakes a drained live viewer only for a new path or active task', () => {
  const effects = [];
  function visitEffect(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'useEffect' &&
      node.arguments[1]?.getText(ast) === '[cron]'
    )
      effects.push(node.arguments[0]);
    ts.forEachChild(node, visitEffect);
  }
  visitEffect(ast);
  assert.equal(effects.length, 1);
  const wake = ts.transpile('var wake = ' + effects[0].getText(ast), {
    target: ts.ScriptTarget.ES2020,
  });
  let calls = 0;
  const context = {
    cron: { log_path: 'old', status: 1 },
    lastPath: { current: 'old' },
    drained: { current: true },
    pinnedTrigger: {},
    logUrl: undefined,
    CrontabStatus: { running: 0, queued: 3 },
    getCronLog: () => calls++,
  };
  const update = () => vm.runInNewContext(wake + '\nwake()', context);
  update();
  assert.equal(calls, 0);
  context.cron = { log_path: 'new', status: 1 };
  update();
  assert.equal(calls, 1);
  context.cron = { log_path: 'old', status: 3 };
  update();
  assert.equal(calls, 2);
  context.drained.current = false;
  update();
  assert.equal(calls, 2);
  context.drained.current = true;
  context.logUrl = '/api/logs/detail?file=old';
  update();
  assert.equal(calls, 2);
});

test('concurrent live log polling and retries stay scoped to the initially selected trigger', async () => {
  const calls = [];
  const view = fixture(async (url) => {
    const p = new URL(url, 'http://localhost').searchParams;
    calls.push(p.get('triggerId'));
    if (calls.length === 2) throw Error('timeout');
    const selected = p.get('triggerId') || (calls.length === 1 ? 'a' : 'b');
    return {
      code: 200,
      triggerId: selected,
      logPath: selected + '.log',
      total: calls.length === 1 ? 1 : 2,
      nextOffset: calls.length === 1 ? 1 : 2,
      logStatus: calls.length < 3 ? 'running' : 'completed',
      data: calls.length === 1 ? 'A' : selected === 'a' ? '!' : 'B!',
    };
  });
  await view.read();
  await view.tick();
  view.retry();
  await view.settle();
  assert.deepEqual(calls, [null, 'a', 'a']);
  assert.equal(view.values.content, 'A!');
  assert.equal(view.timers.size, 0);
});
