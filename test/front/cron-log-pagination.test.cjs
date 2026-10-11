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
    ['getCronLog', 'cancel'].includes(node.name.getText(ast))
  )
    declarations.set(node.name.getText(ast), node.initializer.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);

function fixture(get) {
  const timers = new Map();
  const storage = new Map([['logCron', '1']]);
  const values = { content: '', executing: true };
  const pending = [];
  let timerId = 0;
  const context = {
    logUrl: undefined,
    config: { apiPrefix: '/api/' },
    cron: { id: 1 },
    uniqPath: '1',
    LOG_CHUNK_BYTES: 256 * 1024,
    MAX_LOG_VIEW_CHARS: 1024 * 1024,
    logOffsetRef: { current: undefined },
    valueRef: { current: '' },
    pollTimerRef: {},
    request: {
      get(url) {
        const result = get(url);
        pending.push(result);
        return result;
      },
    },
    localStorage: {
      getItem: (key) => storage.get(key),
      removeItem: (key) => storage.delete(key),
    },
    intl: { get: (value) => value },
    setLoading() {},
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
    await Promise.all(pending.splice(0));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    values,
    timers,
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
