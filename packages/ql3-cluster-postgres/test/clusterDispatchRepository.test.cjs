const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  PostgresClusterDispatchSource,
} = require('../dist/remote-execution/clusterDispatchRepository');

const SESSION = '018f0000-0000-7000-8000-000000000001';

function candidateRow(overrides = {}) {
  return {
    observedAtMs: '1000',
    runId: 'run-1',
    attemptId: 'attempt-1',
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: `qltd:v1:1:${'a'.repeat(64)}`,
    priority: 4,
    queuedAtMs: '100',
    attemptCreatedAtMs: '101',
    attemptNumber: 1,
    executorType: 'remote_worker',
    ...overrides,
  };
}

function leaseRow(overrides = {}) {
  return candidateRow({
    leaseStatus: 'leased',
    leaseVersion: 0,
    leaseGeneration: 1,
    workerId: 'edge-1',
    workerSessionId: SESSION,
    workerGeneration: 2,
    leaseTokenDigest: createHash('sha256').update('x'.repeat(32)).digest('hex'),
    acquiredAtMs: '900',
    renewedAtMs: '900',
    expiresAtMs: '1900',
    releasedAtMs: null,
    releaseReason: null,
    completedAtMs: null,
    leaseUpdatedAtMs: '900',
    workerCurrent: true,
    ...overrides,
  });
}

test('lists a bounded PostgreSQL-clock candidate page with stable cursor parameters', async () => {
  let observed;
  const source = new PostgresClusterDispatchSource({
    async query(sql, params) {
      observed = { sql, params };
      return { rows: [candidateRow(), candidateRow({ attemptId: 'attempt-2' })] };
    },
  });
  const page = await source.listClusterDispatchCandidates({ limit: 1 });
  assert.equal(page.observedAtMs, 1000);
  assert.equal(page.candidates.length, 1);
  assert.equal(page.truncated, true);
  assert.equal(page.next.attemptId, 'attempt-1');
  assert.deepEqual(observed.params, [null, null, null, null, 2]);
  assert.match(observed.sql, /clock_timestamp\(\)/);
  assert.match(observed.sql, /lease\.expires_at_ms <= observation\.observed_at_ms/);
  assert.match(
    observed.sql,
    /plugin_package_workflow_task_attempt_admissions/,
  );
  assert.match(observed.sql, /workflow_step\.status = 'ready'/);
  assert.match(
    observed.sql,
    /newer\.step_run_id = attempt\.step_run_id/,
  );
});

test('returns one exact offer recovery with durable lease and Worker fence evidence', async () => {
  const source = new PostgresClusterDispatchSource({
    async query(sql, params) {
      assert.match(sql, /worker\.lease_expires_at_ms > observation\.observed_at_ms/);
      assert.deepEqual(params, ['offer-1']);
      return { rows: [leaseRow()] };
    },
  });
  const recovery = await source.findClusterDispatchRecovery('offer-1');
  assert.equal(recovery.workerCurrent, true);
  assert.equal(recovery.lease.workerSessionId, SESSION);
  assert.equal(recovery.candidate.executorType, 'remote_worker');
});
