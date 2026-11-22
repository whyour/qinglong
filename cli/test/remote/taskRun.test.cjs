const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const entry = path.resolve(__dirname, '../../dist/npm/ql.js');
const triggerId = '6ecf88e9-b7dc-42c9-b2a6-47a0d707aceb-12';

async function fixture(t) {
  const requests = [];
  const state = {
    run: [{ taskId: 12, triggerId, state: 'queued', reason: null }],
    rows: [
      {
        id: triggerId,
        cron_id: 12,
        state: 'finished',
        reason: null,
        exit_code: 0,
      },
    ],
    log: {
      code: 200,
      triggerId,
      data: 'this run\nlast line\n',
      logStatus: 'completed',
    },
    polls: 0,
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost');
    requests.push({
      path: url.pathname,
      query: url.searchParams,
      method: req.method,
      body,
    });
    assert.equal(req.headers.authorization, 'Bearer fixture');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/panel/open/crons/run') {
      assert.equal(req.method, 'PUT');
      assert.equal(body, '[12]');
      return res.end(JSON.stringify({ code: 200, data: state.run }));
    }
    if (url.pathname === '/panel/open/crons/12/triggers') {
      assert.equal(url.searchParams.get('ids'), triggerId);
      state.polls++;
      if (state.hang) return;
      if (state.denied) {
        res.statusCode = 403;
        return res.end('{}');
      }
      if (state.disconnect) return req.socket.destroy();
      const data =
        state.polls <= (state.pending || 0)
          ? [
              {
                id: triggerId,
                cron_id: 12,
                state: 'running',
                reason: null,
                exit_code: null,
              },
            ]
          : state.rows;
      return res.end(JSON.stringify({ code: 200, data }));
    }
    if (url.pathname === '/panel/open/crons/12/log')
      return res.end(JSON.stringify(state.log));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const invoke = (args, language = 'en') =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, ...args, '--json'], {
        env: {
          PATH: process.env.PATH,
          QL_URL: `http://127.0.0.1:${server.address().port}/panel`,
          QL_ACCESS_TOKEN: 'fixture',
          QL_LANG: language,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '',
        err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));
    });
  return { state, requests, invoke };
}

function failure(result, code = 1) {
  assert.equal(result.code, code, result.err);
  assert.equal(result.out, '');
  const error = JSON.parse(result.err);
  assert.equal(error.code, code);
  return error;
}

test('immediate run exposes its receipt and remains compatible with older panels', async (t) => {
  const f = await fixture(t);
  let result = await f.invoke(['task', 'run', '12']);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out).data, {
    taskId: 12,
    action: 'run',
    accepted: true,
    triggerId,
    state: 'queued',
    reason: null,
  });
  assert.equal(f.state.polls, 0);
  for (const data of [undefined, null]) {
    f.state.run = data;
    result = await f.invoke(['task', 'run', '12']);
    assert.deepEqual(JSON.parse(result.out).data, {
      taskId: 12,
      action: 'run',
      accepted: true,
    });
    const error = failure(await f.invoke(['task', 'run', '12', '--wait']));
    assert.match(
      error.message,
      /submitted.*no triggerId.*do not blindly retry/,
    );
  }
  assert.equal(f.state.polls, 0);
  assert.equal(f.requests.length, 5); // Exactly one mutation per invocation, never replayed.
});

test('wait polls only the returned trigger and logs read exactly that run', async (t) => {
  const f = await fixture(t);
  f.state.pending = 1;
  const result = await f.invoke([
    'task',
    'run',
    '12',
    '--wait',
    '--timeout',
    '5',
  ]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out).data, {
    taskId: 12,
    action: 'run',
    accepted: true,
    triggerId,
    state: 'finished',
    reason: null,
    exitCode: 0,
  });
  assert.equal(f.state.polls, 2);
  assert.equal(f.requests.filter((r) => r.method === 'PUT').length, 1);
  const log = await f.invoke([
    'task',
    'logs',
    '12',
    '--trigger-id',
    triggerId,
    '--tail',
    '1',
  ]);
  assert.equal(log.code, 0, log.err);
  assert.deepEqual(JSON.parse(log.out), {
    code: 200,
    data: 'last line',
    triggerId,
    logStatus: 'completed',
    truncated: true,
  });
  assert.equal(f.requests.at(-1).query.get('triggerId'), triggerId);
});

test('each non-success terminal state returns structured outcome and never reruns', async (t) => {
  const f = await fixture(t);
  for (const [state, reason, exit_code] of [
    ['failed', 'exit', 17],
    ['skipped', 'overlap', null],
    ['stopped', 'manual', null],
    ['unknown', 'restart', null],
    ['finished', 'exit_pending', null],
  ]) {
    f.state.rows = [{ id: triggerId, cron_id: 12, state, reason, exit_code }];
    const error = failure(
      await f.invoke(['task', 'wait', '12', '--trigger-id', triggerId]),
    );
    assert.deepEqual(error.data, {
      taskId: 12,
      action: 'wait',
      triggerId,
      state,
      reason,
      exitCode: exit_code,
    });
  }
  assert.ok(f.requests.every((r) => r.method === 'GET'));
});

test('timeouts bound polling and in-flight reads, retain the trigger and never stop it', async (t) => {
  for (const hang of [false, true]) {
    const f = await fixture(t);
    f.state.pending = Infinity;
    f.state.hang = hang;
    const start = Date.now();
    const error = failure(
      await f.invoke(['task', 'run', '12', '--wait', '--timeout', '1']),
    );
    assert.equal(error.data.triggerId, triggerId);
    assert.equal(error.data.waitStatus, 'timeout');
    assert.ok(Date.now() - start < 5000);
    assert.equal(f.requests.filter((r) => r.method === 'PUT').length, 1);
    f.state.pending = 0;
    f.state.hang = false;
    const resumed = await f.invoke([
      'task',
      'wait',
      '12',
      '--trigger-id',
      triggerId,
    ]);
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(JSON.parse(resumed.out).data.action, 'wait');
    assert.equal(f.requests.filter((r) => r.method === 'PUT').length, 1);
  }
});

test('missing, mismatched or malformed receipts never fall back to the latest run', async (t) => {
  const f = await fixture(t);
  for (const rows of [
    [],
    [{ id: 'sibling', cron_id: 12 }],
    [{ id: triggerId, cron_id: 13 }],
    [{ ...f.state.rows[0], state: 'invalid' }],
    [{ ...f.state.rows[0], state: ['finished'] }],
    [{ ...f.state.rows[0], exit_code: '0' }],
    { data: [] },
    [f.state.rows[0], f.state.rows[0]],
  ]) {
    f.state.rows = rows;
    const error = failure(
      await f.invoke(['task', 'wait', '12', '--trigger-id', triggerId]),
    );
    assert.equal(error.data.triggerId, triggerId);
    assert.ok(['invalidResponse', 'notFound'].includes(error.data.waitStatus));
  }
  for (const data of [
    [],
    {},
    [{ taskId: 13, triggerId }],
    [{ taskId: 12, triggerId: 'bad id', state: 'queued', reason: null }],
  ]) {
    f.state.run = data;
    failure(await f.invoke(['task', 'run', '12', '--wait']));
  }
});

test('legacy or mismatched log responses are rejected only when selecting a trigger', async (t) => {
  const f = await fixture(t);
  for (const id of [undefined, 'another-trigger']) {
    f.state.log.triggerId = id;
    const result = await f.invoke([
      'task',
      'logs',
      '12',
      '--trigger-id',
      triggerId,
    ]);
    assert.match(failure(result).message, /did not confirm the log trigger ID/);
    const latest = await f.invoke(['task', 'logs', '12']);
    assert.equal(latest.code, 0, latest.err);
    assert.equal(JSON.parse(latest.out).triggerId, undefined);
    assert.equal(f.requests.at(-1).query.has('triggerId'), false);
  }
});

test('auth and network failures retain the trigger without replaying mutations', async (t) => {
  for (const mode of ['denied', 'disconnect']) {
    const f = await fixture(t);
    f.state[mode] = true;
    const error = failure(
      await f.invoke(['task', 'run', '12', '--wait']),
      mode === 'denied' ? 3 : 1,
    );
    assert.equal(error.data.triggerId, triggerId);
    assert.equal(error.data.waitStatus, 'interrupted');
    assert.equal(f.requests.length, 2);
    assert.doesNotMatch(JSON.stringify(error), /Bearer fixture/);
  }
});

test('new option validation happens before any network access and errors are bilingual', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['task', 'run', '12', '--timeout', '10'],
    ['task', 'run', '12', '--wait', '--timeout', '0'],
    ['task', 'run', '12', '--wait', '--timeout', '86401'],
    ['task', 'wait', '12'],
    ['task', 'wait', '12', '--trigger-id', 'bad id'],
    ['task', 'logs', '12', '--trigger-id', 'a'.repeat(257)],
  ])
    failure(await f.invoke(args), 2);
  assert.equal(f.requests.length, 0);
  f.state.rows = [];
  const error = failure(
    await f.invoke(['task', 'wait', '12', '--trigger-id', triggerId], 'zh'),
  );
  assert.match(error.message, /不存在、已清理或不属于该任务/);
});
