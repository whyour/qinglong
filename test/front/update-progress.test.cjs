const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
// Drive the real component's handlers and effects without a browser or network.
function panel() {
  let cursor = 0,
    tree,
    subscriber;
  const hooks = [],
    effects = [],
    cleanups = [],
    confirms = [],
    infos = [],
    timers = [],
    responses = [];
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = initial;
      return [
        hooks[i],
        (v) => {
          hooks[i] = typeof v === 'function' ? v(hooks[i]) : v;
        },
      ];
    },
    useRef(initial) {
      const i = cursor++;
      return (hooks[i] ||= { current: initial });
    },
    useCallback(fn) {
      cursor++;
      return fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!hooks[i] || deps.some((v, j) => !Object.is(v, hooks[i][j]))) {
        hooks[i] = deps;
        effects.push(fn);
      }
    },
  };
  function modal(options, list) {
    const result = {
      options,
      update(patch) {
        Object.assign(options, patch);
      },
      destroy() {
        options.afterClose?.();
      },
    };
    list.push(result);
    return result;
  }
  const mocks = {
    '@/utils': { disableBody() {} },
    '@/utils/config': { apiPrefix: '/api/' },
    '@/utils/http': {
      request: {
        put: async (url) =>
          responses.length
            ? responses.shift()(url)
            : {
                code: 200,
                data: { hasNewVersion: false, lastVersion: '2.23.0' },
              },
      },
    },
    '@/utils/websocket': {
      getInstance: () => ({
        subscribe(topic, fn) {
          subscriber = fn;
        },
        unsubscribe() {
          subscriber = undefined;
        },
      }),
    },
    'ansi-to-react': () => null,
    antd: {
      Button: 'button',
      Statistic: { Countdown: 'span' },
      message: { loading() {}, destroy() {}, error() {}, success() {} },
      Modal: {
        confirm: (o) => modal(o, confirms),
        info: (o) => modal(o, infos),
      },
    },
    react,
    'react-intl-universal': { get: (key) => key },
  };
  const module = { exports: {} };
  const compiled = ts.transpileModule(
    fs.readFileSync(
      path.join(__dirname, '../../src/pages/setting/checkUpdate.tsx'),
      'utf8',
    ),
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
    'document',
    compiled,
  )(
    (name) => mocks[name] || require(name),
    module,
    module.exports,
    (fn) => {
      timers.push(fn);
    },
    { querySelector: () => null },
  );
  function render() {
    cursor = 0;
    tree = module.exports.default({ systemInfo: { version: '2.23.0' } });
    while (effects.length) {
      const cleanup = effects.shift()();
      if (cleanup) cleanups.push(cleanup);
    }
  }
  async function settle() {
    await new Promise(setImmediate);
    render();
  }
  render();
  return {
    confirms,
    infos,
    responses,
    timers,
    settle,
    async start() {
      tree.props.children[0].props.onClick();
      await settle();
      confirms.at(-1).options.onOk();
      await settle();
      return infos.at(-1);
    },
    async send(payload) {
      subscriber?.(payload);
      await settle();
    },
    close() {
      infos.at(-1).destroy();
    },
    unmount() {
      cleanups.forEach((fn) => fn());
    },
  };
}
for (const logged of [false, true])
  test(`failed final update event unlocks the modal without an additional log; logged=${logged}`, async () => {
    const p = panel(),
      m = await p.start();
    if (logged) await p.send({ message: 'download failed\n' });
    assert.equal(m.options.okButtonProps.disabled, true);
    await p.send({ message: '', status: 'failed' });
    assert.equal(m.options.okButtonProps.disabled, false);
    assert.equal(m.options.closable, true);
  });
for (const rejected of [false, true])
  test(`update start request failure unlocks modal; rejected=${rejected}`, async () => {
    const p = panel();
    p.responses.push(
      async () => ({ code: 200, data: { hasNewVersion: false } }),
      async () => {
        if (rejected) throw new Error('offline');
        return { code: 400, message: 'busy' };
      },
    );
    const m = await p.start();
    assert.equal(m.options.okButtonProps.disabled, false);
    assert.equal(m.options.closable, true);
  });
test('retry clears the previous failure and ignores notifications without an active modal', async () => {
  const p = panel();
  await p.send({ status: 'success' });
  assert.equal(p.timers.length, 0);
  await p.start();
  await p.send({ status: 'failed', message: '' });
  p.close();
  const retry = await p.start();
  assert.equal(retry.options.okButtonProps.disabled, true);
  assert.equal(retry.options.closable, false);
});
test('successful completion prompts restart once and cancel leaves the log dismissible', async () => {
  const p = panel(),
    m = await p.start();
  await p.send({ status: 'success', message: '' });
  await p.send({ status: 'success', message: '' });
  p.timers.splice(0).forEach((fn) => fn());
  assert.equal(p.confirms.length, 2);
  p.confirms.at(-1).options.onCancel();
  assert.equal(m.options.okButtonProps.disabled, false);
  assert.equal(m.options.closable, true);
});
test('unmount removes the modal and suppresses a pending restart prompt', async () => {
  const p = panel();
  await p.start();
  await p.send({ status: 'success' });
  p.unmount();
  p.timers.splice(0).forEach((fn) => fn());
  assert.equal(p.confirms.length, 1);
});
