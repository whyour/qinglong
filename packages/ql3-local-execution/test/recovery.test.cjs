const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { InvalidCompletionReceiptError } = require('@qinglong/local-process');
const {
  LocalRunStartupRecoveryCoordinator,
  LocalWorkflowTaskStartupRecoveryCoordinator,
} = require('../dist/recovery');

const RUN_ID = '019f70c0-0000-7000-8000-000000000001';
const ATTEMPT_ID = '019f70c0-0000-7000-8000-000000000002';
const TOKEN = 'A'.repeat(32);

function run(overrides = {}) {
  return {
    id: RUN_ID,
    projectId: 'default',
    taskId: 'task-1',
    taskRevision: 'revision-1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'dispatching',
    version: 0,
    eventSequence: 0,
    priority: 0,
    createdAtMs: 1,
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    id: ATTEMPT_ID,
    runId: RUN_ID,
    attempt: 1,
    status: 'claimed',
    executorType: 'local_process',
    callbackSequence: 0,
    createdAtMs: 2,
    ...overrides,
  };
}

class MemoryRepository {
  constructor(initialRun, initialAttempt) {
    this.runs = new Map(initialRun ? [[initialRun.id, initialRun]] : []);
    this.attempts = new Map(
      initialAttempt ? [[initialAttempt.id, initialAttempt]] : [],
    );
    this.events = [];
  }

  async transaction(work) {
    const previousRuns = structuredClone(this.runs);
    const previousAttempts = structuredClone(this.attempts);
    const previousEvents = structuredClone(this.events);
    const transaction = {
      findRunById: async (id) => structuredClone(this.runs.get(id) ?? null),
      findAttemptById: async (id) =>
        structuredClone(this.attempts.get(id) ?? null),
      findLatestAttemptByRunId: async (runId) => {
        const values = [...this.attempts.values()]
          .filter((item) => item.runId === runId)
          .sort((left, right) => right.attempt - left.attempt);
        return structuredClone(values[0] ?? null);
      },
      compareAndSetRun: async (value, expectedVersion) => {
        const current = this.runs.get(value.id);
        if (!current || current.version !== expectedVersion) return false;
        this.runs.set(value.id, structuredClone(value));
        return true;
      },
      compareAndSetAttempt: async (value, expected) => {
        const current = this.attempts.get(value.id);
        if (
          !current ||
          current.status !== expected.status ||
          current.callbackSequence !== expected.callbackSequence
        ) {
          return false;
        }
        this.attempts.set(value.id, structuredClone(value));
        return true;
      },
      appendEvent: async (value) => this.events.push(structuredClone(value)),
    };
    try {
      return await work(transaction);
    } catch (error) {
      this.runs = previousRuns;
      this.attempts = previousAttempts;
      this.events = previousEvents;
      throw error;
    }
  }
}

function source(repository, overrides = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async inspectCandidates() {
      calls += 1;
      if (overrides.page) return overrides.page;
      const candidates = [];
      for (const value of [...repository.runs.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      )) {
        if (
          value.executionOwner !== 'runtime' ||
          !['dispatching', 'running'].includes(value.status)
        ) {
          continue;
        }
        candidates.push({
          runId: value.id,
          runStatus: value.status,
          activeAttemptCount: [...repository.attempts.values()].filter(
            (item) =>
              item.runId === value.id &&
              ['claimed', 'starting', 'running'].includes(item.status),
          ).length,
        });
      }
      return { candidates, truncated: false };
    },
  };
}

function receipts(value) {
  let readCount = 0;
  let removed = 0;
  return {
    get readCount() {
      return readCount;
    },
    get removed() {
      return removed;
    },
    async read() {
      readCount += 1;
      return value;
    },
    async remove() {
      removed += 1;
      return true;
    },
  };
}

function coordinator(
  repository,
  candidateSource,
  receiptStore,
  inspect,
  options = {},
) {
  return new LocalRunStartupRecoveryCoordinator(
    repository,
    candidateSource,
    receiptStore,
    { executorType: 'local_process', inspect },
    {
      clock: { now: () => 10 },
      createEventId: (() => {
        let value = 0;
        return () => `event-${++value}`;
      })(),
      ...options,
    },
  );
}

test('zero candidates pay one durable read and no receipt or process work', async () => {
  const repository = new MemoryRepository();
  const candidateSource = source(repository);
  const receiptStore = receipts(undefined);
  let inspections = 0;
  const summary = await coordinator(
    repository,
    candidateSource,
    receiptStore,
    async () => {
      inspections += 1;
      return { status: 'running', identityPid: 1 };
    },
  ).recover();

  assert.deepEqual(summary, {
    safe: true,
    scanned: 0,
    recovered: 0,
    remaining: 0,
    failed: 0,
    truncated: false,
  });
  assert.equal(candidateSource.calls, 1);
  assert.equal(receiptStore.readCount, 0);
  assert.equal(inspections, 0);
});

test('truncation fails before any partial mutation or evidence read', async () => {
  const repository = new MemoryRepository(run(), attempt());
  const candidateSource = source(repository, {
    page: {
      candidates: [
        {
          runId: RUN_ID,
          runStatus: 'dispatching',
          activeAttemptCount: 1,
        },
      ],
      truncated: true,
    },
  });
  const receiptStore = receipts(undefined);
  const summary = await coordinator(
    repository,
    candidateSource,
    receiptStore,
    async () => {
      throw new Error('must not inspect');
    },
  ).recover();

  assert.equal(summary.safe, false);
  assert.equal(summary.truncated, true);
  assert.equal(repository.runs.get(RUN_ID).status, 'dispatching');
  assert.equal(repository.attempts.get(ATTEMPT_ID).status, 'claimed');
  assert.equal(repository.events.length, 0);
  assert.equal(receiptStore.readCount, 0);
});

test('an unstarted claimed Attempt is atomically marked lost without probing', async () => {
  const repository = new MemoryRepository(run(), attempt());
  const candidateSource = source(repository);
  const receiptStore = receipts(undefined);
  let inspections = 0;
  const summary = await coordinator(
    repository,
    candidateSource,
    receiptStore,
    async () => {
      inspections += 1;
      return { status: 'running', identityPid: 1 };
    },
  ).recover();

  assert.equal(summary.safe, true);
  assert.equal(summary.recovered, 1);
  assert.equal(repository.runs.get(RUN_ID).status, 'lost');
  assert.equal(repository.attempts.get(ATTEMPT_ID).status, 'lost');
  assert.deepEqual(
    repository.events.map((item) => item.type),
    ['attempt.lost', 'run.lost'],
  );
  assert.equal(inspections, 0);
});

test('a trusted completion receipt wins before process inspection', async () => {
  const callbackTokenHash = createHash('sha256').update(TOKEN).digest('hex');
  const repository = new MemoryRepository(
    run({ status: 'running', startedAtMs: 3 }),
    attempt({
      status: 'running',
      startedAtMs: 3,
      callbackTokenHash,
      executorHandle: 'unused',
      pid: 10,
    }),
  );
  const candidateSource = source(repository);
  const receiptStore = receipts({
    schemaVersion: 1,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    callbackSequence: 1,
    token: TOKEN,
    startedAtMs: 3,
    finishedAtMs: 8,
    exitCode: 0,
  });
  let inspections = 0;
  const resolved = [];
  const summary = await coordinator(
    repository,
    candidateSource,
    receiptStore,
    async () => {
      inspections += 1;
      return { status: 'running', identityPid: 10 };
    },
    {
      journal: {
        async markQuarantined() {
          throw new Error('must not quarantine a trusted receipt');
        },
        async resolve(attemptId) {
          resolved.push(attemptId);
        },
      },
    },
  ).recover();

  assert.equal(summary.safe, true);
  assert.equal(repository.runs.get(RUN_ID).status, 'succeeded');
  assert.equal(repository.attempts.get(ATTEMPT_ID).status, 'succeeded');
  assert.equal(repository.attempts.get(ATTEMPT_ID).callbackSequence, 1);
  assert.deepEqual(
    repository.events.map((item) => item.type),
    ['attempt.succeeded', 'run.succeeded'],
  );
  assert.equal(receiptStore.removed, 1);
  assert.deepEqual(resolved, [ATTEMPT_ID]);
  assert.equal(inspections, 0);
});

test('an invalid receipt records durable quarantine intent before moving the file', async () => {
  const repository = new MemoryRepository(
    run({ status: 'running', startedAtMs: 3 }),
    attempt({
      status: 'running',
      startedAtMs: 3,
      executorHandle: 'handle-1',
      pid: 10,
    }),
  );
  const operations = [];
  const receiptStore = {
    async read() {
      throw new InvalidCompletionReceiptError('invalid test receipt');
    },
    async remove() {
      throw new Error('must not remove an invalid receipt');
    },
    async publish() {
      throw new Error('must not publish during recovery');
    },
    quarantineReference(attemptId) {
      return `.quarantine/${attemptId}.json`;
    },
    async quarantine(attemptId) {
      operations.push(`file:${attemptId}`);
      return `.quarantine/${attemptId}.json`;
    },
  };

  const summary = await coordinator(
    repository,
    source(repository),
    receiptStore,
    async () => {
      throw new Error('invalid receipt must block process inspection');
    },
    {
      quarantineRetentionMs: 100,
      journal: {
        async markQuarantined(record) {
          operations.push(`journal:${record.attemptId}`);
          assert.deepEqual(record, {
            attemptId: ATTEMPT_ID,
            quarantineRef: `.quarantine/${ATTEMPT_ID}.json`,
            updatedAtMs: 10,
            purgeAfterMs: 110,
          });
        },
        async resolve() {
          throw new Error('must not resolve invalid receipt intent');
        },
      },
    },
  ).recover();

  assert.equal(summary.safe, false);
  assert.equal(summary.remaining, 1);
  assert.deepEqual(operations, [`journal:${ATTEMPT_ID}`, `file:${ATTEMPT_ID}`]);
});

test('a live exact process is verified twice without terminalizing the Run', async () => {
  const repository = new MemoryRepository(
    run({ status: 'running', startedAtMs: 3 }),
    attempt({
      status: 'running',
      startedAtMs: 3,
      executorHandle: 'handle-1',
      pid: 10,
    }),
  );
  const candidateSource = source(repository);
  const receiptStore = receipts(undefined);
  let inspections = 0;
  const summary = await coordinator(
    repository,
    candidateSource,
    receiptStore,
    async () => {
      inspections += 1;
      return { status: 'running', identityPid: 10 };
    },
  ).recover();

  assert.equal(summary.safe, true);
  assert.equal(summary.recovered, 1);
  assert.equal(repository.runs.get(RUN_ID).status, 'running');
  assert.equal(repository.attempts.get(ATTEMPT_ID).status, 'running');
  assert.equal(repository.events.length, 0);
  assert.equal(inspections, 2);
  assert.equal(receiptStore.readCount, 2);
});

test('a process change during final verification revokes startup safety', async () => {
  const repository = new MemoryRepository(
    run({ status: 'running', startedAtMs: 3 }),
    attempt({
      status: 'running',
      startedAtMs: 3,
      executorHandle: 'handle-1',
      pid: 10,
    }),
  );
  let inspections = 0;
  const summary = await coordinator(
    repository,
    source(repository),
    receipts(undefined),
    async () => {
      inspections += 1;
      return inspections === 1
        ? { status: 'running', identityPid: 10 }
        : { status: 'not_running', identityPid: 10 };
    },
  ).recover();

  assert.deepEqual(summary, {
    safe: false,
    scanned: 1,
    recovered: 0,
    remaining: 1,
    failed: 0,
    truncated: false,
  });
  assert.equal(repository.runs.get(RUN_ID).status, 'running');
});

test('trusted not-running evidence marks the aggregate lost but unknown evidence blocks', async () => {
  const activeRun = run({ status: 'running', startedAtMs: 3 });
  const activeAttempt = attempt({
    status: 'running',
    startedAtMs: 3,
    executorHandle: 'handle-1',
    pid: 10,
  });
  const repository = new MemoryRepository(activeRun, activeAttempt);
  const summary = await coordinator(
    repository,
    source(repository),
    receipts(undefined),
    async () => ({ status: 'not_running', identityPid: 10 }),
  ).recover();
  assert.equal(summary.safe, true);
  assert.equal(repository.runs.get(RUN_ID).status, 'lost');

  const unknownRepository = new MemoryRepository(activeRun, activeAttempt);
  const unknown = await coordinator(
    unknownRepository,
    source(unknownRepository),
    receipts(undefined),
    async () => ({ status: 'unknown', reason: 'invalid_handle' }),
  ).recover();
  assert.equal(unknown.safe, false);
  assert.equal(unknown.remaining, 1);
  assert.equal(unknownRepository.runs.get(RUN_ID).status, 'running');
  assert.equal(unknownRepository.events.length, 0);
});

test('recovers an orphaned claimed Workflow Task without terminalizing its parent', async () => {
  const workflowRun = run({
    taskId: 'workflow',
    triggerType: 'plugin_package_workflow',
    executionOrigin: 'system',
    status: 'running',
    version: 4,
    eventSequence: 4,
    startedAtMs: 2,
  });
  const workflowAttempt = attempt({
    stepRunId: 'workflow-step',
    status: 'claimed',
    createdAtMs: 5,
  });
  const repository = new MemoryRepository(workflowRun, workflowAttempt);
  let recovered = false;
  let inspections = 0;
  const recovery = {
    async listRecoveryCandidates() {
      return {
        candidates: recovered
          ? []
          : [
              {
                runId: RUN_ID,
                attemptId: ATTEMPT_ID,
                attemptCreatedAtMs: 5,
              },
            ],
        truncated: false,
      };
    },
    async recover(command) {
      assert.equal(command.reason, 'unstarted_claim_expired');
      repository.attempts.set(ATTEMPT_ID, {
        ...workflowAttempt,
        status: 'lost',
        finishedAtMs: command.observedAtMs,
      });
      recovered = true;
      return 'requeued';
    },
  };
  const coordinator = new LocalWorkflowTaskStartupRecoveryCoordinator(
    repository,
    recovery,
    {
      async recordRunning() {
        throw new Error('claimed recovery must not mark running');
      },
    },
    { process: async () => 'missing' },
    {
      executorType: 'local_process',
      async inspect() {
        inspections += 1;
        throw new Error('claimed recovery must not inspect a process');
      },
    },
    { clock: { now: () => 10 } },
  );

  assert.deepEqual(await coordinator.recover(), {
    safe: true,
    scanned: 1,
    recovered: 1,
    verified: 0,
    remaining: 0,
    failed: 0,
    truncated: false,
  });
  assert.equal(repository.runs.get(RUN_ID).status, 'running');
  assert.equal(repository.attempts.get(ATTEMPT_ID).status, 'lost');
  assert.equal(inspections, 0);
});
