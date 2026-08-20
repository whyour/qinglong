const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PostgresWorkerSessionRepository,
} = require('@qinglong/cluster-postgres/worker-ingress');
const {
  WorkerCredentialDeliveryUnavailableError,
} = require('@qinglong/runtime-core/worker-credential-delivery');

const SESSION_ID = '019f7094-a853-72f3-82ab-dfa08e6bd1c1';
const DELIVERY_ID = '123e4567-e89b-42d3-a456-426614174601';
const CAPABILITIES_HASH =
  'b3d79017d91c477ffdf4a4dcc4ce9135ca053c921922ce0221920f905d8a2aa4';
const CAPABILITIES_JSON =
  '{"architecture":"arm64","executors":["remote-worker"],"protocolVersion":"1.0.0","supportTier":"tier1"}';

function session(version, overrides = {}) {
  return {
    workerId: 'edge-router-1',
    sessionId: SESSION_ID,
    generation: 2,
    status: 'online',
    version,
    capabilitiesJson: CAPABILITIES_JSON,
    capabilitiesHash: CAPABILITIES_HASH,
    maxConcurrentRuns: 2,
    availableSlots: 1,
    registeredAtMs: '900',
    lastHeartbeatAtMs: '1000',
    leaseExpiresAtMs: '5000',
    updatedAtMs: '1000',
    ...overrides,
  };
}

function delivery(version, overrides = {}) {
  const published = version >= 2;
  const observed = version >= 3;
  return {
    deliveryId: DELIVERY_ID,
    version,
    state: version === 1
      ? 'credential_committed'
      : version === 2
        ? 'published'
        : 'observed',
    workerId: 'edge-router-1',
    credentialId: 'worker_generation_2',
    credentialVersion: 1,
    previousCredentialId: 'worker_generation_1',
    secretDigest: 'a'.repeat(64),
    tokenDigest: 'b'.repeat(64),
    deploymentTargetDigest: 'c'.repeat(64),
    deploymentGeneration: 'secret-generation-2',
    stagedAtMs: '800',
    credentialCommittedAtMs: '850',
    publishedAtMs: published ? '900' : null,
    publicationDigest: published ? 'd'.repeat(64) : null,
    observedAtMs: observed ? '1100' : null,
    observedSessionId: observed ? SESSION_ID : null,
    observedSessionVersion: observed ? 4 : null,
    previousRevokedAtMs: null,
    ...overrides,
  };
}

function database(deliveryRows) {
  const events = [];
  let released = 0;
  const client = {
    async query(text, values) {
      const sql = String(text);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        events.push(sql);
        return { rows: [] };
      }
      if (sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.includes('FROM "ql3"."worker_sessions"') && sql.includes('FOR UPDATE')) {
        events.push('lock-session');
        return { rows: [session(3)] };
      }
      if (sql.includes('statement_timestamp()')) {
        events.push('database-time');
        return { rows: [{ observedAtMs: '1200' }] };
      }
      if (sql.includes('UPDATE "ql3"."worker_sessions"')) {
        events.push('update-session');
        return { rows: [session(4, {
          lastHeartbeatAtMs: '1200',
          leaseExpiresAtMs: '31200',
          updatedAtMs: '1200',
        })] };
      }
      if (sql.includes('FROM "ql3"."worker_credential_deliveries"')) {
        assert.equal(sql.includes('FOR UPDATE'), false);
        events.push(`read-delivery:${values.join(':')}`);
        return { rows: deliveryRows };
      }
      if (sql.includes('INSERT INTO "ql3"."worker_credential_deliveries"')) {
        events.push(`insert-observation:${values[1]}:${values[2]}`);
        assert.equal(values[15], 1200);
        assert.equal(values[16], SESSION_ID);
        assert.equal(values[17], 4);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { released += 1; },
  };
  return {
    pool: {
      async connect() { return client; },
      async query() { throw new Error('not used'); },
    },
    events,
    released: () => released,
  };
}

function heartbeat(repository) {
  return repository.heartbeatAuthenticated(
    {
      workerId: 'edge-router-1',
      sessionId: SESSION_ID,
      generation: 2,
      expectedVersion: 3,
      availableSlots: 1,
      leaseDurationMs: 30_000,
    },
    {
      workerId: 'edge-router-1',
      credentialId: 'worker_generation_2',
      credentialVersion: 1,
    },
  );
}

test('appends authenticated observation in the Session heartbeat transaction', async () => {
  const db = database([delivery(1), delivery(2)]);
  const worker = await heartbeat(new PostgresWorkerSessionRepository(db.pool));
  assert.equal(worker.version, 4);
  assert.deepEqual(db.events, [
    'BEGIN',
    'lock-session',
    'database-time',
    'update-session',
    'read-delivery:edge-router-1:worker_generation_2:1',
    'insert-observation:3:observed',
    'COMMIT',
  ]);
  assert.equal(db.released(), 1);
});

test('rolls Session mutation back until the exact delivery is published', async () => {
  const db = database([delivery(1)]);
  await assert.rejects(
    heartbeat(new PostgresWorkerSessionRepository(db.pool)),
    WorkerCredentialDeliveryUnavailableError,
  );
  assert.equal(db.events.includes('COMMIT'), false);
  assert.equal(db.events.at(-1), 'ROLLBACK');
  assert.equal(db.released(), 1);
});

test('replays an existing observation and ignores credentials outside delivery', async () => {
  for (const rows of [[delivery(1), delivery(2), delivery(3)], []]) {
    const db = database(rows);
    const worker = await heartbeat(new PostgresWorkerSessionRepository(db.pool));
    assert.equal(worker.version, 4);
    assert.equal(
      db.events.some((event) => event.startsWith('insert-observation:')),
      false,
    );
    assert.equal(db.events.at(-1), 'COMMIT');
  }
});
