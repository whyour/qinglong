const assert = require('node:assert/strict');
const { test } = require('node:test');
const { activateClusterControlRuntime } = require('../dist');

const EVIDENCE = Object.freeze({
  contractName: 'control-core',
  contractVersion: 2,
  serverMajor: 16,
  migrationIds: Object.freeze([
    'pg-0001-schema-capability',
    'pg-0002-run-core',
    'pg-0003-run-retry-policy',
  ]),
});

function stack(events, recovery = { safe: true, remaining: 0, failed: 0 }) {
  return {
    async reconcile() {
      events.push('reconcile');
      return recovery;
    },
    async startLifecycles() {
      events.push('start-lifecycles');
      return true;
    },
    installAdmission() {
      events.push('install-admission');
      return () => events.push('dispose-admission');
    },
    async stop() {
      events.push('stop-stack');
      return 'stopped';
    },
  };
}

function options(events, overrides = {}) {
  return {
    enabled: true,
    profile: 'cluster-control',
    readiness: {
      async assertReady() {
        events.push('readiness');
        return EVIDENCE;
      },
    },
    create() {
      events.push('create');
      return stack(events);
    },
    audit(record) {
      events.push(`audit:${record.state}`);
    },
    ...overrides,
  };
}

test('disabled and wrong-profile paths never probe readiness', async () => {
  const disabledEvents = [];
  const disabled = await activateClusterControlRuntime(
    options(disabledEvents, { enabled: false }),
  );
  assert.equal(disabled.status, 'disabled');
  assert.deepEqual(disabledEvents, ['audit:disabled']);

  const wrongProfileEvents = [];
  await assert.rejects(
    activateClusterControlRuntime(
      options(wrongProfileEvents, { profile: 'standalone' }),
    ),
    /cannot activate cluster-control/,
  );
  assert.deepEqual(wrongProfileEvents, []);
});

test('orders readiness, recovery, lifecycles and admission', async () => {
  const events = [];
  const result = await activateClusterControlRuntime(options(events));
  assert.equal(result.status, 'active');
  assert.deepEqual(events, [
    'readiness',
    'audit:schema_ready',
    'create',
    'reconcile',
    'audit:reconciled',
    'start-lifecycles',
    'install-admission',
    'audit:active',
  ]);
  const first = result.stop();
  assert.equal(first, result.stop());
  assert.equal(await first, 'stopped');
  assert.deepEqual(events.slice(-3), [
    'dispose-admission',
    'stop-stack',
    'audit:stopped',
  ]);
});

test('readiness failure never constructs a stack', async () => {
  const events = [];
  const unavailable = new Error('database unavailable');
  await assert.rejects(
    activateClusterControlRuntime(
      options(events, {
        readiness: {
          async assertReady() {
            events.push('readiness');
            throw unavailable;
          },
        },
      }),
    ),
    (error) => error === unavailable,
  );
  assert.deepEqual(events, ['readiness', 'audit:failed']);
});

test('unsafe recovery stops the stack before lifecycles and admission', async () => {
  const events = [];
  await assert.rejects(
    activateClusterControlRuntime(
      options(events, {
        create() {
          events.push('create');
          return stack(events, { safe: false, remaining: 1, failed: 0 });
        },
      }),
    ),
    /did not converge safely \(remaining=1, failed=0\)/,
  );
  assert.equal(events.includes('start-lifecycles'), false);
  assert.equal(events.includes('install-admission'), false);
  assert.deepEqual(events.slice(-2), ['stop-stack', 'audit:failed']);
});

test('admission cleanup failure still stops the stack and remains idempotent', async () => {
  const events = [];
  const cleanupFailure = new Error('admission cleanup failed');
  const result = await activateClusterControlRuntime(
    options(events, {
      create() {
        events.push('create');
        return {
          ...stack(events),
          installAdmission() {
            events.push('install-admission');
            return () => {
              events.push('dispose-admission');
              throw cleanupFailure;
            };
          },
        };
      },
    }),
  );
  const first = result.stop();
  assert.equal(first, result.stop());
  await assert.rejects(first, (error) => error === cleanupFailure);
  assert.deepEqual(events.slice(-3), [
    'dispose-admission',
    'stop-stack',
    'audit:failed',
  ]);
});

test('awaits asynchronous admission drain before stopping the stack', async () => {
  const events = [];
  let releaseDrain;
  const drain = new Promise((resolve) => {
    releaseDrain = resolve;
  });
  const result = await activateClusterControlRuntime(
    options(events, {
      create() {
        events.push('create');
        return {
          ...stack(events),
          installAdmission() {
            events.push('install-admission');
            return async () => {
              events.push('drain-admission');
              await drain;
              events.push('admission-drained');
            };
          },
        };
      },
    }),
  );
  const stopping = result.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.slice(-1), ['drain-admission']);
  assert.equal(events.includes('stop-stack'), false);
  releaseDrain();
  assert.equal(await stopping, 'stopped');
  assert.deepEqual(events.slice(-3), [
    'admission-drained',
    'stop-stack',
    'audit:stopped',
  ]);
});
