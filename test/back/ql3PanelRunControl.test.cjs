const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');
require('ts-node/register/transpile-only');

const credential = `ql3c_test_${'A'.repeat(43)}`;
const task = {
  taskId: 'task:a',
  revision: 2,
  contentDigest: 'a'.repeat(64),
  enabled: true,
  name: 'Task A',
};
const run = {
  id: 'run:a',
  projectId: 'default',
  taskId: 'task:a',
  taskRevision: '2',
  status: 'running',
  createdAtMs: 100,
  latestAttempt: { id: 'attempt:a', logAvailable: true },
};
const cron = {
  ql3: { projectId: 'default', taskId: task.taskId, taskRevision: 1 },
};
const capabilities = {
  panel: { runControl: 'task_run_v1' },
  limits: { logChunkBytes: 16384 },
};
const startReceipt = {
  schema: 'qinglong/task-start@v1',
  projectId: 'default',
  taskId: task.taskId,
  taskRevision: 2,
  taskContentDigest: task.contentDigest,
  runId: run.id,
  status: 'accepted',
};
function fixture(response) {
  const calls = [];
  const context = vm.createContext({
    TextDecoder,
    Uint8Array,
    atob,
    crypto: require('node:crypto').webcrypto,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const value = await response(url, options, calls.length);
      return {
        ok: !value.httpStatus || value.httpStatus < 400,
        status: value.httpStatus || 200,
        json: value.json || (async () => value),
      };
    },
  });
  const load = (relative, imports = {}) => {
    const code = ts.transpileModule(
      fs.readFileSync(path.resolve(__dirname, '../..', relative), 'utf8'),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      },
    ).outputText;
    const mod = { exports: {} };
    vm.runInContext(`(function(require,exports,module){${code}\n})`, context)(
      (id) => {
        assert.ok(imports[id], `Unexpected import ${id}`);
        return imports[id];
      },
      mod.exports,
      mod,
    );
    return mod.exports;
  };
  const auth = load('src/utils/qinglong3.ts');
  auth.setQingLong3Credential(credential);
  const control = load('src/components/qinglong3/runControl.ts', {
    '@/utils/qinglong3': auth,
  });
  return {
    auth,
    control,
    calls,
    client: control.createPanelRunControl(cron, capabilities),
  };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('preparing explicit current revision does not send a write and start uses only canonical fields', async () => {
  const f = fixture((_url, options) =>
    options.method === 'GET' ? { task } : startReceipt,
  );
  const current = await f.client.readTask();
  const action = f.client.prepareStart(current);
  assert.equal(f.calls.length, 1);
  await action.execute();
  assert.equal(f.calls[1].url, '/api/v3/projects/default/tasks/task:a/runs');
  const body = JSON.parse(f.calls[1].options.body);
  assert.deepEqual(body, {
    schema: 'qinglong/task-start@v1',
    mutationId: action.mutationId,
    expectedRevision: 2,
    expectedContentDigest: task.contentDigest,
  });
  assert.equal(f.calls[1].options.credentials, 'omit');
  assert.equal(f.calls[1].options.redirect, 'error');
  assert.equal(
    f.calls[1].options.headers.authorization,
    `Bearer ${credential}`,
  );
});

test('ambiguous transport failure retries exactly the same mutation rather than creating another run', async () => {
  const f = fixture((_url, options, count) => {
    if (options.method === 'GET') return { task };
    if (count === 2) throw new Error('response lost after commit');
    return { ...startReceipt, status: 'existing' };
  });
  const action = f.client.prepareStart(await f.client.readTask());
  await assert.rejects(action.execute(), (e) => e.uncertain === true);
  assert.equal((await action.execute()).status, 'existing');
  assert.equal(f.calls[1].options.body, f.calls[2].options.body);
});

test('concurrent confirmation is rejected without a second POST', async () => {
  const response = deferred();
  const f = fixture((_url, options) =>
    options.method === 'GET' ? { task } : response.promise,
  );
  const action = f.client.prepareStart(await f.client.readTask());
  const first = action.execute();
  await assert.rejects(action.execute(), (e) => e.code === 'operation_pending');
  response.resolve(startReceipt);
  await first;
  assert.equal(f.calls.length, 2);
});

test('stale revision and denied identity never fall back to legacy mutation endpoints', async () => {
  for (const code of ['task_start_fence_rejected', 'authorization_denied']) {
    const f = fixture((_url, options) =>
      options.method === 'GET' ? { task } : { httpStatus: 409, code },
    );
    const action = f.client.prepareStart(await f.client.readTask());
    await assert.rejects(
      action.execute(),
      (e) => e.code === code && !e.uncertain,
    );
    assert.equal(f.calls.length, 2);
    assert.ok(
      f.calls.every((x) => x.url.startsWith('/api/v3/projects/default/')),
    );
  }
});

test('mismatched mutation receipts remain uncertain rather than reporting false success', async () => {
  const f = fixture((_url, options) =>
    options.method === 'GET' ? { task } : { ...startReceipt, taskRevision: 99 },
  );
  await assert.rejects(
    f.client.prepareStart(await f.client.readTask()).execute(),
    (e) => e.uncertain,
  );
});

test('cancellation names a previously read Run and terminal or foreign runs cannot be submitted', async () => {
  const f = fixture((_url, options) =>
    options.method === 'GET'
      ? { run }
      : {
          schema: 'qinglong/run-cancellation@v1',
          projectId: 'default',
          runId: run.id,
          status: 'accepted',
        },
  );
  const current = await f.client.readRun(run.id);
  const action = f.client.prepareCancel(current);
  assert.equal(f.calls.length, 1);
  await action.execute();
  assert.equal(
    f.calls[1].url,
    '/api/v3/projects/default/runs/run:a/cancellation',
  );
  assert.deepEqual(Object.keys(JSON.parse(f.calls[1].options.body)).sort(), [
    'mutationId',
    'schema',
  ]);
  assert.throws(() =>
    f.client.prepareCancel({ ...current, id: 'someone:else' }),
  );
  const terminal = fixture(() => ({ run: { ...run, status: 'succeeded' } }));
  const terminalRun = await terminal.client.readRun(run.id);
  assert.throws(() => terminal.client.prepareCancel(terminalRun));
  const foreign = fixture(() => ({ run: { ...run, taskId: 'task:other' } }));
  await assert.rejects(foreign.client.readRun(run.id));
});

test('project paging filters task records after validating monotonic canonical cursors', async () => {
  const f = fixture(() => ({
    runs: [run, { ...run, id: 'run:0', taskId: 'another' }],
    hasMore: true,
    next: { createdAtMs: 100, runId: 'run:0' },
  }));
  const page = await f.client.listRuns();
  assert.equal(page.scanned, 2);
  assert.equal(page.runs.length, 1);
  await assert.rejects(f.client.listRuns(page.next)); // repeated page cannot advance
  assert.equal(
    f.calls[1].url,
    '/api/v3/projects/default/runs?limit=64&after_created_at_ms=100&after_run_id=run:0',
  );
  await assert.rejects(
    f.client.listRuns({ createdAtMs: 100, runId: 'x&limit=999' }),
  );
  assert.equal(f.calls.length, 2);
});

test('over-budget pages and forged next cursors fail closed', async () => {
  for (const body of [
    { runs: Array(65).fill(run), hasMore: false },
    { runs: [run], hasMore: true, next: { createdAtMs: 99, runId: 'wrong' } },
    { runs: [run, run], hasMore: false },
  ])
    await assert.rejects(fixture(() => body).client.listRuns());
});

test('closing or reconnecting with the same credential rejects pending results and prepared writes', async () => {
  for (const finish of [
    (f) => f.client.dispose(),
    (f) => f.auth.setQingLong3Credential(credential),
    (f) => f.auth.clearQingLong3Credential(),
  ]) {
    const response = deferred();
    const f = fixture((_url, _options, count) =>
      count === 1 ? { task } : response.promise,
    );
    const action = f.client.prepareStart(await f.client.readTask());
    const reading = f.client.readTask();
    finish(f);
    response.resolve({ task });
    await assert.rejects(reading, (e) => e.code === 'session_changed');
    await assert.rejects(action.execute(), (e) => e.code === 'session_changed');
    assert.equal(f.calls.length, 2);
  }
});

test('same-credential reconnect while JSON decoding discards response and never follows up', async () => {
  const body = deferred(),
    decoding = deferred();
  const f = fixture(() => ({
    json() {
      decoding.resolve();
      return body.promise;
    },
  }));
  const reading = f.client.readTask();
  await decoding.promise;
  f.auth.setQingLong3Credential(credential);
  body.resolve({ task });
  await assert.rejects(reading, (e) => e.code === 'session_changed');
  assert.equal(f.calls.length, 1);
});

test('explicit Run log reads one bounded first chunk without using scheduled Trigger matching', async () => {
  const f = fixture((url) =>
    url.includes('/log?')
      ? {
          status: 'available',
          encoding: 'base64',
          projectId: 'default',
          runId: run.id,
          attemptId: run.latestAttempt.id,
          content: Buffer.from('manual execution 日志').toString('base64'),
        }
      : { run },
  );
  const current = await f.client.readRun(run.id);
  assert.match(await f.client.readLog(current), /manual execution 日志/);
  assert.equal(
    f.calls[1].url,
    '/api/v3/projects/default/runs/run:a/attempts/attempt:a/log?offset=0&length=16384',
  );
  assert.equal(f.calls.length, 2);
});

test('old capabilities do not silently enable canonical writes', () => {
  const f = fixture(() => ({}));
  assert.throws(() =>
    f.control.createPanelRunControl(cron, {
      panel: {},
      limits: capabilities.limits,
    }),
  );
});

test('capability discovery supports old read-only servers and rejects an unknown execution contract', async () => {
  const {
    panelCapabilities,
  } = require('../../packages/ql3-local-api/src/panel-compatibility/panelBootstrapRoute');
  for (const supported of [undefined, 'task_run_v1']) {
    const value = panelCapabilities('edge');
    const f = fixture(() => ({
      capabilities: {
        ...value,
        panel: { ...value.panel, runControl: supported },
      },
    }));
    const discovered = await f.auth.discoverQingLong3('/api/v3/capabilities');
    assert.ok(discovered);
    assert.equal(discovered.panel.runControl, supported);
    assert.equal(discovered.panel.legacyMutations, false);
  }
  const value = panelCapabilities('edge');
  const f = fixture(() => ({
    capabilities: {
      ...value,
      panel: { ...value.panel, runControl: 'allow_everything' },
    },
  }));
  assert.equal(await f.auth.discoverQingLong3('/api/v3/capabilities'), null);
});

test('browser mutation bodies pass the actual profile-neutral request parsers', async () => {
  const {
    parseTaskStartRequestBody,
  } = require('../../packages/ql3-runtime-core/src/task-start/taskStart');
  const {
    parseRunCancellationRequestBody,
  } = require('../../packages/ql3-runtime-core/src/run/clusterRunCancellation');
  const f = fixture((url, options) => {
    if (options.method === 'GET')
      return url.includes('/tasks/') ? { task } : { run };
    const body = JSON.parse(options.body);
    if (url.endsWith('/cancellation')) {
      assert.deepEqual(parseRunCancellationRequestBody(body), body);
      return {
        schema: 'qinglong/run-cancellation@v1',
        projectId: 'default',
        runId: run.id,
        status: 'accepted',
      };
    }
    assert.deepEqual(parseTaskStartRequestBody(body), body);
    return startReceipt;
  });
  await f.client.prepareStart(await f.client.readTask()).execute();
  await f.client.prepareCancel(await f.client.readRun(run.id)).execute();
});
