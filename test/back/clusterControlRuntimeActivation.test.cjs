require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  activateClusterControlRuntime,
} = require('../../back/runtime/application/clusterControlRuntimeActivation');

const EVIDENCE = Object.freeze({
  contractName: 'control-core',
  contractVersion: 1,
  serverMajor: 16,
  migrationIds: Object.freeze([
    'pg-0001-schema-capability',
    'pg-0002-run-core',
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

test('does nothing when cluster-control activation is not explicitly enabled', async () => {
  const events = [];
  const result = await activateClusterControlRuntime(
    options(events, { enabled: false }),
  );
  assert.equal(result.status, 'disabled');
  assert.deepEqual(events, ['audit:disabled']);
  assert.equal(await result.stop(), 'stopped');
});

test('rejects the wrong deployment profile before probing the database', async () => {
  const events = [];
  await assert.rejects(
    activateClusterControlRuntime(options(events, { profile: 'standalone' })),
    /cannot activate cluster-control/,
  );
  assert.deepEqual(events, []);
});

test('never constructs repositories when schema readiness fails', async () => {
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

test('orders readiness, recovery, lifecycles and admission and stops idempotently', async () => {
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
  const second = result.stop();
  assert.equal(first, second);
  assert.equal(await first, 'stopped');
  assert.deepEqual(events.slice(-3), [
    'dispose-admission',
    'stop-stack',
    'audit:stopped',
  ]);
});

test('cleans up a constructed stack when startup recovery is unsafe', async () => {
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
    /did not converge safely/,
  );
  assert.equal(events.includes('start-lifecycles'), false);
  assert.equal(events.includes('install-admission'), false);
  assert.deepEqual(events.slice(-2), ['stop-stack', 'audit:failed']);
});

test('continues stopping the stack when admission cleanup fails', async () => {
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

test('preserves an activation failure when admission rollback also fails', async () => {
  const events = [];
  const activationFailure = new Error('active audit failed');
  await assert.rejects(
    activateClusterControlRuntime(
      options(events, {
        create() {
          events.push('create');
          return {
            ...stack(events),
            installAdmission() {
              events.push('install-admission');
              return () => {
                events.push('dispose-admission');
                throw new Error('rollback failed');
              };
            },
          };
        },
        audit(record) {
          events.push(`audit:${record.state}`);
          if (record.state === 'active') throw activationFailure;
        },
      }),
    ),
    (error) => error === activationFailure,
  );
  assert.deepEqual(events.slice(-3), [
    'dispose-admission',
    'stop-stack',
    'audit:failed',
  ]);
});
