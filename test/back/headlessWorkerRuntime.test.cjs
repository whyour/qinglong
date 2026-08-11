require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  bootstrapHeadlessWorkerRuntime,
} = require('../../back/runtime/application/headlessWorkerRuntime');

function heartbeat(calls, overrides = {}) {
  return {
    currentSession() {
      return undefined;
    },
    async start() {
      calls.push('heartbeat.start');
      return true;
    },
    async drain() {
      calls.push('heartbeat.drain');
      return undefined;
    },
    async stop() {
      calls.push('heartbeat.stop');
      return 'drained';
    },
    ...overrides,
  };
}

test('is default-off without touching Worker dependencies', async () => {
  const calls = [];
  const result = await bootstrapHeadlessWorkerRuntime({
    profile: 'worker',
    heartbeat: heartbeat(calls),
    executions: {
      async drain() {
        calls.push('executions.drain');
        return 'drained';
      },
    },
  });
  assert.deepEqual(result, { status: 'disabled' });
  assert.deepEqual(calls, []);
});

test('refuses to graft the headless topology onto a control-plane profile', async () => {
  const calls = [];
  await assert.rejects(
    bootstrapHeadlessWorkerRuntime({
      enabled: true,
      profile: 'cluster-control',
      heartbeat: heartbeat(calls),
      executions: {
        async drain() {
          return 'drained';
        },
      },
    }),
    /cannot activate the headless Worker runtime/,
  );
  assert.deepEqual(calls, []);
});

test('advertises drain before waiting for tasks and disconnecting', async () => {
  const calls = [];
  const result = await bootstrapHeadlessWorkerRuntime({
    enabled: true,
    profile: 'worker',
    heartbeat: heartbeat(calls),
    executions: {
      async drain() {
        calls.push('executions.drain');
        return 'drained';
      },
    },
  });
  assert.equal(result.status, 'active');
  assert.equal(await result.runtime.drainAndStop(), 'stopped');
  assert.deepEqual(calls, [
    'heartbeat.start',
    'heartbeat.drain',
    'executions.drain',
    'heartbeat.stop',
  ]);
});

test('keeps a draining session alive when task shutdown reaches its bound', async () => {
  const calls = [];
  const result = await bootstrapHeadlessWorkerRuntime({
    enabled: true,
    profile: 'worker',
    heartbeat: heartbeat(calls),
    executions: {
      async drain() {
        calls.push('executions.drain');
        return 'timed_out';
      },
    },
  });
  assert.equal(result.status, 'active');
  assert.equal(await result.runtime.drainAndStop(), 'executions_timed_out');
  assert.deepEqual(calls, [
    'heartbeat.start',
    'heartbeat.drain',
    'executions.drain',
  ]);
});

test('reports a control-plane disconnect failure without claiming shutdown', async () => {
  const calls = [];
  const result = await bootstrapHeadlessWorkerRuntime({
    enabled: true,
    profile: 'worker',
    heartbeat: heartbeat(calls, {
      async stop() {
        calls.push('heartbeat.stop');
        return 'disconnect_failed';
      },
    }),
    executions: {
      async drain() {
        calls.push('executions.drain');
        return 'drained';
      },
    },
  });
  assert.equal(result.status, 'active');
  assert.equal(
    await result.runtime.drainAndStop(),
    'heartbeat_disconnect_failed',
  );
  assert.deepEqual(calls, [
    'heartbeat.start',
    'heartbeat.drain',
    'executions.drain',
    'heartbeat.stop',
  ]);
});
