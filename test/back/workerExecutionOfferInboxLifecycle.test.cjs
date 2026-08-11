require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerExecutionOfferInboxLifecycle,
  WorkerExecutionOfferInboxRecoveryIncompleteError,
  WorkerExecutionOfferInboxStartupIncompleteError,
} = require('../../back/runtime/application/workerExecutionOfferInboxLifecycle');

const START = 1_760_600_000_000;

function session() {
  return {
    id: 'worker-edge',
    sessionId: '019f8000-0000-7000-8000-000000000001',
    generation: 1,
  };
}

function audit(status) {
  return {
    status,
    observedAtMs: START,
    pagesScanned: 1,
    recordsScanned: 0,
    counts: {},
    entries: [],
  };
}

function fixture(status = 'ready', releaseResult = 'released', recovery) {
  const calls = [];
  const ownership = {
    ownershipState() {
      return 'owned';
    },
    async acquireOwnership() {
      calls.push('acquire');
      return 'acquired';
    },
    async releaseOwnership() {
      calls.push('release');
      return releaseResult;
    },
  };
  const auditor = {
    async audit() {
      calls.push('audit');
      return audit(status);
    },
  };
  return {
    calls,
    lifecycle: new WorkerExecutionOfferInboxLifecycle(
      ownership,
      auditor,
      recovery,
    ),
  };
}

test('holds one ownership lease after a complete startup audit', async () => {
  const context = fixture();
  const started = await context.lifecycle.start(session());
  assert.equal(started.status, 'ready');
  assert.strictEqual(context.lifecycle.currentAudit(), started.audit);
  assert.equal(
    (await context.lifecycle.start(session())).status,
    'already_started',
  );
  assert.deepEqual(context.calls, ['acquire', 'audit']);
  assert.equal(await context.lifecycle.stop(), 'stopped');
  assert.deepEqual(context.calls, ['acquire', 'audit', 'release']);
  assert.equal(await context.lifecycle.stop(), 'not_started');
});

test('keeps ownership while execution reconciliation is required', async () => {
  const context = fixture('reconciliation_required');
  assert.equal(
    (await context.lifecycle.start(session())).status,
    'reconciliation_required',
  );
  assert.deepEqual(context.calls, ['acquire', 'audit']);
  assert.equal(await context.lifecycle.stop(), 'stopped');
});

test('releases ownership when the startup scan is incomplete or fails', async () => {
  const exhausted = fixture('scan_budget_exhausted');
  await assert.rejects(
    exhausted.lifecycle.start(session()),
    WorkerExecutionOfferInboxStartupIncompleteError,
  );
  assert.deepEqual(exhausted.calls, ['acquire', 'audit', 'release']);

  const calls = [];
  const failed = new WorkerExecutionOfferInboxLifecycle(
    {
      ownershipState() {
        return 'owned';
      },
      async acquireOwnership() {
        calls.push('acquire');
        return 'acquired';
      },
      async releaseOwnership() {
        calls.push('release');
        return 'released';
      },
    },
    {
      async audit() {
        calls.push('audit');
        throw new Error('corrupt journal page');
      },
    },
  );
  await assert.rejects(failed.start(session()), /corrupt journal page/);
  assert.deepEqual(calls, ['acquire', 'audit', 'release']);
});

test('reports a compromised owner instead of claiming a clean stop', async () => {
  const context = fixture('ready', 'compromised');
  await context.lifecycle.start(session());
  assert.equal(await context.lifecycle.stop(), 'ownership_compromised');
});

test('runs bounded recovery and re-audits before holding ownership', async () => {
  const recoveryCalls = [];
  const context = fixture('reconciliation_required', 'released', {
    async recover(value) {
      recoveryCalls.push(value.status);
      return {
        status: 'recovered',
        actionsPlanned: 1,
        actionsAttempted: 1,
        entries: [],
      };
    },
  });
  const started = await context.lifecycle.start(session());
  assert.equal(started.status, 'reconciliation_required');
  assert.equal(started.recovery.status, 'recovered');
  assert.deepEqual(context.calls, ['acquire', 'audit', 'audit']);
  assert.deepEqual(recoveryCalls, ['reconciliation_required']);
  assert.equal(
    (await context.lifecycle.start(session())).recovery.status,
    'recovered',
  );
  await context.lifecycle.stop();
});

test('releases ownership when the recovery action budget is exhausted', async () => {
  const context = fixture('reconciliation_required', 'released', {
    async recover() {
      return {
        status: 'action_budget_exhausted',
        actionsPlanned: 65,
        actionsAttempted: 0,
        entries: [],
      };
    },
  });
  await assert.rejects(
    context.lifecycle.start(session()),
    WorkerExecutionOfferInboxRecoveryIncompleteError,
  );
  assert.deepEqual(context.calls, ['acquire', 'audit', 'release']);
});
