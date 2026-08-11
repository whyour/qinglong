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
      const json = ['run.cancel', 'task.start'].includes(
        value.operation.operationId,
      );
      return {
        bodyMode: json ? 'json' : 'none',
        maximumBodyBytes: json ? 512 : 0,
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
        value.operation.operationId === 'task.start'
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
  assert.deepEqual(observed[6].operation, {
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
  assert.deepEqual(observed[7].operation, {
    operationId: 'task.start',
    projectId: 'prj_default',
    taskId: 'task_1',
  });

  const log = await request(
    port,
    '/api/v3/projects/prj_default/runs/run_123/attempts/attempt_1/log?offset=4&length=32',
  );
  assert.deepEqual(log.body, { range: { offset: 4, length: 32 } });
  assert.deepEqual(observed[8].operation, {
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
  assert.equal(observed.length, 10);
  assert.deepEqual(
    await Promise.all([surface.stopAndDrain(), surface.stopAndDrain()]),
    ['stopped', 'stopped'],
  );
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
