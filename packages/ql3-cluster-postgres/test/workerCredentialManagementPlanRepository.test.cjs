const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  WorkerCredentialManagementPlanConflictError,
  WorkerCredentialManagementPlanUnavailableError,
  createWorkerCredentialManagementPlan,
} = require('@qinglong/runtime-core/worker-credential-management-plan');
const {
  PostgresWorkerCredentialManagementPlanRepository,
} = require('@qinglong/cluster-postgres/worker-credential-management-plan');

function plan(actionRef = 'worker-credential:worker-a:generation-2') {
  return createWorkerCredentialManagementPlan({
    actionRef,
    authorityProjectId: 'cluster-instance-authority',
    action: 'rotate',
    target: {
      deliveryId: '123e4567-e89b-42d3-a456-426614174702',
      workerId: 'worker-a',
      credentialId: 'credential-b',
      previousCredentialId: 'credential-a',
      credentialNotBeforeAtMs: 11_000,
      credentialExpiresAtMs: 21_000,
      deploymentTargetDigest: '1'.repeat(64),
      deploymentGeneration: 'generation-2',
    },
    requestedBy: { type: 'user', id: 'operator-a' },
    plannedAtMs: 10_000,
    expiresAtMs: 20_000,
  });
}

function fixture() {
  const stored = new Map();
  const queries = [];
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes('INSERT INTO')) {
        const actionRef = values[0];
        if (stored.has(actionRef)) return { rows: [], rowCount: 0 };
        stored.set(actionRef, JSON.parse(values[17]));
        return { rows: [{ actionRef }], rowCount: 1 };
      }
      if (text.includes('SELECT plan_json')) {
        const value = stored.get(values[0]);
        return { rows: value ? [{ planJson: value }] : [], rowCount: value ? 1 : 0 };
      }
      throw new Error('unexpected query');
    },
  };
  return {
    repository: new PostgresWorkerCredentialManagementPlanRepository(pool),
    stored,
    queries,
  };
}

test('creates and exactly replays one immutable Worker credential plan', async () => {
  const state = fixture();
  const expected = plan();
  const created = await state.repository.create(expected);
  const replay = await state.repository.create(expected);
  assert.equal(created.status, 'created');
  assert.equal(replay.status, 'existing');
  assert.deepEqual(created.plan, expected);
  assert.deepEqual(replay.plan, expected);
  assert.equal(state.stored.size, 1);
  const insert = state.queries.find(({ text }) => text.includes('INSERT INTO'));
  assert.equal(insert.values.includes('credential-a'), true);
  assert.equal(insert.values.some((value) => /ql3w|token/i.test(String(value))), false);
});

test('replays the stored plan when only server-authored time fields differ', async () => {
  const state = fixture();
  const first = plan();
  const replayedRequest = createWorkerCredentialManagementPlan({
    actionRef: first.actionRef,
    authorityProjectId: first.authorityProjectId,
    action: first.action,
    target: first.target,
    requestedBy: first.requestedBy,
    plannedAtMs: first.plannedAtMs + 500,
    expiresAtMs: first.expiresAtMs + 500,
  });
  assert.notEqual(replayedRequest.planDigest, first.planDigest);
  await state.repository.create(first);
  const replay = await state.repository.create(replayedRequest);
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.plan, first);
  assert.equal(state.stored.size, 1);
});

test('rejects an actionRef replay bound to different plan content', async () => {
  const state = fixture();
  const first = plan();
  await state.repository.create(first);
  const changed = createWorkerCredentialManagementPlan({
    actionRef: first.actionRef,
    authorityProjectId: first.authorityProjectId,
    action: first.action,
    target: {
      ...first.target,
      deploymentGeneration: 'generation-3',
    },
    requestedBy: first.requestedBy,
    plannedAtMs: first.plannedAtMs,
    expiresAtMs: first.expiresAtMs,
  });
  await assert.rejects(
    state.repository.create(changed),
    WorkerCredentialManagementPlanConflictError,
  );
});

test('maps malformed durable JSON and storage errors to unavailable', async () => {
  const malformed = {
    async query() {
      return { rows: [{ planJson: { schema: 'wrong' } }], rowCount: 1 };
    },
  };
  await assert.rejects(
    new PostgresWorkerCredentialManagementPlanRepository(malformed)
      .findByActionRef('worker-credential:worker-a:generation-2'),
    WorkerCredentialManagementPlanUnavailableError,
  );
  const failed = {
    async query() { throw new Error('sensitive database failure'); },
  };
  await assert.rejects(
    new PostgresWorkerCredentialManagementPlanRepository(failed)
      .findByActionRef('worker-credential:worker-a:generation-2'),
    (error) => {
      assert.ok(error instanceof WorkerCredentialManagementPlanUnavailableError);
      assert.doesNotMatch(error.message, /sensitive|database failure/i);
      return true;
    },
  );
});
