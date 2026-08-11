const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PostgresWorkerSessionRepository,
} = require('@qinglong/cluster-postgres/worker-ingress');

const SESSION_ID = '019f7094-a853-72f3-82ab-dfa08e6bd1c1';
const CAPABILITIES_HASH =
  '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

test('pins the shared transition status parameter to PostgreSQL varchar', async () => {
  const events = [];
  const session = {
    workerId: 'edge-router-1',
    sessionId: SESSION_ID,
    generation: 2,
    status: 'online',
    version: 3,
    capabilitiesJson: '{}',
    capabilitiesHash: CAPABILITIES_HASH,
    maxConcurrentRuns: 2,
    availableSlots: 1,
    registeredAtMs: '900',
    lastHeartbeatAtMs: '1000',
    leaseExpiresAtMs: '5000',
    updatedAtMs: '1000',
  };
  const client = {
    async query(text) {
      const sql = String(text);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        events.push(sql);
        return { rows: [] };
      }
      if (sql.startsWith('SET LOCAL')) return { rows: [] };
      if (
        sql.includes('FROM "ql3"."worker_sessions"') &&
        sql.includes('FOR UPDATE')
      ) {
        return { rows: [session] };
      }
      if (sql.includes('statement_timestamp()')) {
        return { rows: [{ observedAtMs: '1200' }] };
      }
      if (sql.includes('UPDATE "ql3"."worker_sessions"')) {
        assert.match(sql, /status = \$5::varchar/);
        assert.match(sql, /WHEN \$5::varchar = 'offline'/);
        return {
          rows: [{
            ...session,
            status: 'draining',
            version: 4,
            availableSlots: 0,
            updatedAtMs: '1200',
          }],
        };
      }
      if (sql.includes('FROM "ql3"."worker_credential_deliveries"')) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const repository = new PostgresWorkerSessionRepository({
    async connect() {
      return client;
    },
    async query() {
      throw new Error('not used');
    },
  });
  const transitioned = await repository.transitionAuthenticated(
    {
      workerId: 'edge-router-1',
      sessionId: SESSION_ID,
      generation: 2,
      expectedVersion: 3,
      status: 'draining',
    },
    {
      workerId: 'edge-router-1',
      credentialId: 'worker_generation_2',
      credentialVersion: 1,
    },
  );
  assert.equal(transitioned.status, 'draining');
  assert.equal(transitioned.version, 4);
  assert.deepEqual(events, ['BEGIN', 'COMMIT']);
});
