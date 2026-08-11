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
  LocalExecutionCoordinator,
  LocalExecutionLaunchError,
  LocalExecutionOwnershipPersistenceError,
  LocalExecutionRejectedError,
} = require('../dist/execution');
const { createLocalProcessDurableHandle } = require('@qinglong/local-process');

const RUN_ID = '019f70d0-0000-7000-8000-000000000001';
const ATTEMPT_ID = '019f70d0-0000-7000-8000-000000000002';
const CALLBACK_TOKEN = 'A'.repeat(32);

async function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-execution-'),
  );
  const options = {
    databasePath: path.join(directory, 'qinglong3.sqlite'),
    profile: 'edge',
  };
  await migrateLocalSqlitePath(options);
  const runtime = await openLocalSqliteRuntimeDatabase(options);
  t.after(async () => {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await runtime.runRepository.transaction(async (transaction) => {
    await transaction.insertRun({
      id: RUN_ID,
      projectId: 'default',
      taskId: 'task-1',
      taskRevision: 'revision-1',
      triggerType: 'manual',
      executionOrigin: 'manual',
      executionOwner: 'runtime',
      status: 'queued',
      version: 0,
      eventSequence: 0,
      priority: 0,
      createdAtMs: 1,
      queuedAtMs: 1,
    });
    await transaction.insertAttempt({
      id: ATTEMPT_ID,
      runId: RUN_ID,
      attempt: 1,
      status: 'claimed',
      executorType: 'local_process',
      callbackSequence: 0,
      createdAtMs: 1,
    });
  });
  return runtime.runRepository;
}

function eventIdFactory() {
  let value = 0;
  return () => `event-${++value}`;
}

function handle() {
  const identity = {
    platform: 'linux',
    bootId: '11111111-2222-3333-4444-555555555555',
    pid: 1234,
    processGroupId: 1234,
    startTimeTicks: '987654',
  };
  return Object.freeze({
    handleId: 'handle-1',
    pid: 1234,
    durableHandle: createLocalProcessDurableHandle('handle-1', identity),
    startedAtMs: 10,
    completion: Promise.resolve({ exitCode: 0, signal: null }),
  });
}

function command() {
  return {
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    command: { kind: 'argv', file: '/bin/echo', args: ['hello'] },
    timeoutMs: 1_000,
  };
}

function repositoryFailingTransaction(repository, transactionNumber) {
  let transactions = 0;
  return {
    findRunById: (...args) => repository.findRunById(...args),
    findAttemptById: (...args) => repository.findAttemptById(...args),
    findLatestAttemptByRunId: (...args) =>
      repository.findLatestAttemptByRunId(...args),
    findRetryPolicyByRunId: (...args) =>
      repository.findRetryPolicyByRunId(...args),
    listEvents: (...args) => repository.listEvents(...args),
    listCancellationRequested: (...args) =>
      repository.listCancellationRequested(...args),
    transaction(work) {
      transactions += 1;
      if (transactions === transactionNumber) {
        return Promise.reject(new Error('injected transaction failure'));
      }
      return repository.transaction(work);
    },
  };
}

test('atomically persists claimed -> starting -> running around launch', async (t) => {
  const repository = await fixture(t);
  let launchRequest;
  let clockReads = 0;
  const coordinator = new LocalExecutionCoordinator(
    repository,
    {
      async start(request) {
        launchRequest = request;
        const [run, attempt] = await Promise.all([
          repository.findRunById(RUN_ID),
          repository.findAttemptById(ATTEMPT_ID),
        ]);
        assert.equal(run.status, 'dispatching');
        assert.equal(run.version, 2);
        assert.equal(attempt.status, 'starting');
        assert.equal(
          attempt.callbackTokenHash,
          createHash('sha256').update(CALLBACK_TOKEN).digest('hex'),
        );
        return handle();
      },
    },
    {
      stop: async () => assert.fail('controller must not stop a valid launch'),
    },
    {
      clock: { now: () => (clockReads++ === 0 ? 5 : 20) },
      createEventId: eventIdFactory(),
      createCallbackToken: () => CALLBACK_TOKEN,
    },
  );

  const result = await coordinator.start(command());
  assert.equal(launchRequest.callbackToken, CALLBACK_TOKEN);
  assert.equal(launchRequest.callbackSequence, 1);
  assert.equal(result.run.status, 'running');
  assert.equal(result.run.version, 4);
  assert.equal(result.attempt.status, 'running');
  assert.equal(result.attempt.executorHandle, handle().durableHandle);
  assert.equal(result.attempt.pid, 1234);
  assert.equal(result.attempt.startedAtMs, handle().startedAtMs);
  assert.equal(result.attempt.callbackSequence, 0);
  assert.equal('callbackToken' in result, false);
  assert.deepEqual(
    (await repository.listEvents(RUN_ID)).map((event) => event.type),
    ['run.dispatching', 'attempt.starting', 'attempt.running', 'run.running'],
  );
});

test('records a pre-ownership launch failure as failed', async (t) => {
  const repository = await fixture(t);
  const coordinator = new LocalExecutionCoordinator(
    repository,
    { start: async () => Promise.reject(new Error('spawn failed')) },
    { stop: async () => assert.fail('no durable handle exists') },
    {
      clock: { now: () => 10 },
      createEventId: eventIdFactory(),
      createCallbackToken: () => CALLBACK_TOKEN,
    },
  );
  await assert.rejects(coordinator.start(command()), LocalExecutionLaunchError);
  assert.equal((await repository.findRunById(RUN_ID)).status, 'failed');
  assert.equal(
    (await repository.findAttemptById(ATTEMPT_ID)).errorCode,
    'EXECUTOR_START_FAILED',
  );
});

test('stops exact process then records lost when running persistence fails', async (t) => {
  const repository = await fixture(t);
  const failing = repositoryFailingTransaction(repository, 2);
  const stopped = [];
  const coordinator = new LocalExecutionCoordinator(
    failing,
    { start: async () => handle() },
    {
      async stop(durableHandle) {
        stopped.push(durableHandle);
        return { status: 'stopped', signal: 'SIGTERM' };
      },
    },
    {
      clock: { now: () => 10 },
      createEventId: eventIdFactory(),
      createCallbackToken: () => CALLBACK_TOKEN,
    },
  );
  await assert.rejects(coordinator.start(command()), (error) => {
    assert.ok(error instanceof LocalExecutionOwnershipPersistenceError);
    assert.equal(error.compensation.status, 'stopped');
    return true;
  });
  assert.deepEqual(stopped, [handle().durableHandle]);
  assert.equal((await repository.findRunById(RUN_ID)).status, 'lost');
  assert.equal((await repository.findAttemptById(ATTEMPT_ID)).status, 'lost');
});

test('keeps starting authority for recovery when exact stop is inconclusive', async (t) => {
  const repository = await fixture(t);
  const failing = repositoryFailingTransaction(repository, 2);
  const coordinator = new LocalExecutionCoordinator(
    failing,
    { start: async () => handle() },
    {
      stop: async () => ({
        status: 'unknown',
        reason: 'provider_unavailable',
      }),
    },
    {
      clock: { now: () => 10 },
      createEventId: eventIdFactory(),
      createCallbackToken: () => CALLBACK_TOKEN,
    },
  );
  await assert.rejects(
    coordinator.start(command()),
    LocalExecutionOwnershipPersistenceError,
  );
  assert.equal((await repository.findRunById(RUN_ID)).status, 'dispatching');
  assert.equal(
    (await repository.findAttemptById(ATTEMPT_ID)).status,
    'starting',
  );
});

test('rejects replay after execution authority has moved', async (t) => {
  const repository = await fixture(t);
  const coordinator = new LocalExecutionCoordinator(
    repository,
    { start: async () => handle() },
    { stop: async () => ({ status: 'already_exited' }) },
    {
      clock: { now: () => 10 },
      createEventId: eventIdFactory(),
      createCallbackToken: () => CALLBACK_TOKEN,
    },
  );
  await coordinator.start(command());
  await assert.rejects(
    coordinator.start(command()),
    LocalExecutionRejectedError,
  );
});
