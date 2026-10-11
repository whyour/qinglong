const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(
  path.join(__dirname, '../../src/pages/diff/index.tsx'),
  'utf8',
);
const ast = ts.createSourceFile(
  'diff.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const callbacks = new Map();
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    ['getConfig', 'updateConfig', 'getSample'].includes(node.name.getText(ast))
  ) {
    callbacks.set(node.name.getText(ast), node.initializer.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);

function fixture(current, editorContent) {
  const calls = [];
  const values = {};
  const context = {
    current,
    origin: 'sample/notify.js',
    currentValue: '',
    editorRef: {
      current:
        editorContent === undefined
          ? null
          : {
              getModel: () => ({ modified: { getValue: () => editorContent } }),
            },
    },
    config: { apiPrefix: '/panel/api/' },
    request: {
      get: async (url) => {
        calls.push({ method: 'GET', url });
        return { code: 200, data: 'file content' };
      },
      post: async (url, body) => {
        calls.push({ method: 'POST', url, body });
        return { code: 200 };
      },
    },
    setCurrentValue: (value) => {
      values.current = value;
    },
    setOriginValue: (value) => {
      values.origin = value;
    },
    message: {
      success: (value) => {
        values.message = value;
      },
    },
    intl: { get: (value) => value },
  };
  vm.createContext(context);
  for (const [name, initializer] of callbacks) {
    vm.runInContext(
      ts.transpile(`var ${name} = ${initializer}`, {
        target: ts.ScriptTarget.ES2020,
      }),
      context,
    );
  }
  return { context, calls, values };
}

for (const [target, filename] of [
  ['config.sh', null],
  ['data/scripts/sendNotify.js', 'sendNotify.js'],
  ['data/scripts/notify.py', 'notify.py'],
  ['data/scripts/子目录/a b.js', '子目录/a b.js'],
]) {
  test(`diff tool reads and saves ${target} through its resource API`, async () => {
    const { context, calls, values } = fixture(target, 'updated\r\n');
    context.getConfig();
    context.updateConfig();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      calls[0].url,
      filename
        ? `/panel/api/scripts/detail?file=${encodeURIComponent(filename)}`
        : '/panel/api/configs/detail?path=config.sh',
    );
    assert.equal(
      calls[1].url,
      filename ? '/panel/api/scripts' : '/panel/api/configs/save',
    );
    assert.equal(
      calls[1].body[filename ? 'filename' : 'name'],
      filename || target,
    );
    assert.equal(calls[1].body.content, 'updated\n');
    assert.equal(values.current, 'file content');
    assert.equal(values.message, '保存成功');
  });
}

test('mobile diff tool can save an empty notification script and load its sample', async () => {
  const { context, calls, values } = fixture('data/scripts/sendNotify.js');
  context.updateConfig();
  context.getSample();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].url, '/panel/api/scripts');
  assert.equal(calls[0].body.filename, 'sendNotify.js');
  assert.equal(calls[0].body.content, '');
  assert.equal(
    calls[1].url,
    '/panel/api/configs/detail?path=sample%2Fnotify.js',
  );
  assert.equal(values.origin, 'file content');
});
