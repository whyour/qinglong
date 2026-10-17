const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function fixture({ readyState = 'loading', navigation, legacy } = {}) {
  const callbacks = new Map();
  const listeners = new Set();
  const reports = [];
  let nextId = 0;
  const previousOnload = () => {};
  const window = {
    onload: previousOnload,
    performance: {
      ...(navigation === undefined
        ? {}
        : { getEntriesByType: () => [navigation] }),
      timing: legacy,
    },
    setTimeout(fn) {
      callbacks.set(++nextId, fn);
      return nextId;
    },
    clearTimeout(id) {
      callbacks.delete(id);
    },
    addEventListener(type, fn, options) {
      assert.equal(type, 'load');
      assert.equal(options.once, true);
      listeners.add(fn);
    },
    removeEventListener(type, fn) {
      assert.equal(type, 'load');
      listeners.delete(fn);
    },
  };
  const compiled = ts.transpileModule(
    fs.readFileSync(
      path.join(__dirname, '../../src/utils/navigationTiming.ts'),
      'utf8',
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    },
  ).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'window', 'document', compiled)(
    module,
    module.exports,
    window,
    { readyState },
  );
  const observe = () =>
    module.exports.observePageLoadTiming((v) => reports.push(v));
  return {
    reports,
    window,
    previousOnload,
    observe,
    load() {
      for (const fn of [...listeners]) {
        listeners.delete(fn);
        fn();
      }
    },
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const fn of pending) fn();
    },
  };
}

const timing = () => ({
  startTime: 0,
  responseStart: 10.4,
  responseEnd: 14,
  domInteractive: 30,
  domComplete: 50,
  loadEventEnd: 70.6,
});

test('loadEventEnd is read after load handlers complete, with real positive elapsed time', () => {
  const navigation = { ...timing(), loadEventEnd: 0 };
  const f = fixture({ navigation });
  f.observe();
  f.load();
  assert.equal(f.reports.length, 0);
  navigation.loadEventEnd = 70.6;
  f.flush();
  assert.deepEqual(f.reports, [
    { responseTime: 10, domReadyTime: 16, domParseTime: 20, loadTime: 71 },
  ]);
  f.load();
  f.flush();
  assert.equal(f.reports.length, 1);
});

test('late mounts report an already loaded page without replacing another onload handler', () => {
  const f = fixture({ readyState: 'complete', navigation: timing() });
  const dispose = f.observe();
  assert.equal(f.reports.length, 0);
  f.flush();
  assert.equal(f.reports[0].loadTime, 71);
  dispose();
  assert.equal(f.window.onload, f.previousOnload);
});

test('legacy epoch timings retain their own navigationStart baseline', () => {
  const f = fixture({
    readyState: 'complete',
    legacy: {
      navigationStart: 1700000000000,
      responseStart: 1700000000010,
      responseEnd: 1700000000014,
      domInteractive: 1700000000030,
      domComplete: 1700000000050,
      loadEventEnd: 1700000000071,
    },
  });
  f.observe();
  f.flush();
  assert.deepEqual(f.reports[0], {
    responseTime: 10,
    domReadyTime: 16,
    domParseTime: 20,
    loadTime: 71,
  });
});

test('navigation entries take precedence without mixing relative and epoch clocks', () => {
  const f = fixture({
    readyState: 'complete',
    navigation: timing(),
    legacy: { navigationStart: 1700000000000, loadEventEnd: 0 },
  });
  f.observe();
  f.flush();
  assert.equal(f.reports[0].loadTime, 71);
});

test('incomplete, negative and nonfinite timings are omitted rather than displayed as fabricated zeroes', () => {
  const f = fixture({
    readyState: 'complete',
    navigation: {
      ...timing(),
      responseStart: NaN,
      domInteractive: 10,
      domComplete: Infinity,
      loadEventEnd: 0,
    },
  });
  f.observe();
  f.flush();
  assert.ok(Object.values(f.reports[0]).every((v) => v === undefined));
});

test('unmount removes a pending load listener and cancels a queued report', () => {
  for (const loaded of [false, true]) {
    const f = fixture({ navigation: timing() });
    const dispose = f.observe();
    if (loaded) f.load();
    dispose();
    f.load();
    f.flush();
    assert.equal(f.reports.length, 0);
  }
});

test('strict-effect remounts leave exactly one active reporter', () => {
  const f = fixture({ readyState: 'complete', navigation: timing() });
  f.observe()();
  f.observe();
  f.flush();
  assert.equal(f.reports.length, 1);
});

test('missing performance timings produce no report', () => {
  const f = fixture({ readyState: 'complete' });
  f.observe();
  f.flush();
  assert.equal(f.reports.length, 0);
});
