'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createClusterTaskExecutionRevision,
} = require('@qinglong/runtime-core/cluster-execution-revision');
const {
  digestRunDispatchLeaseToken,
} = require('@qinglong/runtime-core/run-dispatch-lease');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  PostgresRemoteWorkerSecretDeliveryAuthorityRepository,
} = require('../dist/worker-credential/remoteWorkerSecretDeliveryRepository');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';
const SOURCE_DIGEST = 'a'.repeat(64);
const TASK_REVISION = `qltd:v1:1:${SOURCE_DIGEST}`;
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';
const SECRET_REF = createSecretRef({ projectId: 'project-1', name: 'token' });

function revision() {
  return createClusterTaskExecutionRevision({
    projectId: 'project-1', taskId: 'task-1', taskRevision: TASK_REVISION,
    sourceRevision: 1, sourceContentDigest: SOURCE_DIGEST,
    executorType: 'remote_worker', planSchema: 'qinglong/command-execution@v1',
    command: { kind: 'argv', file: '/bin/true', args: [] },
    environment: [{ name: 'TOKEN', kind: 'secret', secretRef: SECRET_REF }],
    createdAtMs: 1,
  });
}

function command(executionDigest, overrides = {}) {
  return {
    workerId: 'edge-1', workerSessionId: SESSION_ID, workerGeneration: 2,
    runId: 'run-1', attemptId: 'attempt-1', projectId: 'project-1',
    taskId: 'task-1', taskRevision: TASK_REVISION, executionDigest,
    offerId: 'offer-1', leaseGeneration: 3, leaseToken: LEASE_TOKEN,
    expectedLeaseVersion: 4, secretRefs: [SECRET_REF], ...overrides,
  };
}

function authorityRow(plan, overrides = {}) {
  return {
    observedAtMs: '1000', runId: 'run-1', runProjectId: 'project-1',
    runTaskId: 'task-1', runTaskRevision: TASK_REVISION,
    runStatus: 'dispatching', executionOwner: 'runtime',
    cancelRequestedAtMs: null, attemptStatus: 'starting',
    attemptExecutorType: 'remote_worker', attemptWorkerId: 'edge-1',
    attemptWorkerSessionId: SESSION_ID, attemptWorkerGeneration: 2,
    attemptLeaseTokenDigest: digestRunDispatchLeaseToken(LEASE_TOKEN),
    attemptLeaseGeneration: 3, attemptLeaseVersion: 4,
    attemptOfferId: 'offer-1', sessionId: SESSION_ID, sessionGeneration: 2,
    sessionStatus: 'online', sessionExpiresAtMs: '5000',
    leaseRunId: 'run-1', leaseStatus: 'leased', leaseVersion: 4,
    leaseGeneration: 3, leaseWorkerId: 'edge-1',
    leaseWorkerSessionId: SESSION_ID, leaseWorkerGeneration: 2,
    leaseTokenDigest: digestRunDispatchLeaseToken(LEASE_TOKEN),
    leaseOfferId: 'offer-1', leaseExpiresAtMs: '5000',
    revisionProjectId: plan.projectId, revisionTaskId: plan.taskId,
    sourceRevision: plan.sourceRevision,
    revisionTaskRevision: plan.taskRevision,
    sourceContentDigest: plan.sourceContentDigest,
    revisionExecutorType: plan.executorType, planSchema: plan.planSchema,
    planJson: {
      command: plan.command,
      environment: plan.environment,
      ...(plan.workingDirectory === undefined ? {} : { workingDirectory: plan.workingDirectory }),
      ...(plan.timeoutMs === undefined ? {} : { timeoutMs: plan.timeoutMs }),
      ...(plan.placement === undefined ? {} : { placement: plan.placement }),
    },
    revisionContentDigest: plan.contentDigest,
    revisionCreatedAtMs: String(plan.createdAtMs),
    ...overrides,
  };
}

function fixture(row) {
  const queries = [];
  let released = 0;
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM observation')) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
    release() { released += 1; },
  };
  return {
    repository: new PostgresRemoteWorkerSecretDeliveryAuthorityRepository({
      async connect() { return client; },
    }),
    queries,
    released: () => released,
  };
}

test('authorizes exact Session, Lease and immutable execution revision fences', async () => {
  const plan = revision();
  const { repository, queries, released } = fixture(authorityRow(plan));
  const result = await repository.authorize(command(plan.contentDigest));
  assert.deepEqual(result.secretRefs, [SECRET_REF]);
  assert.equal(result.executionDigest, plan.contentDigest);
  assert.equal('leaseToken' in result, false);
  assert.equal(queries.some(({ sql }) => sql.includes('pg_advisory_xact_lock')), true);
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(released(), 1);
});

test('rejects expired or replayed Lease authority before returning Secret scope', async () => {
  const plan = revision();
  for (const overrides of [
    { leaseVersion: 5 },
    { leaseExpiresAtMs: '1000' },
    { sessionExpiresAtMs: '1000' },
    { attemptStatus: 'running' },
  ]) {
    const { repository, queries } = fixture(authorityRow(plan, overrides));
    await assert.rejects(
      repository.authorize(command(plan.contentDigest)),
      /authority_mismatch/,
    );
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
  }
});

test('rejects partial Secret scope and execution digest drift', async () => {
  const plan = revision();
  const extra = createSecretRef({ projectId: 'project-1', name: 'other' });
  const partial = fixture(authorityRow(plan));
  await assert.rejects(
    partial.repository.authorize(command(plan.contentDigest, {
      secretRefs: [extra],
    })),
    /secret_scope_mismatch/,
  );
  const digestDrift = fixture(authorityRow(plan));
  await assert.rejects(
    digestDrift.repository.authorize(command('b'.repeat(64))),
    /secret_scope_mismatch/,
  );
});
