const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterControlRecoveryEvidenceRegistry,
  MAX_CLUSTER_CONTROL_RECOVERY_EVIDENCE_PROVIDERS,
} = require('../dist');

function claim() {
  return {
    candidate: {
      kind: 'attempt',
      id: 'attempt-1',
      runId: 'run-1',
      status: 'running',
      createdAtMs: 1,
    },
    observedAtMs: 100,
    ownerId: 'replica-a',
    token: '123e4567-e89b-42d3-a456-426614174000',
    version: 1,
    expiresAtMs: 30_100,
  };
}

function target(overrides = {}) {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    attemptStatus: 'running',
    executorType: 'remote_worker',
    callbackSequence: 3,
    workerId: 'worker-a',
    executorHandle: 'offer-1',
    leaseToken: 'lease-token-123456',
    leaseExpiresAtMs: 99,
    startedAtMs: 10,
    ...overrides,
  };
}

test('routes one exact executor identity without exposing the recovery claim', async () => {
  const calls = [];
  const provider = {
    executorType: 'remote_worker',
    requiredIdentity: ['workerId', 'executorHandle', 'leaseToken'],
    async inspect(current, context) {
      calls.push([current, context]);
      assert.equal(Object.isFrozen(current), true);
      assert.equal(Object.isFrozen(context), true);
      assert.equal(context.timeoutMs, 100);
      assert.equal(context.signal.aborted, false);
      assert.equal('token' in current, false);
      assert.equal('ownerId' in current, false);
      return { status: 'running', ignored: 'not propagated' };
    },
  };
  const registry = new ClusterControlRecoveryEvidenceRegistry([provider], {
    timeoutMs: 100,
  });
  provider.inspect = async () => ({ status: 'not_running' });

  assert.deepEqual(await registry.inspect(claim(), target()), {
    status: 'running',
  });
  assert.equal(calls.length, 1);
  registry.dispose();
});

test('fails closed for unknown executors and incomplete or malformed identities', async () => {
  let calls = 0;
  const registry = new ClusterControlRecoveryEvidenceRegistry([
    {
      executorType: 'remote_worker',
      requiredIdentity: ['workerId', 'leaseToken'],
      async inspect() {
        calls += 1;
        return { status: 'not_running' };
      },
    },
  ]);

  assert.deepEqual(
    await registry.inspect(claim(), target({ executorType: 'kubernetes' })),
    { status: 'unknown', reason: 'identity_unverifiable' },
  );
  assert.deepEqual(
    await registry.inspect(claim(), target({ leaseToken: undefined })),
    { status: 'unknown', reason: 'identity_unverifiable' },
  );
  assert.deepEqual(
    await registry.inspect(claim(), target({ callbackSequence: -1 })),
    { status: 'unknown', reason: 'identity_unverifiable' },
  );
  assert.equal(calls, 0);
  registry.dispose();
});

test('maps provider failure and malformed evidence without leaking errors', async () => {
  const failing = new ClusterControlRecoveryEvidenceRegistry([
    {
      executorType: 'remote_worker',
      requiredIdentity: ['workerId'],
      async inspect() {
        throw new Error('sensitive transport failure');
      },
    },
  ]);
  assert.deepEqual(await failing.inspect(claim(), target()), {
    status: 'unknown',
    reason: 'provider_unavailable',
  });
  failing.dispose();

  const malformed = new ClusterControlRecoveryEvidenceRegistry([
    {
      executorType: 'remote_worker',
      requiredIdentity: ['workerId'],
      async inspect() {
        return { status: 'not_running', reason: 'untrusted-extra' };
      },
    },
  ]);
  assert.deepEqual(await malformed.inspect(claim(), target()), {
    status: 'not_running',
  });
  malformed.dispose();
});

test('times out once per provider and prevents abandoned probe accumulation', async () => {
  const keepAlive = setInterval(() => {}, 1_000);
  let release;
  let calls = 0;
  let firstSignal;
  const registry = new ClusterControlRecoveryEvidenceRegistry(
    [
      {
        executorType: 'remote_worker',
        requiredIdentity: ['workerId'],
        inspect(_target, context) {
          calls += 1;
          firstSignal = context.signal;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
    ],
    { timeoutMs: 5 },
  );

  try {
    assert.deepEqual(await registry.inspect(claim(), target()), {
      status: 'unknown',
      reason: 'provider_unavailable',
    });
    assert.equal(firstSignal.aborted, true);
    assert.deepEqual(await registry.inspect(claim(), target()), {
      status: 'unknown',
      reason: 'provider_unavailable',
    });
    assert.equal(calls, 1);

    release({ status: 'running' });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    clearInterval(keepAlive);
    registry.dispose();
  }
});

test('dispose aborts an active provider and permanently fails closed', async () => {
  let signal;
  const registry = new ClusterControlRecoveryEvidenceRegistry(
    [
      {
        executorType: 'remote_worker',
        requiredIdentity: ['workerId'],
        inspect(_target, context) {
          signal = context.signal;
          return new Promise(() => {});
        },
      },
    ],
    { timeoutMs: 1_000 },
  );

  const inspection = registry.inspect(claim(), target());
  await new Promise((resolve) => setImmediate(resolve));
  registry.dispose();
  assert.equal(signal.aborted, true);
  assert.deepEqual(await inspection, {
    status: 'unknown',
    reason: 'provider_unavailable',
  });
  assert.deepEqual(await registry.inspect(claim(), target()), {
    status: 'unknown',
    reason: 'provider_unavailable',
  });
});

test('rejects duplicate, wildcard, identity-free and unbounded registrations', () => {
  const provider = {
    executorType: 'remote_worker',
    requiredIdentity: ['workerId'],
    async inspect() {
      return { status: 'running' };
    },
  };
  assert.throws(
    () => new ClusterControlRecoveryEvidenceRegistry([provider, provider]),
    /Duplicate/,
  );
  assert.throws(
    () =>
      new ClusterControlRecoveryEvidenceRegistry([
        { ...provider, executorType: '*' },
      ]),
    /executorType/,
  );
  assert.throws(
    () =>
      new ClusterControlRecoveryEvidenceRegistry([
        { ...provider, requiredIdentity: [] },
      ]),
    /requires an execution identity/,
  );
  assert.throws(
    () =>
      new ClusterControlRecoveryEvidenceRegistry(
        Array.from(
          { length: MAX_CLUSTER_CONTROL_RECOVERY_EVIDENCE_PROVIDERS + 1 },
          (_, index) => ({
            ...provider,
            executorType: `worker_${index}`,
          }),
        ),
      ),
    /cannot exceed/,
  );
});
