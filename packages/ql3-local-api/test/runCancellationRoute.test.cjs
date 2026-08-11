const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  RUN_CANCELLATION_SCHEMA,
  RunCancellationFenceRejectedError,
  RunCancellationNotFoundError,
  RunCancellationUnavailableError,
} = require('@qinglong/runtime-core/run-cancellation');
const {
  createLocalApiRunCancellationRoute,
} = require('../dist/run/runCancellationRoute.js');

const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'user-1' }),
  authenticationId: 'credential:user-1',
  authenticatedAtMs: 9_000,
  expiresAtMs: 11_000,
  assurance: 'single_factor',
});
const FENCE = Object.freeze({ projectVersion: 2, bindingVersion: 3 });

function accepted(overrides = {}) {
  return {
    status: 'accepted',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus: 'running',
    runVersion: 5,
    eventSequence: 7,
    cancelRequestedAtMs: 10_000,
    cancelReason: 'user',
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    projectId: 'project-1',
    runId: 'run-1',
    body: { schema: RUN_CANCELLATION_SCHEMA, mutationId: 'mutation-1' },
    principal: PRINCIPAL,
    policyFence: FENCE,
    ...overrides,
  };
}

test('publishes one profile-neutral durable cancellation command', async () => {
  let observed;
  const route = createLocalApiRunCancellationRoute(
    {
      async requestUserCancellation(command) {
        observed = command;
        return accepted();
      },
    },
    () => '018f0000-0000-7000-8000-000000000001',
  );
  assert.deepEqual(await route.handle(request()), {
    statusCode: 202,
    body: { schema: RUN_CANCELLATION_SCHEMA, ...accepted() },
  });
  assert.deepEqual(observed, {
    projectId: 'project-1',
    runId: 'run-1',
    mutationId: 'mutation-1',
    eventId: '018f0000-0000-7000-8000-000000000001',
    subject: PRINCIPAL.subject,
    policyFence: FENCE,
  });
});

test('rejects malformed bodies and incomplete authorization fences', async () => {
  let calls = 0;
  const route = createLocalApiRunCancellationRoute(
    {
      async requestUserCancellation() {
        calls += 1;
        return accepted();
      },
    },
    () => '018f0000-0000-7000-8000-000000000001',
  );
  assert.deepEqual(await route.handle(request({ body: { mutationId: 'x' } })), {
    statusCode: 400,
    body: {
      code: 'invalid_run_cancellation_request',
      schema: RUN_CANCELLATION_SCHEMA,
    },
  });
  assert.deepEqual(await route.handle(request({ policyFence: null })), {
    statusCode: 503,
    body: { code: 'run_cancellation_unavailable' },
  });
  assert.equal(calls, 0);
});

test('maps replay, terminal, missing, fence and unavailable outcomes', async () => {
  for (const outcome of [
    accepted({ status: 'already_requested' }),
    {
      status: 'already_terminal',
      projectId: 'project-1',
      runId: 'run-1',
      runStatus: 'succeeded',
      runVersion: 6,
      eventSequence: 8,
    },
  ]) {
    const route = createLocalApiRunCancellationRoute(
      { async requestUserCancellation() { return outcome; } },
      () => '018f0000-0000-7000-8000-000000000001',
    );
    assert.equal((await route.handle(request())).statusCode, 200);
  }
  for (const [error, statusCode, code] of [
    [new RunCancellationNotFoundError(), 404, 'run_not_found'],
    [
      new RunCancellationFenceRejectedError('authorization_changed'),
      409,
      'run_cancellation_fence_rejected',
    ],
    [
      new RunCancellationUnavailableError(),
      503,
      'run_cancellation_unavailable',
    ],
  ]) {
    const route = createLocalApiRunCancellationRoute(
      { async requestUserCancellation() { throw error; } },
      () => '018f0000-0000-7000-8000-000000000001',
    );
    const response = await route.handle(request());
    assert.equal(response.statusCode, statusCode);
    assert.equal(response.body.code, code);
  }
});
