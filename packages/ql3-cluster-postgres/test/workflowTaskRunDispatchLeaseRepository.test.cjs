const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const {
  PostgresRunDispatchLeaseRepository,
} = require('../dist/remote-execution/runDispatchLeaseRepository');

const SESSION_ID = '018f5c64-9b9d-7f1a-8c2d-1234567890ac';
const LEASE_TOKEN = 'workflow_task_lease_capability_0000000000000001';
const LEASE_DIGEST = createHash('sha256')
  .update(LEASE_TOKEN)
  .digest('hex');

test('leases a Workflow Task Attempt without changing the aggregate Run status', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (
        normalized === 'BEGIN' ||
        normalized.startsWith('SET LOCAL') ||
        normalized === 'COMMIT' ||
        normalized === 'ROLLBACK' ||
        normalized.startsWith('SELECT pg_advisory_xact_lock')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.includes('FROM "ql3"."worker_sessions"')) {
        return {
          rows: [{
            workerId: 'edge-1',
            sessionId: SESSION_ID,
            generation: 2,
            status: 'online',
            maxConcurrentRuns: 4,
            availableSlots: 2,
            leaseExpiresAtMs: 20_000,
          }],
          rowCount: 1,
        };
      }
      if (
        normalized.includes('INNER JOIN "ql3"."run_attempts"') &&
        normalized.includes('workflow_task')
      ) {
        return {
          rows: [{
            runId: 'workflow-run-1',
            runStatus: 'running',
            executionOwner: 'runtime',
            cancelRequestedAtMs: null,
            runVersion: 7,
            eventSequence: 7,
            attemptId: 'workflow-attempt-1',
            attemptStatus: 'claimed',
            attemptRunId: 'workflow-run-1',
            attemptStepRunId: 'workflow-step-1',
            workflowAttemptId: 'workflow-attempt-1',
            workflowStepRunId: 'workflow-step-1',
            admittedWorkflowStepVersion: 2,
            admittedWorkflowStepDigest: 'a'.repeat(64),
          }],
          rowCount: 1,
        };
      }
      if (
        normalized.includes('FROM "ql3"."step_runs"') &&
        normalized.includes('FOR UPDATE')
      ) {
        return {
          rows: [{
            workflowStepStatus: 'ready',
            workflowStepVersion: 2,
            workflowStepDigest: 'a'.repeat(64),
          }],
          rowCount: 1,
        };
      }
      if (
        normalized.startsWith('SELECT') &&
        normalized.includes('FROM "ql3"."run_dispatch_leases"') &&
        normalized.includes('WHERE attempt_id = $1 FOR UPDATE')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.includes('statement_timestamp()')) {
        return { rows: [{ nowMs: 10_000 }], rowCount: 1 };
      }
      if (normalized.includes('count(*)::integer AS "activeCount"')) {
        return { rows: [{ activeCount: 0 }], rowCount: 1 };
      }
      if (
        normalized.startsWith(
          'INSERT INTO "ql3"."run_dispatch_leases"',
        )
      ) {
        return {
          rows: [{
            attemptId: 'workflow-attempt-1',
            runId: 'workflow-run-1',
            status: 'leased',
            version: 0,
            leaseGeneration: 1,
            workerId: 'edge-1',
            workerSessionId: SESSION_ID,
            workerGeneration: 2,
            leaseTokenDigest: LEASE_DIGEST,
            acquiredAtMs: 10_000,
            renewedAtMs: 10_000,
            expiresAtMs: 40_000,
            releasedAtMs: null,
            releaseReason: null,
            completedAtMs: null,
            updatedAtMs: 10_000,
          }],
          rowCount: 1,
        };
      }
      if (
        normalized.startsWith('UPDATE ') ||
        normalized.startsWith('INSERT INTO ')
      ) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  const repository = new PostgresRunDispatchLeaseRepository({
    async connect() {
      return client;
    },
  });
  const result = await repository.claim({
    runId: 'workflow-run-1',
    attemptId: 'workflow-attempt-1',
    workerId: 'edge-1',
    workerSessionId: SESSION_ID,
    workerGeneration: 2,
    leaseToken: LEASE_TOKEN,
    leaseDurationMs: 30_000,
    eventId: '018f5c64-9b9d-7f1a-8c2d-1234567890a1',
    offerId: 'workflow-offer-1',
  });

  assert.equal(result.status, 'claimed');
  const runUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."runs"'));
  assert.equal(runUpdate.params[1], 'running');
  const event = calls.find(
    ({ sql, params }) =>
      sql.startsWith('INSERT INTO "ql3"."run_events"') &&
      params[3] === 'workflow.task_dispatch_leased',
  );
  assert.equal(event.params[7], 'workflow-step-1');
  assert.match(event.params[8], /"execution_scope":"workflow_task"/);
  assert.equal(calls.at(-2).sql, 'COMMIT');
  assert.equal(calls.at(-1).sql, 'RELEASE');
});
