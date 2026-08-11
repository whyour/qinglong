require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ApprovedActionRecoveryReconciler,
} = require('../../back/runtime/application/approvedActionRecoveryReconciler');

function recoverySnapshot() {
  return {
    action: {
      dispatch: {
        id: 'dispatch-one',
        approvalRequestId: 'approval-one',
        approvalRequestVersion: 3,
        projectId: 'default',
        state: 'pending',
        action: {
          permission: 'tool.call:filesystem.write',
          actionType: 'tool_call',
          actionRef: 'planned-one',
          actionDigest: 'a'.repeat(64),
          previewDigest: 'f'.repeat(64),
        },
        requestedBy: { type: 'agent', id: 'agent-1' },
        consumedBy: { type: 'system', id: 'approval-dispatcher' },
        createdAtMs: 100,
      },
      execution: {
        dispatchId: 'dispatch-one',
        projectId: 'default',
        status: 'executing',
        version: 2,
        attemptCount: 1,
        maxAttempts: 5,
        eligibleAtMs: null,
        nextAttemptAtMs: null,
        leaseOwner: 'dispatcher-1',
        leaseToken: 'execution-lease-1',
        leaseExpiresAtMs: 200,
        startedAtMs: 110,
        resultMutationId: null,
        lastResultCode: null,
        completedAtMs: null,
        createdAtMs: 100,
        updatedAtMs: 110,
      },
    },
    recovery: {
      dispatchId: 'dispatch-one',
      projectId: 'default',
      executionVersion: 2,
      status: 'armed',
      version: 0,
      nextScanAtMs: 200,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAtMs: null,
      findingCount: 0,
      lastFindingMutationId: null,
      lastFinding: null,
      lastResultCode: null,
      lastEvidenceDigest: null,
      resolutionMutationId: null,
      createdAtMs: 110,
      updatedAtMs: 110,
    },
    resolution: null,
  };
}

function fakeRepository() {
  const calls = [];
  const initial = recoverySnapshot();
  return {
    calls,
    async listDue(query) {
      calls.push(['list', query]);
      return { recoveries: [initial], truncated: false };
    },
    async claim(command) {
      calls.push(['claim', command]);
      return {
        status: 'claimed',
        snapshot: {
          ...initial,
          recovery: {
            ...initial.recovery,
            status: 'leased',
            version: 1,
            nextScanAtMs: command.nowMs + command.leaseDurationMs,
            leaseOwner: command.owner,
            leaseToken: command.leaseToken,
            leaseExpiresAtMs: command.nowMs + command.leaseDurationMs,
            updatedAtMs: command.nowMs,
          },
        },
      };
    },
    async recordFinding(command) {
      calls.push(['finding', command]);
      return {
        ...initial,
        recovery: {
          ...initial.recovery,
          status: command.retryAtMs ? 'armed' : 'manual_required',
          version: command.expectedRecoveryVersion + 1,
          nextScanAtMs: command.retryAtMs ?? null,
          findingCount: 1,
          lastFindingMutationId: command.findingMutationId,
          lastFinding: command.finding,
          lastResultCode: command.resultCode,
          lastEvidenceDigest: command.evidenceDigest ?? null,
          updatedAtMs: command.observedAtMs,
        },
      };
    },
    async resolve(command) {
      calls.push(['resolve', command]);
      const status =
        command.decision === 'confirm_succeeded' ? 'succeeded' : 'failed';
      return {
        status: 'resolved',
        snapshot: {
          ...initial,
          action: {
            ...initial.action,
            execution: {
              ...initial.action.execution,
              status,
              version: command.expectedExecutionVersion + 1,
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAtMs: null,
              resultMutationId: command.mutationId,
              lastResultCode: command.reasonCode,
              completedAtMs: command.resolvedAtMs,
              updatedAtMs: command.resolvedAtMs,
            },
          },
          recovery: {
            ...initial.recovery,
            status: 'resolved',
            version: command.expectedRecoveryVersion + 1,
            executionVersion: command.expectedExecutionVersion + 1,
            nextScanAtMs: null,
            resolutionMutationId: command.mutationId,
            updatedAtMs: command.resolvedAtMs,
          },
        },
      };
    },
  };
}

function options() {
  let now = 200;
  let id = 0;
  return {
    owner: 'resolver-1',
    leaseDurationMs: 1_000,
    retryBaseMs: 10,
    retryMaxMs: 100,
    clock: () => ++now,
    createId: () => `recovery-mutation-${++id}`,
  };
}

function provider(overrides = {}) {
  return {
    actionType: 'tool_call',
    capability: 'automatic',
    async inspect() {
      return {
        finding: 'verified_succeeded',
        resultCode: 'provider_receipt_verified',
        evidenceDigest: 'e'.repeat(64),
      };
    },
    ...overrides,
  };
}

test('verified evidence resolves without exposing an execute capability', async () => {
  const repository = fakeRepository();
  let inspected = 0;
  const reconciler = new ApprovedActionRecoveryReconciler(
    repository,
    [
      provider({
        async inspect(context) {
          inspected += 1;
          assert.equal(context.idempotencyKey, 'dispatch-one');
          assert.equal(context.snapshot.action.execution.status, 'executing');
          assert.equal('execute' in context, false);
          return {
            finding: 'verified_succeeded',
            resultCode: 'provider_receipt_verified',
            evidenceDigest: 'e'.repeat(64),
          };
        },
      }),
    ],
    options(),
  );
  const summary = await reconciler.reconcileBatch({ limit: 1 });
  assert.equal(inspected, 1);
  assert.deepEqual(
    repository.calls.map((entry) => entry[0]),
    ['list', 'claim', 'resolve'],
  );
  assert.equal(summary.verifiedSucceeded, 1);
  assert.equal(summary.manualRequired, 0);
});

test('manual-only providers are never inspected and move to manual-required', async () => {
  const repository = fakeRepository();
  let inspected = false;
  const reconciler = new ApprovedActionRecoveryReconciler(
    repository,
    [
      provider({
        capability: 'manual_only',
        async inspect() {
          inspected = true;
          throw new Error('must not be called');
        },
      }),
    ],
    options(),
  );
  const summary = await reconciler.reconcileBatch();
  assert.equal(inspected, false);
  const finding = repository.calls.find((entry) => entry[0] === 'finding')[1];
  assert.equal(finding.finding, 'unsupported');
  assert.equal('retryAtMs' in finding, false);
  assert.equal(summary.manualRequired, 1);
});

test('missing and unavailable evidence defer with bounded retry instead of resolving', async () => {
  for (const inspect of [
    async () => ({ finding: 'missing', resultCode: 'receipt_missing' }),
    async () => {
      throw new Error('provider unavailable');
    },
  ]) {
    const repository = fakeRepository();
    const reconciler = new ApprovedActionRecoveryReconciler(
      repository,
      [provider({ inspect })],
      options(),
    );
    const summary = await reconciler.reconcileBatch();
    const finding = repository.calls.find((entry) => entry[0] === 'finding')[1];
    assert.ok(['missing', 'unavailable'].includes(finding.finding));
    assert.ok(finding.retryAtMs > finding.observedAtMs);
    assert.equal(
      repository.calls.some((entry) => entry[0] === 'resolve'),
      false,
    );
    assert.equal(summary.deferred, 1);
  }
});

test('extensible or malformed evidence fails closed into manual review', async () => {
  const repository = fakeRepository();
  const reconciler = new ApprovedActionRecoveryReconciler(
    repository,
    [
      provider({
        async inspect() {
          return {
            finding: 'verified_succeeded',
            resultCode: 'ok',
            evidenceDigest: 'e'.repeat(64),
            injected: true,
          };
        },
      }),
    ],
    options(),
  );
  const summary = await reconciler.reconcileBatch();
  const finding = repository.calls.find((entry) => entry[0] === 'finding')[1];
  assert.equal(finding.finding, 'conflict');
  assert.equal(finding.resultCode, 'recovery_evidence_invalid');
  assert.equal('retryAtMs' in finding, false);
  assert.equal(summary.manualRequired, 1);
});

test('rejects duplicate providers and keeps each batch to one bounded page', async () => {
  assert.throws(
    () =>
      new ApprovedActionRecoveryReconciler(
        fakeRepository(),
        [provider(), provider()],
        options(),
      ),
    /Duplicate approved action recovery provider/,
  );
  const repository = fakeRepository();
  const reconciler = new ApprovedActionRecoveryReconciler(
    repository,
    [provider()],
    options(),
  );
  await reconciler.reconcileBatch({ limit: 1 });
  assert.equal(
    repository.calls.filter((entry) => entry[0] === 'list').length,
    1,
  );
});
