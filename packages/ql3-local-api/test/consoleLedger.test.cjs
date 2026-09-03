const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture } = require('./support/consoleClient.cjs');

const cursor = (view, row) =>
  view === 'runs'
    ? { runId: row.id, createdAtMs: row.createdAtMs }
    : view === 'tasks'
    ? { taskId: row.taskId }
    : { triggerId: row.triggerId };
const rows = (view, count = 65) =>
  Array.from({ length: count }, (_, index) => {
    const id = `item:${String(
      view === 'runs' ? count - index - 1 : index,
    ).padStart(3, '0')}`;
    return {
      id,
      taskId: id,
      triggerId: id,
      name: id,
      revision: 1,
      taskRevision: 1,
      kind: 'command',
      specSchema: 'qinglong/command@v1',
      enabled: true,
      status: 'succeeded',
      executionOrigin: 'manual',
      executionOwner: 'runtime',
      createdAtMs: 2000,
      updatedAtMs: 2000,
    };
  });
const page = (view, entries, more = false) => ({
  [view]: entries,
  [view === 'triggers' ? 'truncated' : 'hasMore']: more,
  ...(more
    ? { next: cursor(view, entries.at(-1)) }
    : view === 'triggers'
    ? { next: null }
    : {}),
});
const button = (client, label) =>
  client.nodes.ledger
    .querySelectorAll('button')
    .find((entry) => entry.textContent === label);
const records = (client) => client.nodes.ledger.querySelectorAll('.record');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

for (const view of ['tasks', 'triggers', 'runs']) {
  test(`${view}: reaches row 65, refreshes the current cursor and resets without retaining old rows`, async () => {
    const entries = rows(view);
    const client = fixture(view, (url) =>
      url.includes('&after_')
        ? page(view, entries.slice(64))
        : page(view, entries.slice(0, 64), true),
    );
    await client.refresh();
    assert.equal(records(client).length, 64);
    const next = button(client, '下一页');
    await next.listeners.click();
    await next.listeners.click(); // A detached footer cannot issue another request.
    assert.equal(records(client).length, 1);
    assert.equal(records(client)[0].dataset.identity, entries[64].id);
    assert.equal(button(client, '下一页'), undefined);
    assert.equal(client.calls.length, 2);
    const expected =
      view === 'runs'
        ? 'after_created_at_ms=2000&after_run_id=item:001'
        : view === 'tasks'
        ? 'after_task_id=item:063'
        : 'after_trigger_id=item:063';
    assert.equal(
      client.calls[1].url,
      `/api/v3/projects/default/${view}?limit=64&${expected}`,
    );
    await button(client, '刷新当前页').listeners.click();
    assert.equal(client.calls[2].url, client.calls[1].url);
    await button(client, '回到首页').listeners.click();
    assert.equal(client.calls[3].url, client.calls[0].url);
    assert.equal(records(client).length, 64);
    assert.equal(client.calls.length, 4);
    assert.ok(client.calls.every(({ options }) => options.method === 'GET'));
    assert.equal(client.state.selectedId, null);
  });

  test(`${view}: rejects oversized, unordered, empty-continuation and mismatched cursor responses`, async () => {
    const entries = rows(view);
    const invalid = [
      page(view, entries),
      page(view, [entries[1], entries[0]]),
      page(view, [entries[0], entries[0]]),
      { [view]: [] },
      {
        ...page(view, [], false),
        [view === 'triggers' ? 'truncated' : 'hasMore']: true,
        next: cursor(view, entries[0]),
      },
      {
        ...page(view, entries.slice(0, 2), true),
        next: cursor(view, entries[0]),
      },
      {
        ...page(view, entries.slice(0, 2), true),
        next: { ...cursor(view, entries[1]), extra: 'not-allowed' },
      },
      { ...page(view, entries.slice(0, 2)), next: cursor(view, entries[1]) },
      page(view, [
        {
          ...entries[0],
          id: 'bad&limit=100',
          taskId: 'bad&limit=100',
          triggerId: 'bad&limit=100',
        },
      ]),
    ];
    for (const value of invalid) {
      const client = fixture(view, () => value);
      await client.refresh();
      assert.equal(records(client).length, 0);
      assert.equal(button(client, '下一页'), undefined);
      assert.equal(client.nodes.connection.dataset.state, 'error');
      assert.equal(client.calls.length, 1);
    }
  });

  test(`${view}: keeps an empty later page reachable and retries failures at the same boundary`, async () => {
    const entries = rows(view);
    const client = fixture(view, (_url, call) =>
      call === 1
        ? page(view, entries.slice(0, 64), true)
        : call === 2
        ? { httpStatus: 503, code: 'request_unavailable' }
        : page(view, []),
    );
    await client.refresh();
    await button(client, '下一页').listeners.click();
    assert.equal(client.nodes.connection.dataset.state, 'error');
    await button(client, '刷新当前页').listeners.click();
    assert.equal(client.calls[2].url, client.calls[1].url);
    assert.equal(records(client).length, 0);
    assert.ok(button(client, '回到首页'));
    assert.equal(button(client, '下一页'), undefined);
    assert.equal(client.calls.length, 3);
  });
}

test('coalesces footer clicks and prevents a stale page or error from replacing another view', async () => {
  for (const result of [
    page('tasks', rows('tasks', 1)),
    { httpStatus: 401, code: 'authentication_required' },
  ]) {
    const pending = deferred();
    const client = fixture('tasks', (url, call) =>
      call === 1
        ? page('tasks', rows('tasks').slice(0, 64), true)
        : url.includes('/tasks?')
        ? pending.promise
        : page('runs', rows('runs', 1)),
    );
    await client.refresh();
    const next = button(client, '下一页');
    const reading = next.listeners.click();
    await next.listeners.click();
    assert.equal(client.calls.length, 2);
    client.state.view = 'runs';
    await client.refresh();
    const displayed = client.nodes.ledger.textContent;
    pending.resolve(result);
    await reading;
    assert.equal(client.nodes.ledger.textContent, displayed);
    assert.equal(client.nodes.connection.dataset.state, 'connected');
    assert.equal(client.nodes.refresh.disabled, false);
  }
});

test('discarding a response after disconnect/reconnect does not change new session state', async () => {
  const old = deferred();
  const client = fixture('tasks', (_url, call) =>
    call === 1 ? old.promise : page('tasks', rows('tasks', 1)),
  );
  const reading = client.refresh();
  client.disconnect();
  const disconnected = client.nodes.ledger.textContent;
  old.resolve(page('tasks', rows('tasks')));
  await reading;
  assert.equal(client.nodes.ledger.textContent, disconnected);
  assert.equal(client.state.token, null);
  client.state.token = 'new-session-token';
  await client.refresh();
  assert.equal(records(client).length, 1);
  assert.equal(
    JSON.stringify(client.state.listRequest).includes('token'),
    false,
  );
});

test('same-view refresh rejects stale success and leaves current loading state intact', async () => {
  const first = deferred();
  const second = deferred();
  const client = fixture('tasks', (_url, call) =>
    call === 1 ? first.promise : second.promise,
  );
  const old = client.refresh();
  const current = client.refresh();
  first.resolve(page('tasks', rows('tasks', 1)));
  await old;
  assert.equal(records(client).length, 0);
  assert.equal(client.nodes.refresh.disabled, true);
  second.resolve(page('tasks', rows('tasks', 2)));
  await current;
  assert.equal(records(client).length, 2);
});

test('Task and Trigger details cannot overwrite a later list generation', async () => {
  for (const view of ['tasks', 'triggers']) {
    const pending = deferred();
    const client = fixture(view, (url) =>
      url.includes('?') ? page(view, rows(view, 1)) : pending.promise,
    );
    await client.refresh();
    const select = view === 'tasks' ? client.selectTask : client.selectTrigger;
    const reading = select('item:000');
    await client.refresh();
    client.nodes.detail.textContent = 'current detail';
    pending.resolve(
      view === 'tasks'
        ? { task: rows(view, 1)[0] }
        : { trigger: rows(view, 1)[0] },
    );
    await reading;
    assert.equal(client.nodes.detail.textContent, 'current detail');
  }
});

test('stale Secret metadata cannot replace the new ledger or catalog', async () => {
  const pending = deferred();
  const client = fixture('secrets', (url) =>
    url.includes('/secrets?') ? pending.promise : page('tasks', []),
  );
  const reading = client.refresh();
  client.state.view = 'tasks';
  await client.refresh();
  client.state.secretCatalog = ['current-session-catalog'];
  const displayed = client.nodes.ledger.textContent;
  pending.resolve({ secrets: [], truncated: false });
  await reading;
  assert.equal(client.nodes.ledger.textContent, displayed);
  assert.deepEqual(client.state.secretCatalog, ['current-session-catalog']);
});

test('generated continuation URLs pass the production HTTP parser for all three ledgers', async (t) => {
  const net = require('node:net');
  const {
    startLocalApiHttpSurface,
  } = require('../dist/transport/httpSurface.js');
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  const observed = [];
  const surface = await startLocalApiHttpSurface({
    profile: 'edge',
    host: '127.0.0.1',
    port,
    admission: {
      async prepare({ operation }) {
        observed.push(operation);
        const view = {
          'task.list': 'tasks',
          'trigger.list': 'triggers',
          'run.list': 'runs',
        }[operation.operationId];
        assert.ok(view);
        const input = operation.input || operation;
        assert.equal(input.limit, 64);
        const entries = rows(view);
        if (input.after)
          assert.deepEqual(input.after, cursor(view, entries[63]));
        return {
          bodyMode: 'none',
          maximumBodyBytes: 0,
          async handle() {
            return {
              statusCode: 200,
              body: input.after
                ? page(view, entries.slice(64))
                : page(view, entries.slice(0, 64), true),
            };
          },
        };
      },
    },
  });
  t.after(() => surface.stopAndDrain());
  for (const view of ['tasks', 'triggers', 'runs']) {
    const client = fixture(view, async (url) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        headers: { authorization: 'Bearer test' },
      });
      assert.equal(response.status, 200);
      return response.json();
    });
    await client.refresh();
    await button(client, '下一页').listeners.click();
    assert.equal(records(client).length, 1);
  }
  assert.equal(observed.length, 6);
});
