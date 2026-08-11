const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('@qinglong/local-sqlite');
const {
  LocalCompletionReceiptProcessor,
  LocalExecutionControlCoordinator,
  LocalExecutionControlLifecycle,
  LocalExecutionControlScanner,
} = require('../dist/control');

const IDS = Object.freeze({
  completionRun: '019f7130-0000-7000-8000-000000000001',
  completionAttempt: '019f7130-0000-7000-8000-000000000002',
  deadlineRun: '019f7130-0000-7000-8000-000000000003',
  deadlineAttempt: '019f7130-0000-7000-8000-000000000004',
  cancelRun: '019f7130-0000-7000-8000-000000000005',
  cancelAttempt: '019f7130-0000-7000-8000-000000000006',
  shutdownRun: '019f7130-0000-7000-8000-000000000007',
  shutdownAttempt: '019f7130-0000-7000-8000-000000000008',
});
const TOKEN = 'A'.repeat(32);

function eventIds() {
  let value = 0;
  return () => `control-event-${++value}`;
}

function receiptStore() {
  const receipts = new Map();
  return {
    receipts,
    removed: [],
    async publish(receipt) {
      receipts.set(receipt.attemptId, receipt);
    },
    async read(attemptId) {
      return receipts.get(attemptId);
    },
    async remove(attemptId) {
      this.removed.push(attemptId);
      return receipts.delete(attemptId);
    },
  };
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-control-'));
  const databasePath = path.join(directory, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(async () => {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return runtime;
}

async function insertActive(runtime, options) {
  await runtime.runRepository.transaction(async (transaction) => {
    await transaction.insertRun({
      id: options.runId,
      projectId: 'default',
      taskId: 'task-1',
      taskRevision: 'revision-1',
      triggerType: 'manual',
      executionOrigin: 'manual',
      executionOwner: 'runtime',
      status: options.runStatus || 'running',
      version: 0,
      eventSequence: 0,
      priority: 0,
      createdAtMs: 1,
      startedAtMs: 2,
      ...(options.cancelRequestedAtMs === undefined
        ? {}
        : {
            cancelRequestedAtMs: options.cancelRequestedAtMs,
            cancelReason: options.cancelReason,
          }),
    });
    await transaction.insertAttempt({
      id: options.attemptId,
      runId: options.runId,
      attempt: 1,
      status: options.attemptStatus || 'running',
      executorType: 'local_process',
      executorHandle: `handle:${options.attemptId}`,
      pid: 1234,
      callbackTokenHash: createHash('sha256').update(TOKEN).digest('hex'),
      callbackSequence: options.callbackSequence || 0,
      createdAtMs: 1,
      startedAtMs: 2,
      ...(options.deadlineAtMs === undefined
        ? {}
        : { deadlineAtMs: options.deadlineAtMs }),
    });
  });
}

test('authenticates one receipt and commits Attempt then Run terminal facts', async (t) => {
  const runtime = await fixture(t);
  const store = receiptStore();
  await insertActive(runtime, {
    runId: IDS.completionRun,
    attemptId: IDS.completionAttempt,
  });
  store.receipts.set(IDS.completionAttempt, {
    schemaVersion: 1,
    runId: IDS.completionRun,
    attemptId: IDS.completionAttempt,
    callbackSequence: 1,
    token: TOKEN,
    startedAtMs: 2,
    finishedAtMs: 10,
    exitCode: 0,
  });
  const processor = new LocalCompletionReceiptProcessor(
    runtime.runRepository,
    store,
    { clock: { now: () => 10 }, createEventId: eventIds() },
  );
  assert.equal(await processor.process(IDS.completionAttempt), 'completed');
  assert.equal(
    (await runtime.runRepository.findRunById(IDS.completionRun)).status,
    'succeeded',
  );
  assert.equal(
    (await runtime.runRepository.findAttemptById(IDS.completionAttempt)).status,
    'succeeded',
  );
  assert.deepEqual(
    (await runtime.runRepository.listEvents(IDS.completionRun)).map(
      (event) => event.type,
    ),
    ['attempt.succeeded', 'run.succeeded'],
  );
  assert.deepEqual(store.removed, [IDS.completionAttempt]);
});

test('discovers due deadlines and cancellation intents through stable SQLite pages', async (t) => {
  const runtime = await fixture(t);
  await insertActive(runtime, {
    runId: IDS.deadlineRun,
    attemptId: IDS.deadlineAttempt,
    deadlineAtMs: 50,
  });
  await insertActive(runtime, {
    runId: IDS.cancelRun,
    attemptId: IDS.cancelAttempt,
    cancelRequestedAtMs: 40,
    cancelReason: 'user',
    deadlineAtMs: 30,
  });
  const first =
    await runtime.executionControl.listLocalExecutionControlCandidates({
      observedAtMs: 100,
      limit: 1,
    });
  assert.equal(first.truncated, true);
  assert.deepEqual(first.candidates[0], {
    kind: 'cancellation',
    runId: IDS.cancelRun,
    attemptId: IDS.cancelAttempt,
    dueAtMs: 40,
    cancelReason: 'user',
  });
  const second =
    await runtime.executionControl.listLocalExecutionControlCandidates({
      observedAtMs: 100,
      limit: 1,
      after: first.nextCursor,
    });
  assert.equal(second.truncated, false);
  assert.deepEqual(second.candidates[0], {
    kind: 'deadline',
    runId: IDS.deadlineRun,
    attemptId: IDS.deadlineAttempt,
    dueAtMs: 50,
  });
});

test('turns deadline and user cancellation into exact terminal aggregates', async (t) => {
  const runtime = await fixture(t);
  await insertActive(runtime, {
    runId: IDS.deadlineRun,
    attemptId: IDS.deadlineAttempt,
    deadlineAtMs: 50,
  });
  await insertActive(runtime, {
    runId: IDS.cancelRun,
    attemptId: IDS.cancelAttempt,
    cancelRequestedAtMs: 40,
    cancelReason: 'user',
  });
  const stopped = [];
  const store = receiptStore();
  const completion = new LocalCompletionReceiptProcessor(
    runtime.runRepository,
    store,
    { clock: { now: () => 100 }, createEventId: eventIds() },
  );
  const coordinator = new LocalExecutionControlCoordinator(
    runtime.runRepository,
    completion,
    {
      async stop(handle) {
        stopped.push(handle);
        return { status: 'stopped', signal: 'SIGTERM' };
      },
    },
    { clock: { now: () => 100 }, createEventId: eventIds() },
  );
  const scanner = new LocalExecutionControlScanner(
    runtime.executionControl,
    coordinator,
    { now: () => 100 },
  );
  const summary = await scanner.scan({ limit: 8 });
  assert.equal(summary.scanned, 2);
  assert.equal(summary.terminal, 2);
  assert.equal(
    (await runtime.runRepository.findRunById(IDS.deadlineRun)).status,
    'timed_out',
  );
  assert.equal(
    (await runtime.runRepository.findRunById(IDS.cancelRun)).status,
    'cancelled',
  );
  assert.equal(stopped.length, 2);
});

test('routes a Workflow Task deadline to Step scope without cancelling its parent', async () => {
  const run = {
    id: 'workflow-run',
    projectId: 'default',
    taskId: 'workflow',
    taskRevision: 'revision-1',
    triggerType: 'system',
    executionOrigin: 'system',
    executionOwner: 'runtime',
    status: 'running',
    version: 7,
    eventSequence: 7,
    priority: 0,
    createdAtMs: 1,
    startedAtMs: 2,
  };
  const attempt = {
    id: 'workflow-attempt',
    runId: run.id,
    stepRunId: 'workflow-step',
    attempt: 1,
    status: 'running',
    executorType: 'local_process',
    executorHandle: 'workflow-handle',
    pid: 321,
    callbackTokenHash: 'a'.repeat(64),
    callbackSequence: 0,
    deadlineAtMs: 50,
    createdAtMs: 1,
    startedAtMs: 2,
  };
  let latestReads = 0;
  const repository = {
    transaction(work) {
      return work({
        findRunById: async (runId) => (runId === run.id ? run : null),
        findAttemptById: async (attemptId) =>
          attemptId === attempt.id ? attempt : null,
        findLatestAttemptByRunId: async () => {
          latestReads += 1;
          return attempt;
        },
      });
    },
  };
  const workflowCalls = [];
  const coordinator = new LocalExecutionControlCoordinator(
    repository,
    { process: async () => 'missing' },
    { stop: async () => ({ status: 'stopped', signal: 'SIGTERM' }) },
    {
      clock: { now: () => 100 },
      createEventId: eventIds(),
      workflowTasks: {
        async requestTimeout(command) {
          workflowCalls.push(['timeout', command]);
          return 'requested';
        },
        async recordControlTerminal(command) {
          workflowCalls.push(['terminal', command]);
          return 'terminal';
        },
      },
    },
  );

  assert.equal(
    await coordinator.process({
      kind: 'deadline',
      runId: run.id,
      attemptId: attempt.id,
      dueAtMs: 50,
    }),
    'terminal',
  );
  assert.equal(latestReads, 0);
  assert.equal(workflowCalls[0][0], 'timeout');
  assert.equal(workflowCalls[1][0], 'terminal');
  assert.equal(workflowCalls[1][1].terminalStatus, 'timed_out');
  assert.equal(run.cancelRequestedAtMs, undefined);
});

test('shutdown drain requests shutdown cancellation before stopping work', async (t) => {
  const runtime = await fixture(t);
  await insertActive(runtime, {
    runId: IDS.shutdownRun,
    attemptId: IDS.shutdownAttempt,
  });
  const completion = new LocalCompletionReceiptProcessor(
    runtime.runRepository,
    receiptStore(),
    { clock: { now: () => 100 }, createEventId: eventIds() },
  );
  const coordinator = new LocalExecutionControlCoordinator(
    runtime.runRepository,
    completion,
    { stop: async () => ({ status: 'already_exited' }) },
    { clock: { now: () => 100 }, createEventId: eventIds() },
  );
  const scanner = new LocalExecutionControlScanner(
    runtime.executionControl,
    coordinator,
    { now: () => 100 },
  );
  const summary = await scanner.drain({ limit: 4, maxPages: 2 });
  assert.deepEqual(summary, {
    scanned: 1,
    terminal: 1,
    remaining: 0,
    failed: 0,
    truncated: false,
  });
  const run = await runtime.runRepository.findRunById(IDS.shutdownRun);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.cancelReason, 'shutdown');
  assert.deepEqual(
    (await runtime.runRepository.listEvents(IDS.shutdownRun)).map(
      (event) => event.type,
    ),
    ['run.cancel_requested', 'attempt.cancelled', 'run.cancelled'],
  );
});

test('coalesces completion notifications and owns one idempotent shutdown drain', async () => {
  const completions = [];
  let scans = 0;
  let drains = 0;
  let cleanups = 0;
  let retentionSweeps = 0;
  const lifecycle = new LocalExecutionControlLifecycle(
    {
      async process(attemptId) {
        completions.push(attemptId);
        return 'missing';
      },
    },
    {
      async scan() {
        scans += 1;
        return {
          scanned: 0,
          terminal: 0,
          cancelRequested: 0,
          stale: 0,
          remaining: 0,
          failed: 0,
          truncated: false,
        };
      },
      async drain() {
        drains += 1;
        return {
          scanned: 0,
          terminal: 0,
          remaining: 0,
          failed: 0,
          truncated: false,
        };
      },
    },
    {
      async scan() {
        cleanups += 1;
        return {
          scanned: 0,
          removed: 0,
          expiredMissing: 0,
          purgedQuarantines: 0,
          remaining: 0,
          failed: 0,
          truncated: false,
        };
      },
    },
    {
      intervalMs: 60_000,
      pageSize: 4,
      cleanupIntervalMs: 60_000,
      cleanupPageSize: 4,
      stopTimeoutMs: 1_000,
      maxDrainPages: 1,
      clock: { now: () => 100 },
      artifactRetention: {
        async sweep() {
          retentionSweeps += 1;
          return {
            status: 'complete',
            pressure: false,
            observedAtMs: 100,
            retentionMs: 60_000,
            availableBytes: '100',
            totalBytes: '100',
            candidatesScanned: 0,
            deletionsAttempted: 0,
            recordsWritten: 0,
            failedCandidates: 0,
            bytesReclaimed: 0,
            entries: [],
          };
        },
      },
    },
  );
  assert.equal(lifecycle.notifyCompletion(IDS.completionAttempt), true);
  assert.equal(lifecycle.notifyCompletion(IDS.completionAttempt), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completions, [IDS.completionAttempt]);
  assert.equal(scans, 1);
  assert.equal(cleanups, 1);
  assert.equal(retentionSweeps, 1);
  const first = lifecycle.stopAndDrain();
  const second = lifecycle.stopAndDrain();
  assert.equal(first, second);
  assert.equal((await first).status, 'stopped');
  assert.equal(drains, 1);
  assert.equal(cleanups, 2);
  assert.equal(retentionSweeps, 1);
});
