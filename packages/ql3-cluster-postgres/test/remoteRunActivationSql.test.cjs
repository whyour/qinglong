const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  PostgresRemoteRunActivationRepository,
} = require('@qinglong/cluster-postgres/runtime');

test('pins the shared running status parameter to PostgreSQL varchar', async () => {
  const token = 'worker_generated_lease_capability_0000000000000001';
  const digest = createHash('sha256').update(token).digest('hex');
  const client = {
    async query(text) {
      const sql = String(text);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (sql.includes('FROM "ql3"."worker_sessions"')) {
        return {
          rows: [{
            workerId: 'worker-live',
            sessionId: '019f7094-a853-72f3-82ab-dfa08e6bd1c1',
            workerGeneration: 1,
            workerStatus: 'online',
            workerLeaseExpiresAtMs: '9000',
          }],
        };
      }
      if (sql.includes('FROM "ql3"."runs" AS run')) {
        return {
          rows: [{
            runId: 'run-live',
            runStatus: 'dispatching',
            executionOwner: 'runtime',
            cancelRequestedAtMs: null,
            cancelReason: null,
            runErrorCode: null,
            runVersion: 2,
            eventSequence: 2,
            planJson: { command: {}, environment: [] },
            attemptId: 'attempt-live',
            attemptRunId: 'run-live',
            attemptStepRunId: null,
            attemptStatus: 'starting',
            executorType: 'remote_worker',
            attemptWorkerId: 'worker-live',
            attemptWorkerSessionId: '019f7094-a853-72f3-82ab-dfa08e6bd1c1',
            attemptWorkerGeneration: 1,
            attemptLeaseGeneration: 1,
            attemptLeaseVersion: 0,
            attemptLeaseTokenDigest: digest,
            attemptOfferId: 'offer-live',
            callbackSequence: 0,
            callbackTokenDigest: null,
            executorHandle: null,
            logArtifactId: null,
            deadlineAtMs: null,
            startedAtMs: null,
            finishedAtMs: null,
            attemptErrorCode: null,
            workflowAttemptId: null,
            workflowStepRunId: null,
            admittedWorkflowStepVersion: null,
            admittedWorkflowStepDigest: null,
          }],
        };
      }
      if (sql.includes('FROM "ql3"."run_dispatch_leases"')) {
        return {
          rows: [{
            attemptId: 'attempt-live',
            runId: 'run-live',
            leaseStatus: 'leased',
            leaseVersion: 0,
            leaseGeneration: 1,
            workerId: 'worker-live',
            workerSessionId: '019f7094-a853-72f3-82ab-dfa08e6bd1c1',
            workerGeneration: 1,
            leaseTokenDigest: digest,
            offerId: 'offer-live',
            leaseExpiresAtMs: '9000',
          }],
        };
      }
      if (sql.includes('statement_timestamp()')) {
        return { rows: [{ nowMs: '1000' }] };
      }
      if (sql.includes('UPDATE "ql3"."run_attempts"')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE "ql3"."runs"')) {
        assert.match(sql, /SET status = \$2::varchar/);
        assert.match(sql, /WHEN \$2::varchar = 'running'/);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO "ql3"."run_events"')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const repository = new PostgresRemoteRunActivationRepository({
    async connect() {
      return client;
    },
    async query() {
      throw new Error('not used');
    },
  });
  const result = await repository.acknowledgeRunning({
    runId: 'run-live',
    attemptId: 'attempt-live',
    workerId: 'worker-live',
    workerSessionId: '019f7094-a853-72f3-82ab-dfa08e6bd1c1',
    workerGeneration: 1,
    offerId: 'offer-live',
    leaseGeneration: 1,
    leaseToken: token,
    expectedLeaseVersion: 0,
    attemptEventId: '019f7094-a853-72f3-82ab-dfa08e6bd1c2',
    runEventId: '019f7094-a853-72f3-82ab-dfa08e6bd1c3',
    executorHandle: 'ql3lp1.test',
    logArtifactId: 'wlog-0123456789abcdef0123456789abcd',
    callbackSequence: 1,
    callbackTokenDigest: 'b'.repeat(64),
  });
  assert.equal(result.status, 'applied');
});
