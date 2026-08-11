const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterControlRecoverySupervisor,
  MAX_CLUSTER_CONTROL_RECOVERY_CLAIMS_PER_PASS,
} = require('../dist');

function claim(id, version = 1) {
  return {
    candidate: {
      kind: 'run',
      id,
      runId: id,
      status: 'running',
      createdAtMs: 1,
    },
    observedAtMs: 100,
    ownerId: 'node-a',
    token: '123e4567-e89b-42d3-a456-426614174000',
    version,
    expiresAtMs: 1_100,
  };
}

test('settles one bounded recovery page sequentially', async () => {
  const events = [];
  const repository = {
    async claim(options) {
      events.push(['claim', options]);
      return {
        claims: [claim('run-1'), claim('run-2')],
        discovered: 2,
        hasMore: false,
      };
    },
    async settle(current, disposition) {
      events.push(['settle', current.candidate.id, disposition]);
      return 'settled';
    },
  };
  const supervisor = new ClusterControlRecoverySupervisor(
    repository,
    {
      async process(current) {
        events.push(['process', current.candidate.id]);
        return { status: 'resolved' };
      },
    },
    { ownerId: 'node-a', limit: 2, leaseMs: 1_000 },
  );

  assert.deepEqual(await supervisor.reconcile(), {
    safe: true,
    remaining: 0,
    failed: 0,
  });
  assert.deepEqual(events, [
    ['claim', { ownerId: 'node-a', limit: 2, leaseMs: 1_000 }],
    ['process', 'run-1'],
    ['settle', 'run-1', { status: 'resolved' }],
    ['process', 'run-2'],
    ['settle', 'run-2', { status: 'resolved' }],
  ]);
});

test('keeps unclaimed, retry, manual and fenced work unsafe', async () => {
  const dispositions = new Map([
    ['run-retry', { status: 'retry', delayMs: 10 }],
    ['run-manual', { status: 'manual' }],
    ['run-fenced', { status: 'resolved' }],
  ]);
  const supervisor = new ClusterControlRecoverySupervisor(
    {
      async claim() {
        return {
          claims: [
            claim('run-retry'),
            claim('run-manual'),
            claim('run-fenced'),
          ],
          discovered: 4,
          hasMore: true,
        };
      },
      async settle(current) {
        return current.candidate.id === 'run-fenced' ? 'fenced' : 'settled';
      },
    },
    {
      async process(current) {
        return dispositions.get(current.candidate.id);
      },
    },
    { ownerId: 'node-a', limit: 4 },
  );

  assert.deepEqual(await supervisor.reconcile(), {
    safe: false,
    remaining: 5,
    failed: 2,
  });
});

test('turns a processor failure into a durable bounded retry', async () => {
  const settled = [];
  const supervisor = new ClusterControlRecoverySupervisor(
    {
      async claim() {
        return { claims: [claim('run-1')], discovered: 1, hasMore: false };
      },
      async settle(current, disposition) {
        settled.push([current.candidate.id, disposition]);
        return 'settled';
      },
    },
    {
      async process() {
        throw new Error('sensitive processor failure');
      },
    },
    { ownerId: 'node-a', retryDelayMs: 123 },
  );

  assert.deepEqual(await supervisor.reconcile(), {
    safe: false,
    remaining: 1,
    failed: 1,
  });
  assert.deepEqual(settled, [['run-1', { status: 'retry', delayMs: 123 }]]);
});

test('rejects malformed pages and unbounded options before processing', async () => {
  assert.equal(MAX_CLUSTER_CONTROL_RECOVERY_CLAIMS_PER_PASS, 128);
  assert.throws(
    () =>
      new ClusterControlRecoverySupervisor(
        {},
        {},
        {
          ownerId: 'unsafe owner',
        },
      ),
    /ownerId/,
  );
  const supervisor = new ClusterControlRecoverySupervisor(
    {
      async claim() {
        return { claims: [claim('run-1')], discovered: 0, hasMore: false };
      },
    },
    {},
    { ownerId: 'node-a' },
  );
  await assert.rejects(supervisor.reconcile(), /invalid claim page/);
});
