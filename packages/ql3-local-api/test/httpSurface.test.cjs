const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { test } = require('node:test');

const {
  startLocalApiHttpSurface,
} = require('../dist/transport/httpSurface.js');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? { authorization: 'Bearer opaque' },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
      },
    );
    outgoing.once('error', reject);
    if (options.body) outgoing.write(options.body);
    outgoing.end();
  });
}

function preparedAdmission(handler) {
  return {
    async prepare(value) {
      const json = [
        'run.cancel',
        'task.start',
        'task.put',
        'secret.put',
      ].includes(value.operation.operationId);
      return {
        bodyMode: json ? 'json' : 'none',
        maximumBodyBytes:
          value.operation.operationId === 'task.put'
            ? 72 * 1024
            : value.operation.operationId === 'secret.put'
            ? 20 * 1024
            : json
            ? 512
            : 0,
        handle(body) {
          return handler(value, body);
        },
      };
    },
  };
}

test('serves only the fixed canonical loopback Run route and drains idempotently', async (t) => {
  const port = await reservePort();
  const observed = [];
  const surface = await startLocalApiHttpSurface({
    profile: 'edge',
    host: '127.0.0.1',
    port,
    admission: preparedAdmission(async (value, body) => {
      observed.push(value);
      if (
        value.operation.operationId === 'run.cancel' ||
        value.operation.operationId === 'task.start' ||
        value.operation.operationId === 'task.put' ||
        value.operation.operationId === 'secret.put'
      ) {
        return { statusCode: 202, body: { accepted: body } };
      }
      if (value.operation.operationId === 'run.get') {
        return {
          statusCode: 200,
          body: { run: { id: value.operation.runId } },
        };
      }
      if (value.operation.operationId === 'run.events.list') {
        return {
          statusCode: 200,
          body: {
            events: [],
            hasMore: false,
            nextAfterSequence: value.operation.input.afterSequence ?? 0,
          },
        };
      }
      if (value.operation.operationId === 'run.steps.list') {
        return {
          statusCode: 200,
          body: {
            steps: [],
            hasMore: false,
            next: value.operation.input.after ?? null,
          },
        };
      }
      if (value.operation.operationId === 'run.log.read') {
        return {
          statusCode: 200,
          body: {
            range: {
              offset: value.operation.offset,
              length: value.operation.length,
            },
          },
        };
      }
      if (value.operation.operationId === 'task.list') {
        return {
          statusCode: 200,
          body: {
            tasks: [],
            hasMore: false,
            input: value.operation.input,
          },
        };
      }
      if (value.operation.operationId === 'task.get') {
        return {
          statusCode: 200,
          body: { task: { taskId: value.operation.taskId } },
        };
      }
      if (value.operation.operationId === 'secret.list') {
        return {
          statusCode: 200,
          body: { secrets: [], truncated: false },
        };
      }
      if (value.operation.operationId === 'panel.cron.list') {
        return {
          statusCode: 200,
          body: {
            code: 200,
            data: { data: [], total: 0 },
            input: value.operation,
          },
        };
      }
      return {
        statusCode: 200,
        body: { runs: [], hasMore: false, input: value.operation.input },
      };
    }),
    randomUuid: () => '019f70c0-0000-4000-8000-000000000003',
  });
  t.after(() => surface.stopAndDrain());

  const accepted = await request(
    port,
    '/api/v3/projects/prj_default/runs/run_123',
  );
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.body, { run: { id: 'run_123' } });
  assert.equal(accepted.headers['cache-control'], 'no-store');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].authorization, 'Bearer opaque');
  assert.deepEqual(observed[0].operation, {
    operationId: 'run.get',
    projectId: 'prj_default',
    runId: 'run_123',
  });

  const listed = await request(
    port,
    '/api/v3/projects/prj_default/runs?limit=8&after_created_at_ms=100&after_run_id=run_100',
  );
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.body, {
    runs: [],
    hasMore: false,
    input: {
      limit: 8,
      after: { createdAtMs: 100, runId: 'run_100' },
    },
  });
  assert.equal(observed[1].operation.operationId, 'run.list');

  const events = await request(
    port,
    '/api/v3/projects/prj_default/runs/run_123/events?after_sequence=7&limit=8',
  );
  assert.deepEqual(events.body, {
    events: [],
    hasMore: false,
    nextAfterSequence: 7,
  });
  assert.deepEqual(observed[2].operation, {
    operationId: 'run.events.list',
    projectId: 'prj_default',
    runId: 'run_123',
    input: { afterSequence: 7, limit: 8 },
  });

  const steps = await request(
    port,
    '/api/v3/projects/prj_default/runs/run_123/steps?after_step_key=build&after_step_run_id=step_1&limit=8',
  );
  assert.deepEqual(steps.body, {
    steps: [],
    hasMore: false,
    next: { stepKey: 'build', stepRunId: 'step_1' },
  });
  assert.deepEqual(observed[3].operation, {
    operationId: 'run.steps.list',
    projectId: 'prj_default',
    runId: 'run_123',
    input: {
      after: { stepKey: 'build', stepRunId: 'step_1' },
      limit: 8,
    },
  });

  const tasks = await request(
    port,
    '/api/v3/projects/prj_default/tasks?after_task_id=task_100&limit=8',
  );
  assert.deepEqual(tasks.body, {
    tasks: [],
    hasMore: false,
    input: { after: { taskId: 'task_100' }, limit: 8 },
  });
  assert.deepEqual(observed[4].operation, {
    operationId: 'task.list',
    projectId: 'prj_default',
    input: { after: { taskId: 'task_100' }, limit: 8 },
  });

  const task = await request(port, '/api/v3/projects/prj_default/tasks/task_1');
  assert.deepEqual(task.body, { task: { taskId: 'task_1' } });
  assert.deepEqual(observed[5].operation, {
    operationId: 'task.get',
    projectId: 'prj_default',
    taskId: 'task_1',
  });

  const panelCrons = await request(
    port,
    '/api/crons?searchValue=&page=1&size=20&filters=%7B%7D&t=100',
  );
  assert.equal(panelCrons.statusCode, 200);
  assert.deepEqual(panelCrons.body, {
    code: 200,
    data: { data: [], total: 0 },
    input: {
      operationId: 'panel.cron.list',
      projectId: 'default',
      page: 1,
      size: 20,
      maximumRows: 64,
    },
  });
  assert.deepEqual(observed[6].operation, panelCrons.body.input);

  const finalEdgePage = await request(
    port,
    '/api/crons?searchValue=&page=4&size=20&filters=%7B%7D',
  );
  assert.equal(finalEdgePage.statusCode, 200);
  assert.equal(finalEdgePage.body.input.maximumRows, 64);
  assert.equal(finalEdgePage.body.input.page, 4);

  const unsupportedPanelQuery = await request(
    port,
    '/api/crons?searchValue=private&page=1&size=20&filters=%7B%7D',
  );
  assert.deepEqual(unsupportedPanelQuery.body, {
    code: 'invalid_panel_cron_list_query',
  });
  assert.equal(unsupportedPanelQuery.statusCode, 400);
  assert.equal(observed.length, 8);

  const cancellationBody = JSON.stringify({
    schema: 'qinglong/run-cancellation@v1',
    mutationId: 'mutation-1',
  });
  const cancellation = await request(
    port,
    '/api/v3/projects/prj_default/runs/run_123/cancellation',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer opaque',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(cancellationBody)),
      },
      body: cancellationBody,
    },
  );
  assert.equal(cancellation.statusCode, 202);
  assert.deepEqual(cancellation.body.accepted, JSON.parse(cancellationBody));
  assert.deepEqual(observed[8].operation, {
    operationId: 'run.cancel',
    projectId: 'prj_default',
    runId: 'run_123',
  });

  const taskStartBody = JSON.stringify({
    schema: 'qinglong/task-start@v1',
    mutationId: '019f7300-0000-7000-8000-000000000800',
    expectedRevision: 7,
    expectedContentDigest: 'a'.repeat(64),
  });
  const taskStart = await request(
    port,
    '/api/v3/projects/prj_default/tasks/task_1/runs',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer opaque',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(taskStartBody)),
      },
      body: taskStartBody,
    },
  );
  assert.equal(taskStart.statusCode, 202);
  assert.deepEqual(taskStart.body.accepted, JSON.parse(taskStartBody));
  assert.deepEqual(observed[9].operation, {
    operationId: 'task.start',
    projectId: 'prj_default',
    taskId: 'task_1',
  });

  const taskPutBody = JSON.stringify({ name: 'Task one' });
  const taskPut = await request(
    port,
    '/api/v3/projects/prj_default/tasks/task_1',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer opaque',
        'x-qinglong-local-presence': 'ql3p_request_bound_proof',
        'x-qinglong-task-authoring-lease': 'ql3a_exact_snapshot_lease',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(taskPutBody)),
      },
      body: taskPutBody,
    },
  );
  assert.equal(taskPut.statusCode, 202);
  assert.deepEqual(taskPut.body.accepted, JSON.parse(taskPutBody));
  assert.deepEqual(observed[10].operation, {
    operationId: 'task.put',
    projectId: 'prj_default',
    taskId: 'task_1',
  });
  assert.equal(observed[10].localPresence, 'ql3p_request_bound_proof');
  assert.equal(observed[10].taskAuthoringLease, 'ql3a_exact_snapshot_lease');

  const log = await request(
    port,
    '/api/v3/projects/prj_default/runs/run_123/attempts/attempt_1/log?offset=4&length=32',
  );
  assert.deepEqual(log.body, { range: { offset: 4, length: 32 } });
  assert.deepEqual(observed[11].operation, {
    operationId: 'run.log.read',
    projectId: 'prj_default',
    runId: 'run_123',
    attemptId: 'attempt_1',
    offset: 4,
    length: 32,
  });

  const defaultLog = await request(
    port,
    '/api/v3/projects/prj_default/runs/run_123/attempts/attempt_1/log',
  );
  assert.deepEqual(defaultLog.body, {
    range: { offset: 0, length: 16 * 1024 },
  });

  const authoring = await request(
    port,
    '/api/v3/projects/prj_default/tasks/task_1/authoring',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer opaque',
        'x-qinglong-local-presence': 'ql3p_authoring_read_proof',
      },
    },
  );
  assert.equal(authoring.statusCode, 200);
  assert.deepEqual(observed[13].operation, {
    operationId: 'task.authoring',
    projectId: 'prj_default',
    taskId: 'task_1',
  });
  assert.equal(observed[13].localPresence, 'ql3p_authoring_read_proof');

  const secrets = await request(
    port,
    '/api/v3/projects/prj_default/secrets?limit=8&after=YWxwaGE',
  );
  assert.deepEqual(secrets.body, { secrets: [], truncated: false });
  assert.deepEqual(observed[14].operation, {
    operationId: 'secret.list',
    projectId: 'prj_default',
    limit: 8,
    after: { name: 'alpha' },
  });

  const secretPutBody = JSON.stringify({ name: 'github-token' });
  const secretPut = await request(
    port,
    '/api/v3/projects/prj_default/secrets',
    {
      method: 'PUT',
      headers: {
        authorization: 'Bearer opaque',
        'x-qinglong-local-presence': 'ql3p_secret_bound_proof',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(secretPutBody)),
      },
      body: secretPutBody,
    },
  );
  assert.equal(secretPut.statusCode, 202);
  assert.deepEqual(secretPut.body.accepted, JSON.parse(secretPutBody));
  assert.deepEqual(observed[15].operation, {
    operationId: 'secret.put',
    projectId: 'prj_default',
  });
  assert.equal(observed[15].localPresence, 'ql3p_secret_bound_proof');

  for (const invalidPath of [
    '/api/v3/projects/prj_default/runs/run_123?expanded=true',
    '/api/v3/projects/prj_default/runs/run%5f123',
    '/api/v3/projects/prj_default/tasks/task_1?expanded=true',
    '/api/v3/projects/prj_default/tasks/task%5f1',
    '/api/v3/projects/prj_default/tasks/task_1/runs?expanded=true',
    '/api/v3/projects/prj_default/tasks?after_task_id=%74ask_1',
  ]) {
    assert.deepEqual((await request(port, invalidPath)).body, {
      code: 'route_not_found',
    });
  }
  for (const invalidQuery of [
    '/api/v3/projects/prj_default/runs?',
    '/api/v3/projects/prj_default/runs?limit=08',
    '/api/v3/projects/prj_default/runs?limit=65',
    '/api/v3/projects/prj_default/runs?limit=8&limit=9',
    '/api/v3/projects/prj_default/runs?after_run_id=run_100',
    '/api/v3/projects/prj_default/runs?unknown=value',
  ]) {
    const invalid = await request(port, invalidQuery);
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.body, { code: 'invalid_run_list_query' });
  }
  for (const invalidQuery of [
    '/api/v3/projects/prj_default/runs/run_123/attempts/attempt_1/log?',
    '/api/v3/projects/prj_default/runs/run_123/attempts/attempt_1/log?offset=-1',
    '/api/v3/projects/prj_default/runs/run_123/attempts/attempt_1/log?offset=04',
    '/api/v3/projects/prj_default/runs/run_123/attempts/attempt_1/log?length=0',
    '/api/v3/projects/prj_default/runs/run_123/attempts/attempt_1/log?length=32769',
    '/api/v3/projects/prj_default/runs/run_123/attempts/attempt_1/log?unknown=1',
  ]) {
    const invalid = await request(port, invalidQuery);
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.body, { code: 'invalid_run_log_read_query' });
  }
  for (const invalidQuery of [
    '/api/v3/projects/prj_default/tasks?',
    '/api/v3/projects/prj_default/tasks?limit=08',
    '/api/v3/projects/prj_default/tasks?limit=65',
    '/api/v3/projects/prj_default/tasks?unknown=value',
  ]) {
    const invalid = await request(port, invalidQuery);
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.body, { code: 'invalid_task_list_query' });
  }
  for (const invalidQuery of [
    '/api/v3/projects/prj_default/secrets?',
    '/api/v3/projects/prj_default/secrets?limit=08',
    '/api/v3/projects/prj_default/secrets?limit=65',
    '/api/v3/projects/prj_default/secrets?after=Y',
    '/api/v3/projects/prj_default/secrets?unknown=value',
  ]) {
    const invalid = await request(port, invalidQuery);
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.body, { code: 'invalid_secret_list_query' });
  }
  for (const invalidQuery of [
    '/api/v3/projects/prj_default/runs/run_123/events?',
    '/api/v3/projects/prj_default/runs/run_123/events?after_sequence=07',
    '/api/v3/projects/prj_default/runs/run_123/events?after_sequence=-1',
    '/api/v3/projects/prj_default/runs/run_123/events?limit=65',
    '/api/v3/projects/prj_default/runs/run_123/events?unknown=value',
  ]) {
    const invalid = await request(port, invalidQuery);
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.body, { code: 'invalid_run_event_list_query' });
  }
  for (const invalidQuery of [
    '/api/v3/projects/prj_default/runs/run_123/steps?',
    '/api/v3/projects/prj_default/runs/run_123/steps?after_step_key=build',
    '/api/v3/projects/prj_default/runs/run_123/steps?after_step_run_id=step_1',
    '/api/v3/projects/prj_default/runs/run_123/steps?after_step_key=-bad&after_step_run_id=step_1',
    '/api/v3/projects/prj_default/runs/run_123/steps?limit=65',
    '/api/v3/projects/prj_default/runs/run_123/steps?unknown=value',
  ]) {
    const invalid = await request(port, invalidQuery);
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.body, { code: 'invalid_run_step_list_query' });
  }
  assert.equal(observed.length, 16);
  assert.deepEqual(
    await Promise.all([surface.stopAndDrain(), surface.stopAndDrain()]),
    ['stopped', 'stopped'],
  );
});

test('serves the public capability shell and authenticates private panel bootstrap reads', async (t) => {
  const port = await reservePort();
  const observed = [];
  const surface = await startLocalApiHttpSurface({
    profile: 'edge',
    host: '127.0.0.1',
    port,
    admission: preparedAdmission(async (value) => {
      observed.push(value);
      return {
        statusCode: 200,
        body: {
          code: 200,
          data: { operationId: value.operation.operationId },
        },
      };
    }),
    randomUuid: () => '019f70c0-0000-4000-8000-000000000013',
  });
  t.after(() => surface.stopAndDrain());

  const health = await request(port, '/api/health?t=100', { headers: {} });
  assert.equal(health.statusCode, 200);
  assert.equal(health.body.data.status, 'ok');
  assert.equal(health.body.data.ql3.capabilitiesPath, '/api/v3/capabilities');

  const system = await request(port, '/api/system', { headers: {} });
  assert.equal(system.statusCode, 200);
  assert.equal(system.body.data.isInitialized, true);
  assert.equal(system.body.data.ql3.profile, 'edge');

  const capabilities = await request(port, '/api/v3/capabilities?t=101', {
    headers: {},
  });
  assert.equal(capabilities.statusCode, 200);
  assert.equal(
    capabilities.body.capabilities.authentication.loginEndpoint,
    null,
  );
  assert.equal(capabilities.body.capabilities.panel.legacyLogin, false);
  assert.equal(capabilities.body.capabilities.limits.cronRows, 64);
  assert.equal(observed.length, 0);

  const user = await request(port, '/api/user?t=102');
  assert.deepEqual(user.body, {
    code: 200,
    data: { operationId: 'panel.user.get' },
  });
  assert.deepEqual(observed[0].operation, {
    operationId: 'panel.user.get',
    projectId: 'default',
  });

  const config = await request(port, '/api/system/config?t=103');
  assert.deepEqual(config.body, {
    code: 200,
    data: { operationId: 'panel.system.config.get' },
  });
  assert.deepEqual(observed[1].operation, {
    operationId: 'panel.system.config.get',
    projectId: 'default',
  });

  const invalid = await request(port, '/api/system?search=wide', {
    headers: {},
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.body, { code: 'invalid_panel_bootstrap_query' });
  const encoded = await request(port, '/api/%73ystem', { headers: {} });
  assert.equal(encoded.statusCode, 404);
  assert.equal(observed.length, 2);
});

test('rejects GET bodies without invoking the prepared route handler', async (t) => {
  const port = await reservePort();
  let handlers = 0;
  const surface = await startLocalApiHttpSurface({
    profile: 'standalone',
    host: '127.0.0.1',
    port,
    admission: preparedAdmission(async () => {
      handlers += 1;
      return { statusCode: 200, body: {} };
    }),
  });
  t.after(() => surface.stopAndDrain());
  const response = await request(
    port,
    '/api/v3/projects/prj_default/runs/run_123',
    {
      headers: {
        authorization: 'Bearer opaque',
        'content-length': '1',
      },
      body: 'x',
    },
  );
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { code: 'invalid_request_body' });
  assert.equal(handlers, 0);
});

test('authenticates before reading a strictly bounded cancellation JSON body', async (t) => {
  const port = await reservePort();
  const events = [];
  const surface = await startLocalApiHttpSurface({
    profile: 'edge',
    host: '127.0.0.1',
    port,
    admission: {
      async prepare(value) {
        events.push(`prepare:${value.operation.operationId}`);
        return {
          bodyMode: 'json',
          maximumBodyBytes: 512,
          handle(body) {
            events.push(`handle:${body.mutationId}`);
            return { statusCode: 202, body };
          },
        };
      },
    },
  });
  t.after(() => surface.stopAndDrain());
  const body = JSON.stringify({
    schema: 'qinglong/run-cancellation@v1',
    mutationId: 'mutation-1',
  });
  const accepted = await request(
    port,
    '/api/v3/projects/prj_default/runs/run_123/cancellation',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer opaque',
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    },
  );
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(events, ['prepare:run.cancel', 'handle:mutation-1']);

  for (const [headers, payload, statusCode, code] of [
    [
      {
        authorization: 'Bearer opaque',
        'content-type': 'text/plain',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
      400,
      'invalid_request_body',
    ],
    [
      {
        authorization: 'Bearer opaque',
        'content-type': 'application/json',
        'content-length': '513',
      },
      'x'.repeat(513),
      413,
      'request_body_too_large',
    ],
    [
      {
        authorization: 'Bearer opaque',
        'content-type': 'application/json',
        'content-length': '1',
      },
      '{',
      400,
      'invalid_request_body',
    ],
  ]) {
    const rejected = await request(
      port,
      '/api/v3/projects/prj_default/runs/run_123/cancellation',
      { method: 'POST', headers, body: payload },
    );
    assert.equal(rejected.statusCode, statusCode);
    assert.deepEqual(rejected.body, { code });
  }
  assert.equal(events.filter((event) => event.startsWith('handle:')).length, 1);
});

test('serves the reviewed worst-case 64-item Run list inside the fixed response cap', async (t) => {
  const port = await reservePort();
  const text255 = 'x'.repeat(255);
  const id128 = 'x'.repeat(128);
  const item = Object.freeze({
    id: id128,
    taskId: text255,
    taskRevision: text255,
    status: 'succeeded',
    version: 2_147_483_647,
    eventSequence: 2_147_483_647,
    priority: -2_147_483_648,
    executionOrigin: 'scheduled_system',
    executionOwner: 'runtime',
    createdAtMs: Number.MAX_SAFE_INTEGER,
    queuedAtMs: Number.MAX_SAFE_INTEGER,
    startedAtMs: Number.MAX_SAFE_INTEGER,
    finishedAtMs: Number.MAX_SAFE_INTEGER,
  });
  const surface = await startLocalApiHttpSurface({
    profile: 'edge',
    host: '127.0.0.1',
    port,
    admission: preparedAdmission(async () => {
      return {
        statusCode: 200,
        body: {
          runs: Object.freeze(Array.from({ length: 64 }, () => item)),
          hasMore: true,
          next: { createdAtMs: Number.MAX_SAFE_INTEGER, runId: id128 },
        },
      };
    }),
  });
  t.after(() => surface.stopAndDrain());
  const response = await request(
    port,
    '/api/v3/projects/prj_default/runs?limit=64',
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.runs.length, 64);
  assert.equal(Number(response.headers['content-length']), 61_516);
});

test('serves the reviewed worst-case 64-item Task list inside the fixed response cap', async (t) => {
  const port = await reservePort();
  const id128 = 'x'.repeat(128);
  const item = Object.freeze({
    taskId: id128,
    revision: 2_147_483_647,
    name: 'x'.repeat(255),
    kind: 'workflow',
    specSchema: `${'x'.repeat(64)}/${'x'.repeat(64)}@v999999`,
    enabled: false,
    updatedAtMs: Number.MAX_SAFE_INTEGER,
  });
  const surface = await startLocalApiHttpSurface({
    profile: 'edge',
    host: '127.0.0.1',
    port,
    admission: preparedAdmission(async () => ({
      statusCode: 200,
      body: {
        tasks: Object.freeze(Array.from({ length: 64 }, () => item)),
        hasMore: true,
        next: { taskId: id128 },
      },
    })),
  });
  t.after(() => surface.stopAndDrain());
  const response = await request(
    port,
    '/api/v3/projects/prj_default/tasks?limit=64',
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.tasks.length, 64);
  assert.ok(Number(response.headers['content-length']) < 64 * 1_024);
});

test('serves the reviewed worst-case 64-item RunEvent list inside the fixed response cap', async (t) => {
  const port = await reservePort();
  const event = Object.freeze({
    sequence: 2_147_483_647,
    type: 'x'.repeat(128),
    actorType: 'system',
    createdAtMs: Number.MAX_SAFE_INTEGER,
  });
  const surface = await startLocalApiHttpSurface({
    profile: 'edge',
    host: '127.0.0.1',
    port,
    admission: preparedAdmission(async () => {
      return {
        statusCode: 200,
        body: {
          events: Object.freeze(Array.from({ length: 64 }, () => event)),
          hasMore: true,
          nextAfterSequence: event.sequence,
        },
      };
    }),
  });
  t.after(() => surface.stopAndDrain());
  const response = await request(
    port,
    '/api/v3/projects/prj_default/runs/run_123/events?limit=64',
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.events.length, 64);
  assert.equal(Number(response.headers['content-length']), 13_754);
});

test('serves the reviewed worst-case 64-item Run Step list inside the fixed response cap', async (t) => {
  const port = await reservePort();
  const id128 = 'x'.repeat(128);
  const item = Object.freeze({
    id: id128,
    parentStepRunId: id128,
    stepKey: id128,
    kind: 'tool',
    required: true,
    status: 'waiting_approval',
    version: 2_147_483_647,
    attemptCount: 64,
    readyAtMs: Number.MAX_SAFE_INTEGER,
    startedAtMs: Number.MAX_SAFE_INTEGER,
    finishedAtMs: Number.MAX_SAFE_INTEGER,
    resultCode: 'x'.repeat(64),
    createdAtMs: Number.MAX_SAFE_INTEGER,
    updatedAtMs: Number.MAX_SAFE_INTEGER,
  });
  const surface = await startLocalApiHttpSurface({
    profile: 'edge',
    host: '127.0.0.1',
    port,
    admission: preparedAdmission(async () => {
      return {
        statusCode: 200,
        body: {
          steps: Object.freeze(Array.from({ length: 64 }, () => item)),
          hasMore: true,
          next: { stepKey: id128, stepRunId: id128 },
        },
      };
    }),
  });
  t.after(() => surface.stopAndDrain());
  const response = await request(
    port,
    '/api/v3/projects/prj_default/runs/run_123/steps?limit=64',
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.steps.length, 64);
  assert.ok(Number(response.headers['content-length']) < 65_536);
});

test('serves one maximum-size Task authoring snapshot inside the bounded response cap', async (t) => {
  const port = await reservePort();
  const surface = await startLocalApiHttpSurface({
    profile: 'edge',
    host: '127.0.0.1',
    port,
    admission: preparedAdmission(async (value) => ({
      statusCode: 200,
      body: {
        task: {
          taskId: value.operation.taskId,
          spec: {
            schema: 'qinglong/command@v1',
            payload: 'x'.repeat(64 * 1024),
          },
        },
      },
    })),
  });
  t.after(() => surface.stopAndDrain());
  const response = await request(
    port,
    '/api/v3/projects/default/tasks/task-large/authoring',
    { method: 'POST' },
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.task.taskId, 'task-large');
  assert.ok(Number(response.headers['content-length']) > 64 * 1024);
  assert.ok(Number(response.headers['content-length']) < 80 * 1024);
});

test('bounds Edge admission concurrency and drains accepted work', async (t) => {
  const port = await reservePort();
  let admissions = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const surface = await startLocalApiHttpSurface({
    profile: 'edge',
    host: '127.0.0.1',
    port,
    admission: preparedAdmission(async (value) => {
      admissions += 1;
      await barrier;
      return {
        statusCode: 200,
        body: { run: { id: value.operation.runId } },
      };
    }),
  });
  t.after(() => surface.stopAndDrain());
  const accepted = Array.from({ length: 4 }, () =>
    request(port, '/api/v3/projects/prj_default/runs/run_123'),
  );
  while (admissions < 4) await new Promise((resolve) => setImmediate(resolve));

  const overloaded = await request(
    port,
    '/api/v3/projects/prj_default/runs/run_123',
  );
  assert.equal(overloaded.statusCode, 503);
  assert.deepEqual(overloaded.body, { code: 'server_overloaded' });
  assert.equal(admissions, 4);

  const stopping = surface.stopAndDrain();
  release();
  assert.deepEqual(
    (await Promise.all(accepted)).map(({ statusCode }) => statusCode),
    [200, 200, 200, 200],
  );
  assert.equal(await stopping, 'stopped');
});
