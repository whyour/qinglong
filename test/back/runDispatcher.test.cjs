require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  RunDispatcher,
} = require('../../back/runtime/application/runDispatcher');
const {
  RunDispatchLeaseFenceRejectedError,
} = require('../../back/runtime/domain/runDispatchLease');

const NOW = 1_760_000_000_000;
const TOKEN = 'dispatcher_lease_token_abcdefghijklmnopqrstuvwxyz0123456789';

function candidate(id, overrides = {}) {
  return {
    runId: `run-${id}`,
    attemptId: `attempt-${id}`,
    projectId: 'default',
    taskId: `task-${id}`,
    taskRevision: 'v1',
    executorType: 'remote_worker',
    priority: 0,
    queuedAtMs: NOW,
    attemptCreatedAtMs: NOW,
    ...overrides,
  };
}

function worker(id, overrides = {}) {
  return {
    id,
    sessionId: `019f7b00-0000-7000-8000-${
      id === 'worker-a' ? '000000000001' : '000000000002'
    }`,
    generation: 1,
    status: 'online',
    version: 0,
    capabilities: {
      architecture: 'arm64',
      operatingSystem: 'linux',
      executors: ['remote_worker'],
      runtimes: [{ name: 'node', version: '24.14.0' }],
      labels: { region: id === 'worker-a' ? 'cn-east' : 'cn-west' },
      capacity: { cpuCores: 2, memoryBytes: 512 * 1024 * 1024 },
      features: [],
    },
    capabilitiesHash: 'a'.repeat(64),
    maxConcurrentRuns: 2,
    availableSlots: 1,
    registeredAtMs: NOW - 10_000,
    lastHeartbeatAtMs: NOW - 1_000,
    leaseExpiresAtMs: NOW + 30_000,
    updatedAtMs: NOW - 1_000,
    ...overrides,
  };
}

function specFor(reference, overrides = {}) {
  return {
    runId: reference.runId,
    attemptId: reference.attemptId,
    projectId: reference.projectId,
    taskId: reference.taskId,
    taskRevision: reference.taskRevision,
    command: { kind: 'argv', file: '/usr/bin/node', args: ['task.js'] },
    environmentPolicy: 'isolated',
    terminationGraceMs: 5_000,
    ...overrides,
  };
}

function leaseFor(request) {
  return {
    attemptId: request.attemptId,
    runId: request.runId,
    status: 'leased',
    version: 0,
    leaseGeneration: 1,
    workerId: request.workerId,
    workerSessionId: request.workerSessionId,
    workerGeneration: request.workerGeneration,
    leaseToken: request.leaseToken,
    acquiredAtMs: NOW,
    renewedAtMs: NOW,
    expiresAtMs: NOW + 30_000,
    updatedAtMs: NOW,
  };
}

function candidateSource(pages, calls = []) {
  let page = 0;
  return {
    async listCandidates(options) {
      calls.push(options);
      return pages[page++] ?? [];
    },
  };
}

function recoverySource(pages, calls = []) {
  let page = 0;
  return {
    async listRecoverable(options) {
      calls.push(options);
      return pages[page++] ?? [];
    },
  };
}

function workerSource(pages, calls = []) {
  let page = 0;
  return {
    async listAvailable(options) {
      calls.push(options);
      const current = pages[page++] ?? [];
      if (!Array.isArray(current)) return current;
      return { workers: current, truncated: false };
    },
  };
}

function planSource(plans, calls = []) {
  return {
    async prepare(reference) {
      calls.push(reference);
      const plan = plans.get(reference.attemptId);
      return plan === undefined ? null : plan;
    },
  };
}

function dispatcher({
  recoveries = recoverySource([[]]),
  candidates,
  workers,
  plans,
  claim,
  options = {},
}) {
  return new RunDispatcher(
    recoveries,
    candidates,
    workers,
    plans,
    { claim },
    {
      clock: { now: () => NOW },
      createLeaseToken: () => TOKEN,
      ...options,
    },
  );
}

test('does no Worker or plan work when there are no candidates', async () => {
  let workerCalls = 0;
  let planCalls = 0;
  let claimCalls = 0;
  const service = dispatcher({
    candidates: candidateSource([[]]),
    workers: {
      async listAvailable() {
        workerCalls += 1;
        return { workers: [], truncated: false };
      },
    },
    plans: {
      async prepare() {
        planCalls += 1;
        return null;
      },
    },
    async claim() {
      claimCalls += 1;
      return { status: 'not_eligible' };
    },
  });

  const result = await service.dispatchOnce();
  assert.deepEqual([result.status, result.reason], ['idle', 'no_candidates']);
  assert.deepEqual([workerCalls, planCalls, claimCalls], [0, 0, 0]);
});

test('selects by Placement, claims the persisted Worker fence, and returns a cloned offer', async () => {
  const reference = candidate('preferred');
  const sourceSpec = specFor(reference);
  const claims = [];
  const service = dispatcher({
    candidates: candidateSource([[reference]]),
    workers: workerSource([[worker('worker-b'), worker('worker-a')]]),
    plans: planSource(
      new Map([
        [
          reference.attemptId,
          {
            placement: {
              preferred: [{ labels: { region: 'cn-east' }, weight: 50 }],
            },
            executionSpec: sourceSpec,
          },
        ],
      ]),
    ),
    async claim(principal, request) {
      claims.push({ principal, request });
      return { status: 'claimed', lease: leaseFor(request), event: {} };
    },
  });

  const result = await service.dispatchOnce();
  assert.equal(result.status, 'offered');
  assert.equal(result.offer.deliveryKind, 'new_claim');
  assert.match(result.offer.offerId, /^[0-9a-f]{64}$/);
  assert.match(result.offer.executionSpecDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.offer.worker.id, 'worker-a');
  assert.equal(result.offer.placementScore, 50);
  assert.deepEqual(claims[0].principal, { workerId: 'worker-a' });
  assert.equal(claims[0].request.workerSessionId, worker('worker-a').sessionId);
  sourceSpec.command.args[0] = 'mutated.js';
  assert.deepEqual(result.offer.executionSpec.command.args, ['task.js']);
});

test('uses bounded candidate pagination to find the next placeable run', async () => {
  const first = candidate('first');
  const second = candidate('second', {
    queuedAtMs: NOW + 1,
    attemptCreatedAtMs: NOW + 1,
  });
  const candidateCalls = [];
  const plans = new Map([
    [
      first.attemptId,
      {
        placement: { required: { architectures: ['x64'] } },
        executionSpec: specFor(first),
      },
    ],
    [second.attemptId, { placement: {}, executionSpec: specFor(second) }],
  ]);
  const service = dispatcher({
    candidates: candidateSource([[first], [second]], candidateCalls),
    workers: workerSource([[worker('worker-a')]]),
    plans: planSource(plans),
    async claim(_principal, request) {
      return { status: 'claimed', lease: leaseFor(request), event: {} };
    },
    options: { candidatePageSize: 1, maxCandidatePages: 2 },
  });

  const result = await service.dispatchOnce();
  assert.equal(result.status, 'offered');
  assert.equal(result.offer.candidate.attemptId, second.attemptId);
  assert.equal(result.stats.candidatePages, 2);
  assert.equal(candidateCalls[1].after.attemptId, first.attemptId);
});

test('tries the next ranked Worker after a capacity race', async () => {
  const reference = candidate('capacity');
  const attemptedWorkers = [];
  const service = dispatcher({
    candidates: candidateSource([[reference]]),
    workers: workerSource([[worker('worker-a'), worker('worker-b')]]),
    plans: planSource(
      new Map([
        [
          reference.attemptId,
          { placement: {}, executionSpec: specFor(reference) },
        ],
      ]),
    ),
    async claim(_principal, request) {
      attemptedWorkers.push(request.workerId);
      return request.workerId === 'worker-a'
        ? { status: 'capacity_exhausted' }
        : { status: 'claimed', lease: leaseFor(request), event: {} };
    },
  });

  const result = await service.dispatchOnce();
  assert.equal(result.status, 'offered');
  assert.deepEqual(attemptedWorkers, ['worker-a', 'worker-b']);
  assert.equal(result.stats.claimAttempts, 2);
  assert.equal(result.stats.claimRaces, 1);
});

test('does not expose an unclaimed ExecutionSpec after losing the claim race', async () => {
  const reference = candidate('race');
  const secret = 'must-stay-in-control-plane-memory';
  const service = dispatcher({
    candidates: candidateSource([[reference]]),
    workers: workerSource([[worker('worker-a')]]),
    plans: planSource(
      new Map([
        [
          reference.attemptId,
          {
            placement: {},
            executionSpec: specFor(reference, {
              command: { kind: 'shell', command: secret },
            }),
          },
        ],
      ]),
    ),
    async claim() {
      return { status: 'leased', lease: {} };
    },
  });

  const result = await service.dispatchOnce();
  assert.deepEqual([result.status, result.reason], ['idle', 'claim_raced']);
  assert.equal(Object.hasOwn(result, 'offer'), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('rejects invalid or mismatched specs before attempting a claim', async () => {
  const reference = candidate('invalid');
  let claimCalls = 0;
  const create = (executionSpec) =>
    dispatcher({
      candidates: candidateSource([[reference]]),
      workers: workerSource([[worker('worker-a')]]),
      plans: planSource(
        new Map([[reference.attemptId, { placement: {}, executionSpec }]]),
      ),
      async claim() {
        claimCalls += 1;
        return { status: 'not_eligible' };
      },
    });

  await assert.rejects(
    create(
      specFor(reference, { command: { kind: 'argv', file: '', args: [] } }),
    ).dispatchOnce(),
    /command file must be non-empty/,
  );
  await assert.rejects(
    create(
      specFor(reference, { attemptId: 'attempt-someone-else' }),
    ).dispatchOnce(),
    /identity does not match/,
  );
  assert.equal(claimCalls, 0);
});

test('enforces global claim and scan budgets', async () => {
  const reference = candidate('budget');
  const service = dispatcher({
    candidates: candidateSource([[reference]]),
    workers: workerSource([[worker('worker-a'), worker('worker-b')]]),
    plans: planSource(
      new Map([
        [
          reference.attemptId,
          { placement: {}, executionSpec: specFor(reference) },
        ],
      ]),
    ),
    async claim() {
      return { status: 'capacity_exhausted' };
    },
    options: { maxClaimAttempts: 1 },
  });

  const result = await service.dispatchOnce();
  assert.deepEqual(
    [
      result.status,
      result.reason,
      result.stats.claimAttempts,
      result.truncated,
    ],
    ['idle', 'claim_budget_exhausted', 1, true],
  );
  assert.throws(
    () =>
      dispatcher({
        candidates: candidateSource([[]]),
        workers: workerSource([[]]),
        plans: planSource(new Map()),
        async claim() {
          return { status: 'not_eligible' };
        },
        options: { workerPageSize: 64, maxWorkerPages: 2 },
      }),
    /must not exceed 64/,
  );
});

test('treats a database CAS version conflict as a bounded claim race', async () => {
  const reference = candidate('cas');
  const service = dispatcher({
    candidates: candidateSource([[reference]]),
    workers: workerSource([[worker('worker-a')]]),
    plans: planSource(
      new Map([
        [
          reference.attemptId,
          { placement: {}, executionSpec: specFor(reference) },
        ],
      ]),
    ),
    async claim() {
      throw new RunDispatchLeaseFenceRejectedError(
        reference.attemptId,
        'version_mismatch',
      );
    },
  });

  const result = await service.dispatchOnce();
  assert.deepEqual([result.status, result.reason], ['idle', 'claim_raced']);
  assert.equal(result.stats.claimRaces, 1);
});

test('recovers an active lease before discovery with one stable offer ID', async () => {
  const reference = candidate('recovery');
  const lease = leaseFor({
    runId: reference.runId,
    attemptId: reference.attemptId,
    workerId: 'worker-a',
    workerSessionId: worker('worker-a').sessionId,
    workerGeneration: 1,
    leaseToken: TOKEN,
  });
  const recovery = { candidate: reference, lease };
  let candidateCalls = 0;
  let workerCalls = 0;
  let claimCalls = 0;
  const create = () =>
    dispatcher({
      recoveries: {
        async listRecoverable() {
          return [recovery];
        },
      },
      candidates: {
        async listCandidates() {
          candidateCalls += 1;
          return [];
        },
      },
      workers: {
        async listAvailable() {
          workerCalls += 1;
          return { workers: [], truncated: false };
        },
      },
      plans: planSource(
        new Map([
          [
            reference.attemptId,
            { placement: {}, executionSpec: specFor(reference) },
          ],
        ]),
      ),
      async claim() {
        claimCalls += 1;
        return { status: 'not_eligible' };
      },
    });

  const first = await create().dispatchOnce();
  const second = await create().dispatchOnce();
  assert.equal(first.status, 'offered');
  assert.equal(first.offer.deliveryKind, 'lease_recovery');
  assert.equal(first.offer.offerId, second.offer.offerId);
  assert.equal(
    first.offer.executionSpecDigest,
    second.offer.executionSpecDigest,
  );
  assert.deepEqual(first.offer.worker, {
    id: lease.workerId,
    sessionId: lease.workerSessionId,
    generation: lease.workerGeneration,
  });
  assert.deepEqual([candidateCalls, workerCalls, claimCalls], [0, 0, 0]);
});

test('fails closed when a recovered plan no longer matches its pinned revision', async () => {
  const reference = candidate('drift');
  const lease = leaseFor({
    runId: reference.runId,
    attemptId: reference.attemptId,
    workerId: 'worker-a',
    workerSessionId: worker('worker-a').sessionId,
    workerGeneration: 1,
    leaseToken: TOKEN,
  });
  const service = dispatcher({
    recoveries: recoverySource([[{ candidate: reference, lease }]]),
    candidates: candidateSource([[]]),
    workers: workerSource([[]]),
    plans: planSource(
      new Map([
        [
          reference.attemptId,
          {
            placement: {},
            executionSpec: specFor(reference, { taskRevision: 'v2-drift' }),
          },
        ],
      ]),
    ),
    async claim() {
      return { status: 'not_eligible' };
    },
  });

  await assert.rejects(service.dispatchOnce(), /identity does not match/);
});

test('reports unavailable recovery plans and bounds recovery pagination', async () => {
  const reference = candidate('missing-plan');
  const lease = leaseFor({
    runId: reference.runId,
    attemptId: reference.attemptId,
    workerId: 'worker-a',
    workerSessionId: worker('worker-a').sessionId,
    workerGeneration: 1,
    leaseToken: TOKEN,
  });
  const create = (options = {}) =>
    dispatcher({
      recoveries: recoverySource([[{ candidate: reference, lease }]]),
      candidates: candidateSource([[]]),
      workers: workerSource([[]]),
      plans: planSource(new Map()),
      async claim() {
        return { status: 'not_eligible' };
      },
      options,
    });

  const unavailable = await create().dispatchOnce();
  assert.deepEqual(
    [unavailable.status, unavailable.reason],
    ['idle', 'recovery_plans_unavailable'],
  );

  const bounded = await create({
    recoveryPageSize: 1,
    maxRecoveryPages: 1,
  }).dispatchOnce();
  assert.deepEqual(
    [bounded.status, bounded.reason, bounded.truncated],
    ['idle', 'recovery_scan_budget_exhausted', true],
  );
});
