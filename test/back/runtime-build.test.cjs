const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');

function load(root) {
  const module = { exports: {} };
  const output = ts.transpileModule(
    fs.readFileSync('back/shared/runtimeBuild.ts', 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    },
  ).outputText;
  new Function('require', 'module', 'exports', '__dirname', 'process', output)(
    require,
    module,
    module.exports,
    path.join(root, 'static/build/shared'),
    { env: { QL_DIR: root } },
  );
  return module.exports.runtimeBuild;
}

test('a running process retains its own build identity when installed files change', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-runtime-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'static/build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'version.yaml'), 'version: 2.24.0-dev.0');
  fs.writeFileSync(path.join(root, 'static/build/app.js'), 'old backend');
  fs.writeFileSync(
    path.join(root, 'static/build-info.json'),
    JSON.stringify({ sourceCommit: 'a'.repeat(40) }),
  );
  const running = load(root);
  fs.writeFileSync(path.join(root, 'static/build/app.js'), 'new backend');
  fs.writeFileSync(
    path.join(root, 'static/build-info.json'),
    JSON.stringify({ sourceCommit: 'b'.repeat(40) }),
  );
  fs.writeFileSync(path.join(root, 'version.yaml'), 'version: 2.25.0');
  assert.equal(running.version, '2.24.0-dev.0');
  assert.equal(running.sourceCommit, 'a'.repeat(40));
  assert.equal(
    running.backendSha256,
    createHash('sha256').update('old backend').digest('hex'),
  );
  const restarted = load(root);
  assert.equal(restarted.version, '2.25.0');
  assert.equal(restarted.sourceCommit, 'b'.repeat(40));
  assert.notEqual(restarted.backendSha256, running.backendSha256);
  assert.notEqual(restarted.instanceId, running.instanceId);
  assert.equal(Object.isFrozen(running), true);
});

test('unbuilt development environments keep health available without claiming a verified build', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-runtime-unbuilt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(load(root).sourceCommit, undefined);
  fs.mkdirSync(path.join(root, 'static'), { recursive: true });
  for (const content of ['broken', 'null', '42']) {
    fs.writeFileSync(path.join(root, 'static/build-info.json'), content);
    assert.equal(load(root).backendSha256, undefined);
  }
});
