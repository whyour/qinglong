const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function fixture() {
  const timers = new Map(),
    responses = [],
    requests = [],
    confirms = [],
    errors = [],
    notifications = [];
  const persistent = new Map();
  let timerId = 0,
    reloads = 0,
    snapshot,
    fetchCount = 0;
  const storage = {
    getItem: (key) => persistent.get(key) || null,
    setItem: (key, value) => persistent.set(key, value),
    removeItem: (key) => persistent.delete(key),
  };
  const mocks = {
    '@/utils/config': { apiPrefix: '/panel/api/', authKey: 'token' },
    antd: {
      notification: { success: (options) => notifications.push(options) },
    },
    'react-intl-universal': { get: (key) => key },
    react: { useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot() },
  };
  function load(file, extra = {}) {
    const module = { exports: {} };
    const output = ts.transpileModule(
      fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
        },
      },
    ).outputText;
    new Function(
      'require',
      'module',
      'exports',
      'setTimeout',
      'clearTimeout',
      'fetch',
      'localStorage',
      'sessionStorage',
      'window',
      output,
    )(
      (name) => extra[name] || mocks[name] || require(name),
      module,
      module.exports,
      (fn, ms) => {
        const id = ++timerId;
        timers.set(id, { fn, ms });
        return id;
      },
      (id) => timers.delete(id),
      async (url, options) => {
        fetchCount++;
        requests.push({ url, options });
        const next = responses.shift();
        if (typeof next === 'function') return next(options);
        if (next instanceof Error) throw next;
        return {
          ok: true,
          json: async () => ({ code: 200, data: next || { status: 'idle' } }),
        };
      },
      storage,
      storage,
      { location: { reload: () => reloads++ } },
    );
    return module.exports;
  }
  const hooks = load('src/hooks/useUpgrade.ts');
  const store = hooks.upgradeStore;
  function component(file) {
    let cursor = 0;
    const values = [];
    const Modal = () => null;
    Modal.confirm = (options) => {
      confirms.push(options);
      return { destroy() {} };
    };
    const Component = load(file, {
      '@/hooks/useUpgrade': {
        __esModule: true,
        ...hooks,
        default: () => store.getSnapshot(),
      },
      '@/utils/http': {
        request: {
          put: async (url) => {
            requests.push({ url });
            if (url.endsWith('update-check'))
              return {
                code: 200,
                data: {
                  hasNewVersion: true,
                  lastVersion: '2.24.0',
                  lastLog: 'Notes',
                },
              };
            const result = responses.shift();
            if (result instanceof Error) throw result;
            return (
              result || {
                code: 200,
                data: {
                  id: 'apply',
                  status: 'starting',
                  action: 'apply',
                  phase: 'verifying',
                },
              }
            );
          },
        },
      },
      '@/pages/setting/checkUpdate': () => null,
      '@ant-design/icons': { CloudDownloadOutlined: 'DownloadIcon' },
      'ansi-to-react': 'Ansi',
      'react-intl-universal': { get: (key) => key },
      antd: {
        Alert: 'Alert',
        Button: 'Button',
        Modal,
        Progress: 'Progress',
        Space: 'Space',
        Tooltip: 'Tooltip',
        Typography: { Text: 'Text' },
        message: { error: (e) => errors.push(e), success() {} },
      },
      react: {
        useState(initial) {
          const index = cursor++;
          if (!(index in values)) values[index] = initial;
          return [values[index], (v) => (values[index] = v)];
        },
      },
    }).default;
    let tree;
    function render(props = {}) {
      cursor = 0;
      tree = Component({ systemInfo: { version: '2.23.0' }, ...props });
      return tree;
    }
    function nodes(type) {
      const found = [];
      const visit = (item) => {
        if (!item || typeof item !== 'object') return;
        if (Array.isArray(item)) return item.forEach(visit);
        if (item.type === type) found.push(item);
        visit(item.props?.children);
        visit(item.props?.description);
      };
      visit(tree);
      return found;
    }
    return { render, nodes, Modal };
  }
  return {
    store,
    hooks,
    responses,
    requests,
    confirms,
    errors,
    notifications,
    component,
    storage,
    timers,
    get fetchCount() {
      return fetchCount;
    },
    get reloads() {
      return reloads;
    },
    async settle() {
      await new Promise(setImmediate);
      snapshot = store.getSnapshot();
      return snapshot;
    },
    async tick(ms = 1000) {
      const entry = [...timers].find(([, v]) => v.ms === ms);
      assert.ok(entry, `timer ${ms} exists`);
      timers.delete(entry[0]);
      entry[1].fn();
      return this.settle();
    },
  };
}

test('sidebar and settings share one poller; mounting restores progress and the last unsubscribe stops it', async () => {
  const f = fixture();
  f.storage.setItem('token', 'secret');
  f.responses.push({ status: 'running', phase: 'downloading', percent: 40 });
  const off1 = f.store.subscribe(() => {}),
    off2 = f.store.subscribe(() => {});
  assert.equal((await f.settle()).job.percent, 40);
  assert.equal(f.fetchCount, 1);
  assert.equal(f.requests[0].url, '/panel/api/system/update-status');
  assert.equal(f.requests[0].options.headers.Authorization, 'Bearer secret');
  off1();
  f.responses.push({ status: 'ready' });
  assert.equal((await f.tick()).job.status, 'ready');
  off2();
  assert.equal(f.timers.size, 0);
});

test('polling reconnects after downtime and recovers ready without forcing a restart', async () => {
  const f = fixture();
  f.responses.push(new Error('offline'));
  const off = f.store.subscribe(() => {});
  assert.equal((await f.settle()).connected, false);
  f.responses.push({ status: 'ready', version: '2.24.0' });
  const recovered = await f.tick();
  assert.equal(recovered.connected, true);
  assert.equal(recovered.job.status, 'ready');
  assert.equal(f.reloads, 0);
  off();
});

test('a timed out status request is aborted and polling continues', async () => {
  const f = fixture();
  f.responses.push(
    ({ signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted'))),
      ),
  );
  const off = f.store.subscribe(() => {});
  assert.equal((await f.tick(5000)).connected, false);
  assert.equal((await f.tick()).connected, true);
  off();
});

test('stale poll responses cannot overwrite a newly accepted update job', async () => {
  const f = fixture();
  let release;
  f.responses.push(() => new Promise((resolve) => (release = resolve)));
  const off = f.store.subscribe(() => {});
  f.store.beginMutation();
  f.store.setJob({ status: 'starting', id: 'new' });
  f.store.finishMutation();
  release({
    ok: true,
    json: async () => ({ code: 200, data: { status: 'idle' } }),
  });
  assert.equal((await f.settle()).job.id, 'new');
  off();
});

test('completed application reloads the initiating tab once, including after a page refresh', async () => {
  const f = fixture();
  f.storage.setItem(f.hooks.reloadKey, 'update-1');
  f.responses.push({ id: 'update-1', status: 'completed' });
  const off = f.store.subscribe(() => {});
  await f.settle();
  assert.equal(f.reloads, 1);
  f.responses.push({ id: 'update-1', status: 'completed' });
  await f.tick(15000);
  assert.equal(f.reloads, 1);
  off();
});

test('download is nonblocking, progress survives closing the log, and ready exposes explicit apply', async () => {
  const f = fixture(),
    p = f.component('src/pages/setting/checkUpdate.tsx');
  f.store.setJob({ status: 'idle' });
  p.render();
  await p.nodes('Button')[0].props.onClick();
  await f.confirms.at(-1).onOk();
  f.store.setJob({
    status: 'running',
    phase: 'downloading',
    percent: 35,
    downloadedBytes: 35,
    totalBytes: 100,
  });
  p.render();
  assert.equal(p.nodes('Progress')[0].props.percent, 35);
  assert.deepEqual(
    p.nodes('Button').map((node) => node.props.children),
    ['查看更新日志'],
  );
  p.nodes('Button').at(-1).props.onClick();
  p.render();
  p.nodes(p.Modal)[0].props.onCancel();
  p.render();
  assert.equal(p.nodes(p.Modal)[0].props.open, false);
  f.store.setJob({ status: 'restarting', phase: 'restarting' });
  p.render();
  assert.deepEqual(
    p.nodes('Button').map((node) => node.props.children),
    ['查看更新日志'],
  );
  f.store.setJob({ status: 'ready' });
  p.render();
  p.nodes('Button')[0].props.onClick();
  assert.equal(f.confirms.at(-1).okText, '重启并更新');
  await f.confirms.at(-1).onOk();
  assert.ok(f.requests.some((r) => r.url.endsWith('update/system')));
  assert.equal(f.storage.getItem(f.hooks.reloadKey), 'apply');
});

test('start failure leaves retry enabled and unknown file size has no fake percentage', async () => {
  const f = fixture(),
    p = f.component('src/pages/setting/checkUpdate.tsx');
  f.store.setJob({ status: 'idle' });
  p.render();
  await p.nodes('Button')[0].props.onClick();
  f.responses.push(new Error('offline'));
  await f.confirms.at(-1).onOk();
  assert.equal(f.store.getSnapshot().busy, false);
  assert.equal(f.errors.length, 1);
  f.store.setJob({ status: 'running', phase: 'downloading', percent: null });
  p.render();
  assert.equal(p.nodes('Progress')[0].props.showInfo, false);
});

test('the persistent yellow sidebar entry shows live progress and remains accessible when collapsed', () => {
  const f = fixture(),
    p = f.component('src/components/UpgradeNotice.tsx');
  f.store.setJob({ status: 'running', phase: 'downloading', percent: 62 });
  p.render({ collapsed: false });
  assert.match(p.nodes('button')[0].props['aria-label'], /62%/);
  p.nodes('button')[0].props.onClick();
  p.render({ collapsed: true });
  assert.match(p.nodes('button')[0].props.className, /collapsed/);
  assert.equal(p.nodes(p.Modal)[0].props.open, true);
  f.store.setJob({ status: 'ready', phase: 'ready' });
  p.render();
  assert.equal(p.nodes('button')[0].props['aria-label'], '更新已就绪');
});

test('completed update refreshes once and reminds once after reconnecting the refreshed page', async () => {
  const f = fixture();
  f.storage.setItem(f.hooks.reloadKey, 'job');
  f.responses.push({ id: 'job', status: 'completed', phase: 'completed' });
  const off = f.store.subscribe(() => {});
  await f.settle();
  assert.equal(f.reloads, 1);
  assert.equal(f.notifications.length, 0);
  assert.equal(f.storage.getItem(f.hooks.completionKey), 'job');
  off();
  f.responses.push({ id: 'job', status: 'completed', phase: 'completed' });
  const off2 = f.store.subscribe(() => {});
  await f.settle();
  assert.equal(f.notifications.length, 1);
  assert.equal(f.storage.getItem(f.hooks.completionKey), null);
  f.responses.push({ id: 'job', status: 'completed', phase: 'completed' });
  await f.tick(15000);
  assert.equal(f.notifications.length, 1);
  off2();
});

test('completed sidebar disappears while an open result dialog and completed history remain available', () => {
  const f = fixture(),
    p = f.component('src/components/UpgradeNotice.tsx');
  f.store.setJob({ status: 'running', phase: 'downloading', percent: 12 });
  p.render();
  p.nodes('button')[0].props.onClick();
  f.store.setJob({
    id: 'done',
    status: 'completed',
    phase: 'completed',
    log: 'verified',
  });
  p.render({ collapsed: false });
  assert.equal(p.nodes('button').length, 0);
  assert.equal(p.nodes(p.Modal)[0].props.open, true);
  assert.equal(f.store.getSnapshot().job.status, 'completed');
  assert.equal(f.store.getSnapshot().job.log, 'verified');
  p.nodes(p.Modal)[0].props.onCancel();
  assert.equal(p.render({ collapsed: true }), null);
});

test('sidebar only shows updates that are in progress, ready or failed', () => {
  const f = fixture(),
    p = f.component('src/components/UpgradeNotice.tsx');
  for (const status of ['loading', 'idle', 'completed']) {
    f.store.setJob({ status, phase: status });
    assert.equal(p.render(), null);
  }
  for (const status of [
    'starting',
    'running',
    'restarting',
    'ready',
    'failed',
  ]) {
    f.store.setJob({
      status,
      phase: status === 'running' ? 'downloading' : status,
      percent: 12,
    });
    p.render({ collapsed: true });
    assert.equal(p.nodes('button').length, 1);
  }
});

test('update modal uses plain aligned content and explains restart state', () => {
  const f = fixture(),
    p = f.component('src/pages/setting/checkUpdate.tsx');
  f.store.setJob({ status: 'ready', phase: 'ready' });
  p.render();
  assert.equal(p.nodes('Alert').length, 0);
  assert.ok(
    p
      .nodes('Text')
      .some((n) => n.props.children.includes?.('下载完成，等待重启')),
  );
  f.store.setJob({ status: 'completed', phase: 'completed' });
  p.render();
  assert.deepEqual(
    p.nodes('Button').map((n) => n.props.children),
    ['检查更新', '查看更新日志'],
  );
  assert.ok(
    p
      .nodes('Text')
      .some(
        (n) => n.props.children === '已重新启动并运行新版本，无需再次重启。',
      ),
  );
});
