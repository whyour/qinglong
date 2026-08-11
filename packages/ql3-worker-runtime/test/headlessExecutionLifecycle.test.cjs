'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerRemoteExecutionHeadlessLifecycle,
} = require('../dist/remote-execution/remoteOfferDeliveryEntrypoint');

const session = Object.freeze({
  workerId: 'edge-1',
  sessionId: '018f0000-0000-7000-8000-000000000001',
  generation: 2,
  status: 'available',
  leaseExpiresAtMs: 20_000,
});

function record(offerId, state) {
  return { state, offer: { offerId } };
}

function fixture(overrides = {}) {
  const calls = [];
  const journal = overrides.journal ?? {
    async acquireOwnership() { calls.push('acquire'); },
    async releaseOwnership() { calls.push('release'); },
    async listOffers() { calls.push('list'); return { records: [] }; },
  };
  const offers = overrides.offers ?? {
    async pull() {
      calls.push('pull');
      return {
        status: 'idle',
        reason: 'no_candidates',
        stats: {
          pages: 0,
          candidates: 0,
          plansUnavailable: 0,
          placementMismatches: 0,
          claimAttempts: 0,
          claimRaces: 0,
        },
        truncated: false,
      };
    },
  };
  const processor = overrides.processor ?? {
    async process(offerId) {
      calls.push(`process:${offerId}`);
      return { status: 'running', offerId, executorHandle: `handle:${offerId}` };
    },
  };
  const control = overrides.control ?? {
    async reconcile(offerId) {
      calls.push(`control:${offerId}`);
      return { status: 'renewed', offerId, leaseVersion: 1, expiresAtMs: 30_000 };
    },
  };
  const lifecycle = new WorkerRemoteExecutionHeadlessLifecycle({
    journal,
    offers,
    processor,
    control,
    currentSession: overrides.currentSession ?? (() => session),
    maximumRecordsPerTick: overrides.maximumRecordsPerTick ?? 2,
    now: () => 10_000,
  });
  return { calls, lifecycle };
}

test('is inert until explicit start and releases the single journal owner', async () => {
  const { calls, lifecycle } = fixture();
  assert.deepEqual(calls, []);
  await assert.rejects(lifecycle.tick(), /inactive/);
  assert.equal(await lifecycle.start(), 'started');
  assert.equal(await lifecycle.start(), 'already_started');
  assert.deepEqual(calls, ['acquire']);
  assert.deepEqual(await lifecycle.tick(), {
    status: 'reconciled',
    processed: 0,
  });
  await lifecycle.stop();
  assert.deepEqual(calls, ['acquire', 'list', 'release']);
  await assert.rejects(lifecycle.tick(), /inactive/);
});

test('finishes bounded startup reconciliation before pulling and processing', async () => {
  const pages = [
    {
      records: [record('offer-1', 'accepted'), record('offer-2', 'running_acknowledged')],
      nextAfterOfferId: 'offer-2',
    },
    { records: [record('offer-3', 'completion_acknowledged')] },
  ];
  const { calls, lifecycle } = fixture({
    journal: {
      async acquireOwnership() { calls.push('acquire'); },
      async releaseOwnership() { calls.push('release'); },
      async listOffers() { calls.push('list'); return pages.shift() ?? { records: [] }; },
    },
    offers: {
      async pull() {
        calls.push('pull');
        return {
          status: 'accepted',
          offerId: 'offer-new',
          stats: {
            pages: 1,
            candidates: 1,
            plansUnavailable: 0,
            placementMismatches: 0,
            claimAttempts: 1,
            claimRaces: 0,
          },
          truncated: false,
        };
      },
    },
  });
  await lifecycle.start();
  assert.deepEqual(await lifecycle.tick(), {
    status: 'reconciling',
    processed: 1,
    nextAfterOfferId: 'offer-2',
  });
  assert.equal(calls.includes('pull'), false);
  assert.deepEqual(await lifecycle.tick(), {
    status: 'reconciled',
    processed: 0,
  });
  const pulled = await lifecycle.tick();
  assert.equal(pulled.status, 'processed');
  assert.equal(pulled.offerId, 'offer-new');
  assert.deepEqual(calls.filter((call) => call.startsWith('process:')), [
    'process:offer-1',
    'process:offer-new',
  ]);
  await lifecycle.stop();
});

test('supervises a bounded active page before pulling new work', async () => {
  let lists = 0;
  const { calls, lifecycle } = fixture({
    journal: {
      async acquireOwnership() { calls.push('acquire'); },
      async releaseOwnership() { calls.push('release'); },
      async listOffers() {
        lists += 1;
        if (lists === 1) return { records: [] };
        return {
          records: [
            record('offer-running', 'running_acknowledged'),
            record('offer-complete', 'completion_acknowledged'),
          ],
        };
      },
    },
  });
  await lifecycle.start();
  await lifecycle.tick();
  const result = await lifecycle.tick();
  assert.equal(result.status, 'pull_result');
  assert.deepEqual(calls.slice(-2), ['control:offer-running', 'pull']);
  await lifecycle.stop();
});

test('fails closed before Pull when active supervision records lease loss', async () => {
  let lists = 0;
  const { calls, lifecycle } = fixture({
    journal: {
      async acquireOwnership() { calls.push('acquire'); },
      async releaseOwnership() { calls.push('release'); },
      async listOffers() {
        lists += 1;
        return lists === 1
          ? { records: [] }
          : { records: [record('offer-lost', 'running_acknowledged')] };
      },
    },
    control: {
      async reconcile(offerId) {
        calls.push(`control:${offerId}`);
        return {
          status: 'lease_expired', offerId,
          stop: { status: 'stopped', signal: 'SIGTERM' },
          recoveryReason: 'lease_lost_local_execution_stopped',
        };
      },
    },
  });
  await lifecycle.start();
  await lifecycle.tick();
  assert.deepEqual(await lifecycle.tick(), {
    status: 'recovery_required', offerId: 'offer-lost',
  });
  assert.equal(calls.includes('pull'), false);
  assert.deepEqual(await lifecycle.tick(), {
    status: 'recovery_required', offerId: 'offer-lost',
  });
  await lifecycle.stop();
});

test('fails closed on durable recovery evidence and never pulls again', async () => {
  const { calls, lifecycle } = fixture({
    journal: {
      async acquireOwnership() { calls.push('acquire'); },
      async releaseOwnership() { calls.push('release'); },
      async listOffers() {
        calls.push('list');
        return { records: [record('offer-unsafe', 'recovery_required')] };
      },
    },
  });
  await lifecycle.start();
  assert.deepEqual(await lifecycle.tick(), {
    status: 'recovery_required',
    offerId: 'offer-unsafe',
  });
  assert.deepEqual(await lifecycle.tick(), {
    status: 'recovery_required',
    offerId: 'offer-unsafe',
  });
  assert.equal(calls.includes('pull'), false);
  await lifecycle.stop();
});

test('coalesces ticks and aborts a pending pull before releasing ownership', async () => {
  const events = [];
  const { lifecycle } = fixture({
    journal: {
      async acquireOwnership() { events.push('acquire'); },
      async releaseOwnership() { events.push('release'); },
      async listOffers() { return { records: [] }; },
    },
    offers: {
      pull(_session, signal) {
        events.push('pull');
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            events.push('aborted');
            reject(signal.reason);
          }, { once: true });
        });
      },
    },
  });
  await lifecycle.start();
  await lifecycle.tick();
  const first = lifecycle.tick();
  const second = lifecycle.tick();
  assert.strictEqual(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = lifecycle.stop();
  await assert.rejects(first, /stopping/);
  await stopping;
  assert.deepEqual(events, ['acquire', 'pull', 'aborted', 'release']);
});

test('draining aborts Pull but keeps ownership until final stop', async () => {
  const events = [];
  const { lifecycle } = fixture({
    journal: {
      async acquireOwnership() { events.push('acquire'); },
      async releaseOwnership() { events.push('release'); },
      async listOffers() { events.push('list'); return { records: [] }; },
    },
    offers: {
      pull(_session, signal) {
        events.push('pull');
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            events.push('aborted');
            reject(signal.reason);
          }, { once: true });
        });
      },
    },
  });
  await lifecycle.start();
  await lifecycle.tick();
  const pulling = lifecycle.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await lifecycle.beginDrain();
  await assert.rejects(pulling, /draining/);
  assert.equal(events.includes('release'), false);
  assert.deepEqual(await lifecycle.tick(), { status: 'draining' });
  assert.equal(events.filter((event) => event === 'pull').length, 1);
  await lifecycle.beginDrain();
  await lifecycle.stop();
  assert.equal(events.at(-1), 'release');
});
