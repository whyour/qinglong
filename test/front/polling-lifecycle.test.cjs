const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Execute the actual effect body with controlled requests and timers, without
// importing the page's chart/editor dependencies or duplicating its algorithm.
function loadEffect(file, requestName) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const matches = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'useEffect' &&
      node.arguments[0]?.getText(source).includes(`await ${requestName}()`)
    ) {
      matches.push(node.arguments[0].getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(matches.length, 1);
  const code = ts.transpile(`(${matches[0]})`, {
    target: ts.ScriptTarget.ES2020,
  });
  return new Function(
    requestName,
    'REFRESH_INTERVAL',
    'setTimeout',
    'clearTimeout',
    `return ${code}`,
  );
}

for (const [name, file, requestName, interval] of [
  ['dashboard', 'src/pages/dashboard/index.tsx', 'fetchData', 30000],
  [
    'task detail',
    'src/pages/crontab/detail.tsx',
    'fetchRunningInstances',
    10000,
  ],
]) {
  function harness() {
    const requests = [];
    const timers = new Map();
    let nextId = 0;
    const effect = loadEffect(file, requestName)(
      () => new Promise((resolve) => requests.push(resolve)),
      interval,
      (callback, delay) => {
        const id = ++nextId;
        timers.set(id, { callback, delay });
        return id;
      },
      (id) => timers.delete(id),
    );
    return {
      effect,
      requests,
      timers,
      async finish(index) {
        requests[index]();
        await Promise.resolve();
      },
    };
  }

  test(`${name}: one immediate fetch, no overlapping poll, and correct interval`, async () => {
    const h = harness();
    const cleanup = h.effect();
    assert.equal(h.requests.length, 1);
    assert.equal(h.timers.size, 0, 'no timer while first request is pending');
    await h.finish(0);
    assert.equal(h.timers.size, 1);
    const [id, timer] = [...h.timers][0];
    assert.equal(timer.delay, interval);
    h.timers.delete(id);
    const pending = timer.callback();
    assert.equal(h.requests.length, 2);
    assert.equal(h.timers.size, 0);
    await h.finish(1);
    await pending;
    assert.equal(h.timers.size, 1);
    cleanup();
    assert.equal(h.timers.size, 0);
  });

  for (const stage of ['initial', 'subsequent']) {
    test(`${name}: unmount during ${stage} request never restarts polling`, async () => {
      const h = harness();
      const cleanup = h.effect();
      let pending;
      if (stage === 'subsequent') {
        await h.finish(0);
        const [id, timer] = [...h.timers][0];
        h.timers.delete(id);
        pending = timer.callback();
      }
      cleanup();
      await h.finish(h.requests.length - 1);
      await pending;
      assert.equal(h.timers.size, 0);
    });
  }

  test(`${name}: replaced effect keeps only its own polling loop`, async () => {
    const h = harness();
    const oldCleanup = h.effect();
    oldCleanup();
    const cleanup = h.effect();
    assert.equal(h.requests.length, 2);
    await h.finish(1);
    assert.equal(h.timers.size, 1);
    await h.finish(0);
    assert.equal(
      h.timers.size,
      1,
      'late response from old effect cannot add a timer',
    );
    cleanup();
    assert.equal(h.timers.size, 0);
  });
}
