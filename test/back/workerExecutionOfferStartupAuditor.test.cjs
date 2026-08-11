require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  WorkerExecutionOfferFileJournal,
} = require('../../back/runtime/adapters/fs/workerExecutionOfferFileJournal');
const {
  InvalidWorkerExecutionOfferStartupPageError,
  WorkerExecutionOfferStartupAuditor,
} = require('../../back/runtime/application/workerExecutionOfferStartupAuditor');
const {
  createWorkerExecutionOfferJournalRecord,
} = require('../../back/runtime/domain/workerExecutionOffer');
const {
  createExecutionSpecDigest,
  createRunDispatchOfferId,
} = require('../../back/runtime/domain/runDispatchOffer');

const START = 1_760_500_000_000;
const SESSION_A = '019f7f00-0000-7000-8000-000000000001';
const SESSION_B = '019f7f00-0000-7000-8000-000000000002';

function offer(sequence, overrides = {}) {
  const attemptId = `attempt-${sequence}`;
  const runId = `run-${sequence}`;
  const lease = {
    attemptId,
    runId,
    status: 'leased',
    version: 0,
    leaseGeneration: 1,
    workerId: 'worker-edge',
    workerSessionId: SESSION_A,
    workerGeneration: 1,
    leaseToken: `lease_token_${String(sequence).padStart(
      3,
      '0',
    )}_abcdefghijklmnopqrstuvwxyz`,
    acquiredAtMs: START,
    renewedAtMs: START,
    expiresAtMs: START + 60_000,
    updatedAtMs: START,
    ...overrides.lease,
  };
  const executionSpec = {
    runId,
    attemptId,
    projectId: 'default',
    taskId: `task-${sequence}`,
    taskRevision: 'revision-1',
    command: { kind: 'argv', file: '/bin/true', args: [] },
    environmentPolicy: 'isolated',
    terminationGraceMs: 1_000,
  };
  return {
    offerId: createRunDispatchOfferId(lease),
    executionSpecDigest: createExecutionSpecDigest(executionSpec),
    deliveryKind: 'lease_recovery',
    candidate: {
      runId,
      attemptId,
      projectId: 'default',
      taskId: `task-${sequence}`,
      taskRevision: 'revision-1',
      executorType: 'remote_worker',
      priority: 0,
      queuedAtMs: START,
      attemptCreatedAtMs: START,
    },
    worker: {
      id: lease.workerId,
      sessionId: lease.workerSessionId,
      generation: lease.workerGeneration,
    },
    lease,
    executionSpec,
  };
}

function session(overrides = {}) {
  return {
    id: 'worker-edge',
    sessionId: SESSION_A,
    generation: 1,
    status: 'online',
    version: 0,
    capabilities: {
      architecture: 'arm64',
      operatingSystem: 'linux',
      executors: ['remote_worker'],
      runtimes: [{ name: 'node', version: '24.14.0' }],
      labels: {},
      capacity: {},
      features: [],
    },
    capabilitiesHash: 'a'.repeat(64),
    maxConcurrentRuns: 8,
    availableSlots: 8,
    registeredAtMs: START,
    lastHeartbeatAtMs: START,
    leaseExpiresAtMs: START + 120_000,
    updatedAtMs: START,
    ...overrides,
  };
}

function record(sequence, state, overrides = {}) {
  const initial = createWorkerExecutionOfferJournalRecord(
    offer(sequence, overrides),
    START,
  );
  if (state === 'accepted') return initial;
  const hasExecution = state === 'started' || state === 'running_acknowledged';
  return {
    ...initial,
    revision: 1,
    state,
    updatedAtMs: START + 1,
    ...(hasExecution
      ? {
          executorHandle: `durable-handle-${sequence}`,
          executorStartedAtMs: START + 1,
        }
      : {}),
    ...(state === 'recovery_required'
      ? { recoveryReason: 'launch_outcome_unknown' }
      : {}),
    ...(state === 'completion_acknowledged'
      ? {
          completionReceiptCallbackSequence: 1,
          completionReceiptTokenDigest: 'a'.repeat(64),
          completionAcknowledgedAtMs: START + 1,
        }
      : {}),
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-offer-audit-'));
  const journal = new WorkerExecutionOfferFileJournal(root, {
    maximumEntries: 16,
  });
  await journal.acquireOwnership();
  t.after(async () => {
    await journal.releaseOwnership();
    await fs.rm(root, { recursive: true, force: true });
  });
  return journal;
}

async function publish(journal, value) {
  const initial = createWorkerExecutionOfferJournalRecord(
    value.offer,
    value.acceptedAtMs,
  );
  await journal.create(initial);
  if (value.revision > 0) await journal.replace(value, 0);
}

test('classifies every restart state without exposing capabilities or commands', async (t) => {
  const journal = await fixture(t);
  const records = [
    record(1, 'accepted'),
    record(2, 'starting_acknowledged', {
      lease: { workerSessionId: SESSION_B, workerGeneration: 2 },
    }),
    record(3, 'start_failed', { lease: { expiresAtMs: START + 1 } }),
    record(4, 'launching', {
      lease: { workerSessionId: SESSION_B, workerGeneration: 2 },
    }),
    record(5, 'started', {
      lease: { workerSessionId: SESSION_B, workerGeneration: 2 },
    }),
    record(6, 'running_acknowledged', {
      lease: { expiresAtMs: START + 1 },
    }),
    record(7, 'start_failure_acknowledged'),
    record(8, 'completion_acknowledged'),
  ];
  for (const value of records) await publish(journal, value);

  const result = await new WorkerExecutionOfferStartupAuditor(journal, {
    pageSize: 2,
    maxPages: 4,
    clock: { now: () => START + 10 },
  }).audit(session());
  assert.equal(result.status, 'reconciliation_required');
  assert.equal(result.pagesScanned, 4);
  assert.equal(result.recordsScanned, 8);
  assert.deepEqual(result.counts, {
    settled_start_failure: 1,
    settled_completion: 1,
    redelivery_required: 1,
    fenced_without_local_execution: 1,
    expired_without_local_execution: 1,
    launch_reconciliation_required: 1,
    execution_reconciliation_required: 2,
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /lease_token/);
  assert.doesNotMatch(serialized, /\/bin\/true/);
});

test('returns ready when no journal entry can own a local execution', async (t) => {
  const journal = await fixture(t);
  await publish(journal, record(1, 'accepted'));
  await publish(
    journal,
    record(2, 'starting_acknowledged', {
      lease: { workerSessionId: SESSION_B, workerGeneration: 2 },
    }),
  );
  await publish(journal, record(3, 'start_failure_acknowledged'));
  const result = await new WorkerExecutionOfferStartupAuditor(journal, {
    clock: { now: () => START + 10 },
  }).audit(session());
  assert.equal(result.status, 'ready');
  assert.equal(result.recordsScanned, 3);
});

test('exposes a stable cursor and fails closed when the audit budget is exhausted', async (t) => {
  const journal = await fixture(t);
  await publish(journal, record(1, 'accepted'));
  await publish(journal, record(2, 'accepted'));
  const result = await new WorkerExecutionOfferStartupAuditor(journal, {
    pageSize: 1,
    maxPages: 1,
    clock: { now: () => START + 10 },
  }).audit(session());
  assert.equal(result.status, 'scan_budget_exhausted');
  assert.equal(result.recordsScanned, 1);
  assert.equal(typeof result.nextAfterOfferId, 'string');
});

test('rejects duplicate, unordered and malformed resume pages', async () => {
  const first = record(1, 'accepted');
  const second = record(2, 'accepted');
  const sorted = [first, second].sort((left, right) =>
    left.offer.offerId.localeCompare(right.offer.offerId),
  );
  await assert.rejects(
    new WorkerExecutionOfferStartupAuditor(
      {
        async list() {
          return { records: [sorted[1], sorted[0]] };
        },
      },
      { pageSize: 2, clock: { now: () => START } },
    ).audit(session()),
    InvalidWorkerExecutionOfferStartupPageError,
  );
  await assert.rejects(
    new WorkerExecutionOfferStartupAuditor(
      {
        async list() {
          return {
            records: [sorted[0]],
            nextAfterOfferId: sorted[1].offer.offerId,
          };
        },
      },
      { pageSize: 1, clock: { now: () => START } },
    ).audit(session()),
    InvalidWorkerExecutionOfferStartupPageError,
  );
  assert.throws(
    () =>
      new WorkerExecutionOfferStartupAuditor(
        {
          async list() {
            return { records: [] };
          },
        },
        { pageSize: 64, maxPages: 17 },
      ),
    /maxPages must be between/,
  );
});
