const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function layout(width, legacy = false) {
  const values = [],
    listeners = new Set(),
    attributes = new Map(),
    effects = [];
  let cursor = 0,
    mounted = false;
  const media = { matches: width < 768 };
  const add = (fn) => listeners.add(fn),
    remove = (fn) => listeners.delete(fn);
  Object.assign(
    media,
    legacy
      ? { addListener: add, removeListener: remove }
      : {
          addEventListener: (_, fn) => add(fn),
          removeEventListener: (_, fn) => remove(fn),
        },
  );
  const module = { exports: {} };
  const source = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../../src/utils/hooks.ts'), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  new Function('require', 'module', 'exports', 'window', 'document', source)(
    (name) => {
      assert.equal(name, 'react');
      return {
        useState: (initial) => {
          const index = cursor++;
          if (!(index in values))
            values[index] = typeof initial === 'function' ? initial() : initial;
          return [
            values[index],
            (value) => {
              values[index] = value;
            },
          ];
        },
        useEffect: (fn) => {
          if (!mounted) effects.push(fn);
        },
      };
    },
    module,
    module.exports,
    { matchMedia: () => media, navigator: { userAgent: 'Desktop browser' } },
    { body: { setAttribute: (key, value) => attributes.set(key, value) } },
  );
  const render = () => {
    cursor = 0;
    return module.exports.useCtx();
  };
  const initial = render();
  const cleanup = effects.map((fn) => fn());
  mounted = true;
  return {
    initial,
    attributes,
    listeners,
    resize: (width) => {
      media.matches = width < 768;
      listeners.forEach((fn) => fn());
      return render();
    },
    unmount: () => cleanup.forEach((fn) => fn?.()),
  };
}

test('narrow desktop windows retain the top navigation and user controls, and follow viewport changes', () => {
  const view = layout(499);
  assert.equal(view.initial.isPhone, true);
  assert.equal(view.initial.headerStyle.marginTop, 0);
  assert.equal(view.attributes.get('data-mode'), 'phone');
  assert.equal(view.listeners.size, 1);
  const desktop = view.resize(1024);
  assert.equal(desktop.isPhone, false);
  assert.equal(desktop.headerStyle.marginTop, -48);
  assert.equal(view.attributes.get('data-mode'), 'desktop');
  const narrow = view.resize(767.5);
  assert.equal(narrow.isPhone, true);
  assert.equal(narrow.headerStyle.marginTop, 0);
  assert.equal(view.attributes.get('data-mode'), 'phone');
  assert.equal(view.resize(768).isPhone, false);
  view.unmount();
  assert.equal(view.listeners.size, 0);
});

test('older media query listeners are removed when the layout unmounts', () => {
  const view = layout(1024, true);
  assert.equal(view.resize(600).isPhone, true);
  assert.equal(view.attributes.get('data-mode'), 'phone');
  view.unmount();
  assert.equal(view.listeners.size, 0);
});
