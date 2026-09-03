const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Execute the shipped client, with only a DOM/transport fixture and test exports.
class Node {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.isConnected = true;
  }
  set textContent(value) {
    this.text = value;
    this.children = [];
  }
  get textContent() {
    return (this.text || '') + this.children.map((x) => x.textContent).join('');
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  detach() {
    this.isConnected = false;
    for (const child of this.children) child.detach();
  }
  replaceChildren(...children) {
    for (const child of this.children) child.detach();
    this.children = [];
    this.append(...children);
  }
  replaceWith(node) {
    const index = this.parent.children.indexOf(this);
    this.parent.children[index] = node;
    node.parent = this.parent;
    this.detach();
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  removeAttribute(name) {
    delete this[name];
  }
  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }
  querySelector() {
    return new Node();
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector === child.tag || selector === `.${child.className}`
        ? [child]
        : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

const run = {
  id: 'run-a',
  taskId: 'task-a',
  status: 'succeeded',
  latestAttempt: { id: 'attempt-a', attempt: 1, status: 'succeeded' },
};
function page(offset = 0, content = 'first', totalBytes = 10) {
  const endExclusive = offset + Buffer.byteLength(content);
  return {
    schema: 'qinglong/run-attempt-log-read-result@v1',
    status: 'available',
    projectId: 'default',
    runId: run.id,
    attemptId: run.latestAttempt.id,
    encoding: 'base64',
    content: Buffer.from(content).toString('base64'),
    range: {
      start: offset,
      endExclusive,
      totalBytes,
      ...(endExclusive < totalBytes ? { nextOffset: endExclusive } : {}),
    },
    truncation: { truncated: false },
  };
}
function fixture(logResponse = () => page()) {
  const nodes = new Map();
  const calls = [];
  const context = vm.createContext({
    TextDecoder,
    Uint8Array,
    URLSearchParams,
    Intl,
    console,
    window: { atob },
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, new Node());
        return nodes.get(id);
      },
      querySelector() {
        return new Node();
      },
      createElement: (tag) => new Node(tag),
      createDocumentFragment: () => new Node('fragment'),
      addEventListener() {},
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const result = url.includes('/log?')
        ? await logResponse(url)
        : url.includes('/events?')
        ? { events: [] }
        : url.includes('/steps?')
        ? { steps: [] }
        : { run };
      const status = result.httpStatus || 200;
      return {
        ok: status < 400,
        status,
        json: async () => result,
        headers: { get: () => null },
      };
    },
  });
  const source = fs.readFileSync(
    path.join(__dirname, '../assets/console/console.js'),
    'utf8',
  );
  assert.ok(source.endsWith('})();\n'));
  vm.runInContext(
    source.slice(0, -6) +
      'globalThis.client = { state, nodes, readRunLog, selectRun };})();',
    context,
  );
  Object.assign(context.client.state, {
    token: 'test-memory-token',
    project: 'default',
    view: 'runs',
  });
  return { ...context.client, calls };
}
const button = (client, label) =>
  client.nodes.detail
    .querySelectorAll('button')
    .find((node) => node.textContent === label);
const content = (client) =>
  client.nodes.detail.querySelectorAll('pre')[0]?.textContent;

test('native log pages replace one bounded window and preserve the Attempt binding', async () => {
  const client = fixture((url) =>
    url.includes('offset=5&') ? page(5, 'other') : page(),
  );
  await client.selectRun(run.id);
  assert.equal(content(client), 'first');
  await button(client, '下一片段').listeners.click();
  assert.equal(content(client), 'other');
  assert.equal(client.nodes.detail.querySelectorAll('pre').length, 1);
  assert.equal(button(client, '下一片段'), undefined);
  await button(client, '回到开头').listeners.click();
  assert.equal(content(client), 'first');
  assert.equal(client.calls.length, 6); // detail/events/steps plus three explicit reads
  assert.ok(
    client.calls
      .filter((x) => x.url.includes('/log?'))
      .every(
        (x) =>
          x.url.includes('/runs/run-a/attempts/attempt-a/log?') &&
          x.url.endsWith('length=32768'),
      ),
  );
});

test('rejects malformed identity, byte ranges, oversized content and non-progressing cursors', async () => {
  const invalid = [
    { ...page(), runId: 'foreign' },
    { ...page(), projectId: 'foreign' },
    { ...page(), attemptId: 'foreign' },
    { ...page(), schema: 'unknown' },
    { ...page(), content: '***' },
    { ...page(), content: Buffer.alloc(32769).toString('base64') },
    ...[
      { start: 1 },
      { endExclusive: 4 },
      { totalBytes: -1 },
      { nextOffset: 0 },
      { nextOffset: 6 },
      { nextOffset: undefined },
      { totalBytes: 5 },
      { totalBytes: Number.MAX_SAFE_INTEGER + 1 },
    ].map((range) => ({ ...page(), range: { ...page().range, ...range } })),
  ];
  for (const value of invalid) {
    const client = fixture(() => value);
    assert.equal((await client.readRunLog(run)).status, 'unavailable');
  }
  const client = fixture();
  assert.equal((await client.readRunLog(run, -1)).status, 'unavailable');
  assert.equal(client.calls.length, 0);
});

test('coalesces repeated clicks and discards a page after switching away', async () => {
  let finish;
  const client = fixture((url) =>
    url.includes('offset=5&')
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : page(),
  );
  await client.selectRun(run.id);
  const next = button(client, '下一片段');
  const pending = next.listeners.click();
  await next.listeners.click();
  assert.equal(client.calls.length, 5);
  assert.equal(next.disabled, true);
  client.state.view = 'tasks';
  finish(page(5, 'other'));
  await pending;
  assert.equal(content(client), 'first');
});

test('discards stale initial reads on re-selection and disconnect', async () => {
  const finishes = [];
  const client = fixture(
    () => new Promise((resolve) => finishes.push(resolve)),
  );
  const old = client.selectRun(run.id);
  while (finishes.length < 1)
    await new Promise((resolve) => setImmediate(resolve));
  const newer = client.selectRun(run.id);
  while (finishes.length < 2)
    await new Promise((resolve) => setImmediate(resolve));
  finishes[1](page(0, 'newer'));
  await newer;
  finishes[0](page(0, 'older'));
  await old;
  assert.equal(content(client), 'newer');
  const pending = button(client, '下一片段').listeners.click();
  client.state.token = null;
  finishes[2](page(5, 'other'));
  await pending;
  assert.equal(content(client), 'newer');
});

test('renders pending, retention, denial and unavailable states without a continuation', async () => {
  for (const [result, expected] of [
    [{ ...page(), status: 'pending', httpStatus: 202 }, 'pending'],
    [{ httpStatus: 410 }, 'retired'],
    [{ httpStatus: 404 }, 'not_found'],
    [{ httpStatus: 401 }, 'unavailable'],
    [{ httpStatus: 503 }, 'unavailable'],
  ]) {
    const client = fixture(() => result);
    await client.selectRun(run.id);
    assert.equal(
      client.nodes.detail.querySelectorAll('.run-log')[0].dataset.state,
      expected,
    );
    assert.equal(button(client, '下一片段'), undefined);
    assert.ok(button(client, '刷新当前片段'));
  }
});

test('accepts empty EOF, a full window and bounded UTF-8 replacement at a byte boundary', async () => {
  for (const [value, offset] of [
    [page(0, '', 0), 0],
    [page(10, '', 10), 20],
    [page(0, 'a'.repeat(32768), 32768), 0],
  ]) {
    const client = fixture(() => value);
    assert.equal((await client.readRunLog(run, offset)).status, 'available');
  }
  const value = page(0, 'a', 1);
  value.content = Buffer.from([0xe4]).toString('base64');
  const client = fixture(() => value);
  const result = await client.readRunLog(run);
  assert.equal(result.status, 'available');
  assert.equal(result.content, '\uFFFD');
});
