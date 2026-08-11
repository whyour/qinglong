const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createLocalApiAdmission,
} = require('../dist/admission/localApiAdmission.js');

const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'usr_local' }),
  authenticationId: 'credential:local',
  authenticatedAtMs: 9_000,
  expiresAtMs: 11_000,
  assurance: 'single_factor',
});

function request(overrides = {}) {
  return Object.freeze({
    requestId: 'local:019f70c0-0000-7000-8000-000000000001',
    operation: Object.freeze({
      operationId: 'run.get',
      projectId: 'prj_default',
      runId: 'run_123',
    }),
    authorization: 'Bearer opaque',
    signal: new AbortController().signal,
    ...overrides,
  });
}

function fixture(overrides = {}) {
  const events = [];
  const options = {
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return Object.freeze({
          principal: PRINCIPAL,
          async confirm() {
            events.push('confirm');
          },
        });
      },
    },
    policy: {
      async authorize(principal, projectId, permission) {
        assert.equal(principal, PRINCIPAL);
        events.push(`authorize:${permission}:${projectId}`);
        return {
          effect: 'allow',
          reasons: ['role_grant'],
          fence: { projectVersion: 2, bindingVersion: 3 },
        };
      },
    },
    audit: {
      async record(record) {
        events.push(`audit:${record.outcome}:${record.operationId}`);
      },
    },
    runReadRoute: {
      async handle(value) {
        events.push(`route:${value.projectId}:${value.runId}`);
        return { statusCode: 200, body: { run: { id: value.runId } } };
      },
    },
    runListRoute: {
      async handle(value) {
        events.push(`list:${value.projectId}:${value.input.limit ?? 32}`);
        return { statusCode: 200, body: { runs: [], hasMore: false } };
      },
    },
    runEventListRoute: {
      async handle(value) {
        events.push(
          `events:${value.projectId}:${value.runId}:${
            value.input.afterSequence ?? 0
          }`,
        );
        return {
          statusCode: 200,
          body: { events: [], hasMore: false, nextAfterSequence: 0 },
        };
      },
    },
    runStepListRoute: {
      async handle(value) {
        events.push(
          `steps:${value.projectId}:${value.runId}:${
            value.input.after?.stepKey ?? 'start'
          }`,
        );
        return {
          statusCode: 200,
          body: { steps: [], hasMore: false, next: null },
        };
      },
    },
    runCancellationRoute: {
      async handle(value) {
        events.push(`cancel:${value.projectId}:${value.runId}`);
        return { statusCode: 202, body: { status: 'accepted' } };
      },
    },
    taskListRoute: {
      async handle(value) {
        events.push(`tasks:${value.projectId}:${value.input.limit ?? 32}`);
        return { statusCode: 200, body: { tasks: [], hasMore: false } };
      },
    },
    taskReadRoute: {
      async handle(value) {
        events.push(`task:${value.projectId}:${value.taskId}`);
        return { statusCode: 200, body: { task: { taskId: value.taskId } } };
      },
    },
    taskStartRoute: {
      async handle(value) {
        events.push(`task-start:${value.projectId}:${value.taskId}`);
        return { statusCode: 202, body: { status: 'accepted' } };
      },
    },
    now: () => 10_000,
    randomUuid: () => '019f70c0-0000-4000-8000-000000000002',
    ...overrides,
  };
  return { admission: createLocalApiAdmission(options), events };
}

async function execute(admission, value, body = null) {
  const prepared = await admission.prepare(value);
  return typeof prepared.handle === 'function'
    ? prepared.handle(body)
    : prepared;
}

test('authenticates, authorizes, durably audits and re-confirms before reading', async () => {
  const { admission, events } = fixture();
  assert.deepEqual(await execute(admission, request()), {
    statusCode: 200,
    body: { run: { id: 'run_123' } },
  });
  assert.deepEqual(events, [
    'authenticate',
    'authorize:run.read:prj_default',
    'audit:allowed:run.get',
    'confirm',
    'route:prj_default:run_123',
  ]);
});

test('uses the same admission chain with a route-owned run.list audit identity', async () => {
  const { admission, events } = fixture();
  assert.deepEqual(
    await execute(
      admission,
      request({
        operation: Object.freeze({
          operationId: 'run.list',
          projectId: 'prj_default',
          input: Object.freeze({ limit: 8 }),
        }),
      }),
    ),
    { statusCode: 200, body: { runs: [], hasMore: false } },
  );
  assert.deepEqual(events, [
    'authenticate',
    'authorize:run.read:prj_default',
    'audit:allowed:run.list',
    'confirm',
    'list:prj_default:8',
  ]);
});

test('uses the same admission chain with a route-owned run.events.list audit identity', async () => {
  const { admission, events } = fixture();
  assert.deepEqual(
    await execute(
      admission,
      request({
        operation: Object.freeze({
          operationId: 'run.events.list',
          projectId: 'prj_default',
          runId: 'run_123',
          input: Object.freeze({ afterSequence: 7, limit: 8 }),
        }),
      }),
    ),
    {
      statusCode: 200,
      body: { events: [], hasMore: false, nextAfterSequence: 0 },
    },
  );
  assert.deepEqual(events, [
    'authenticate',
    'authorize:run.read:prj_default',
    'audit:allowed:run.events.list',
    'confirm',
    'events:prj_default:run_123:7',
  ]);
});

test('uses the same admission chain with a route-owned run.steps.list audit identity', async () => {
  const { admission, events } = fixture();
  assert.deepEqual(
    await execute(
      admission,
      request({
        operation: Object.freeze({
          operationId: 'run.steps.list',
          projectId: 'prj_default',
          runId: 'run_123',
          input: Object.freeze({
            after: Object.freeze({
              stepKey: 'build',
              stepRunId: 'step_1',
            }),
            limit: 8,
          }),
        }),
      }),
    ),
    { statusCode: 200, body: { steps: [], hasMore: false, next: null } },
  );
  assert.deepEqual(events, [
    'authenticate',
    'authorize:run.read:prj_default',
    'audit:allowed:run.steps.list',
    'confirm',
    'steps:prj_default:run_123:build',
  ]);
});

test('uses task.read with a route-owned task.list audit identity', async () => {
  const { admission, events } = fixture();
  assert.deepEqual(
    await execute(
      admission,
      request({
        operation: Object.freeze({
          operationId: 'task.list',
          projectId: 'prj_default',
          input: Object.freeze({ limit: 8 }),
        }),
      }),
    ),
    { statusCode: 200, body: { tasks: [], hasMore: false } },
  );
  assert.deepEqual(events, [
    'authenticate',
    'authorize:task.read:prj_default',
    'audit:allowed:task.list',
    'confirm',
    'tasks:prj_default:8',
  ]);
});

test('uses task.read with a route-owned task.get audit identity', async () => {
  const { admission, events } = fixture();
  assert.deepEqual(
    await execute(
      admission,
      request({
        operation: Object.freeze({
          operationId: 'task.get',
          projectId: 'prj_default',
          taskId: 'task-a',
        }),
      }),
    ),
    { statusCode: 200, body: { task: { taskId: 'task-a' } } },
  );
  assert.deepEqual(events, [
    'authenticate',
    'authorize:task.read:prj_default',
    'audit:allowed:task.get',
    'confirm',
    'task:prj_default:task-a',
  ]);
});

test('authorizes and audits run.stop before exposing the cancellation body handler', async () => {
  const { admission, events } = fixture();
  const prepared = await admission.prepare(
    request({
      operation: Object.freeze({
        operationId: 'run.cancel',
        projectId: 'prj_default',
        runId: 'run_123',
      }),
    }),
  );
  assert.equal(typeof prepared.handle, 'function');
  assert.equal(prepared.bodyMode, 'json');
  assert.equal(prepared.maximumBodyBytes, 512);
  assert.deepEqual(events, [
    'authenticate',
    'authorize:run.stop:prj_default',
    'audit:allowed:run.cancel',
    'confirm',
  ]);
  assert.deepEqual(await prepared.handle({ schema: 'x' }), {
    statusCode: 202,
    body: { status: 'accepted' },
  });
  assert.equal(events.at(-1), 'cancel:prj_default:run_123');
});

test('authorizes and audits run.start before exposing the Task body handler', async () => {
  const { admission, events } = fixture();
  const prepared = await admission.prepare(
    request({
      operation: Object.freeze({
        operationId: 'task.start',
        projectId: 'prj_default',
        taskId: 'task-a',
      }),
    }),
  );
  assert.equal(prepared.bodyMode, 'json');
  assert.equal(prepared.maximumBodyBytes, 512);
  assert.deepEqual(events, [
    'authenticate',
    'authorize:run.start:prj_default',
    'audit:allowed:task.start',
    'confirm',
  ]);
  assert.equal((await prepared.handle({ schema: 'x' })).statusCode, 202);
  assert.equal(events.at(-1), 'task-start:prj_default:task-a');
});

test('audits authentication rejection before returning a challenge', async () => {
  const events = [];
  const { admission } = fixture({
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return null;
      },
    },
    audit: {
      async record(record) {
        events.push(`audit:${record.outcome}`);
      },
    },
  });
  assert.deepEqual(await execute(admission, request()), {
    statusCode: 401,
    body: { code: 'authentication_required' },
  });
  assert.deepEqual(events, ['authenticate', 'audit:authentication_rejected']);
});

test('does not confirm or route denied, unaudited or changed credentials', async () => {
  const denied = fixture({
    policy: {
      async authorize() {
        return { effect: 'deny', reasons: ['no_binding'], fence: null };
      },
    },
  });
  assert.deepEqual(await execute(denied.admission, request()), {
    statusCode: 403,
    body: { code: 'forbidden' },
  });
  assert.equal(denied.events.includes('confirm'), false);
  assert.equal(
    denied.events.some((event) => event.startsWith('route:')),
    false,
  );

  const unaudited = fixture({
    audit: {
      async record() {
        throw new Error('audit unavailable');
      },
    },
  });
  assert.deepEqual(await execute(unaudited.admission, request()), {
    statusCode: 503,
    body: { code: 'security_audit_unavailable' },
  });
  assert.equal(unaudited.events.includes('confirm'), false);

  const changed = fixture({
    authenticator: {
      async authenticate() {
        return {
          principal: PRINCIPAL,
          async confirm() {
            throw new Error('credential rotated');
          },
        };
      },
    },
  });
  assert.deepEqual(await execute(changed.admission, request()), {
    statusCode: 503,
    body: { code: 'authentication_unavailable' },
  });
  assert.equal(
    changed.events.some((event) => event.startsWith('route:')),
    false,
  );
});
