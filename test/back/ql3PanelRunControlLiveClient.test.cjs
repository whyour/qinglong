const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  preparePanelClient,
  loadPanelClient,
} = require('../../scripts/lib/ql3-panel-run-control-live-client.cjs');

function fixture(t, transport) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-panel-live-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'client');
  const manifest = preparePanelClient(
    path.resolve(__dirname, '../..'),
    directory,
  );
  const loaded = loadPanelClient(directory, 12345, transport);
  assert.equal(
    loaded.auth.setQingLong3Credential(`ql3c_test_${'A'.repeat(43)}`),
    true,
  );
  return { ...loaded, directory, manifest };
}

test('live adapter compiles actual sources and rejects modified generated modules', (t) => {
  const f = fixture(t, () => assert.fail('no HTTP expected'));
  assert.equal(
    f.manifest.control.source,
    'src/components/qinglong3/runControl.ts',
  );
  assert.match(f.manifest.control.sourceSha256, /^[a-f0-9]{64}$/);
  fs.appendFileSync(path.join(f.directory, 'control.cjs'), '\n// modified');
  assert.throws(
    () => loadPanelClient(f.directory, 12345),
    /Expected values to be strictly equal/,
  );
});

test('live adapter constrains capability discovery to the isolated loopback server', async (t) => {
  let calls = 0;
  const f = fixture(t, async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:12345/api/v3/capabilities');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Response('{}', { status: 404 });
  });
  for (const url of [
    'https://example.com/',
    '//example.com/',
    '/\\example.com/',
  ]) {
    assert.equal(await f.auth.discoverQingLong3(url), null);
  }
  assert.equal(calls, 0);
  assert.equal(await f.auth.discoverQingLong3('/api/v3/capabilities'), null);
  assert.equal(calls, 1);
});

test('response loss consumes an accepted receipt before actual client retries the same cancellation', async (t) => {
  let cancelled = 0;
  const f = fixture(t, async (url, options) => {
    assert.ok(
      url.startsWith('http://127.0.0.1:12345/api/v3/projects/default/'),
    );
    if (options.method === 'GET')
      return Response.json({
        run: {
          id: 'run:a',
          projectId: 'default',
          taskId: 'task:a',
          taskRevision: '1',
          status: 'running',
          createdAtMs: 1,
        },
      });
    cancelled++;
    return Response.json(
      {
        schema: 'qinglong/run-cancellation@v1',
        projectId: 'default',
        runId: 'run:a',
        status: cancelled === 1 ? 'accepted' : 'already_requested',
      },
      { status: cancelled === 1 ? 202 : 200 },
    );
  });
  const client = f.control.createPanelRunControl(
    { ql3: { projectId: 'default', taskId: 'task:a' } },
    {
      panel: { runControl: 'task_run_v1' },
      limits: { logChunkBytes: 16384 },
    },
  );
  const action = client.prepareCancel(await client.readRun('run:a'));
  f.loseNextCancellationResponse();
  await assert.rejects(action.execute(), (error) => error.uncertain === true);
  assert.equal(cancelled, 1);
  assert.equal((await action.execute()).status, 'already_requested');
  const writes = f.requests.filter((r) => r.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body, writes[1].body);
  assert.equal(writes[0].path, writes[1].path);
  assert.ok(!JSON.stringify(f.requests).includes('ql3c_'));
});
