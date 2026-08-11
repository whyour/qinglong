const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  createLocalExecutionContextRecipe,
  createLocalTaskExecutionRevision,
} = require('@qinglong/runtime-core/local-dispatch');
const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('@qinglong/local-sqlite');
const { LocalExecutionCoordinator } = require('../dist/execution');
const { createLocalProcessDurableHandle } = require('@qinglong/local-process');
const {
  LocalArtifactCapacityUnavailableError,
  LocalDispatchPlanMaterializer,
  LocalFileArtifactAllocator,
  LocalRunDispatcher,
  localArtifactCapacityPolicyForProfile,
} = require('../dist/dispatch');

const RUN_ID = '019f7120-0000-7000-8000-000000000001';
const ATTEMPT_ID = '019f7120-0000-7000-8000-000000000002';

function eventIdFactory() {
  let value = 0;
  return () => `dispatch-event-${++value}`;
}

function processHandle() {
  const identity = {
    platform: 'linux',
    bootId: '11111111-2222-3333-4444-555555555555',
    pid: 4321,
    processGroupId: 4321,
    startTimeTicks: '123456',
  };
  return Object.freeze({
    handleId: 'dispatch-handle',
    pid: 4321,
    durableHandle: createLocalProcessDurableHandle('dispatch-handle', identity),
    startedAtMs: 10,
    completion: Promise.resolve({ exitCode: 0, signal: null }),
  });
}

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-dispatch-'));
  const databasePath = path.join(directory, 'qinglong3.sqlite');
  const artifactRoot = path.join(directory, 'artifacts');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(async () => {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const recipe = createLocalExecutionContextRecipe({
    environment: [
      { name: 'PUBLIC_VALUE', kind: 'public', value: 'public-value' },
      { name: 'SECRET_VALUE', kind: 'secret', secretRef: 'secret-ref-1' },
    ],
    createdAtMs: 1,
  });
  assert.equal(
    await runtime.localDispatch.appendLocalExecutionContextRecipe(recipe),
    'inserted',
  );
  assert.equal(
    await runtime.localDispatch.appendLocalExecutionContextRecipe(recipe),
    'existing',
  );
  const revision = createLocalTaskExecutionRevision({
    projectId: 'default',
    taskId: 'task-1',
    taskRevision: 'revision-1',
    executorType: 'local_process',
    command: { kind: 'argv', file: '/bin/echo', args: ['hello'] },
    timeoutMs: 1_000,
    contextRef: recipe.contextRef,
    createdAtMs: 1,
  });
  assert.equal(
    await runtime.localDispatch.appendLocalTaskExecutionRevision(revision),
    'inserted',
  );
  assert.equal(
    await runtime.localDispatch.appendLocalTaskExecutionRevision(revision),
    'existing',
  );
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
      priority: 10,
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
  return { directory, databasePath, artifactRoot, runtime };
}

test('materializes pinned context and atomically admits one real SQLite candidate', async (t) => {
  const value = await fixture(t);
  let launchRequest;
  const completionNotifications = [];
  const execution = new LocalExecutionCoordinator(
    value.runtime.runRepository,
    {
      async start(request) {
        launchRequest = request;
        assert.equal(request.environment.PUBLIC_VALUE, 'public-value');
        assert.equal(request.environment.SECRET_VALUE, 'top-secret');
        assert.equal(request.output.maximumBytes, 4 * 1024 * 1024);
        assert.match(request.output.logArtifactId, /^local-[0-9a-f]{30}$/);
        return processHandle();
      },
    },
    { stop: async () => assert.fail('valid launch must not be stopped') },
    {
      clock: { now: () => 10 },
      createEventId: eventIdFactory(),
      createCallbackToken: () => 'A'.repeat(32),
    },
  );
  const dispatcher = new LocalRunDispatcher(
    value.runtime.localDispatch,
    new LocalDispatchPlanMaterializer(
      value.runtime.localDispatch,
      new LocalFileArtifactAllocator(
        value.artifactRoot,
        localArtifactCapacityPolicyForProfile('edge'),
      ),
      {
        async resolveLocalSecretEnvironment(request) {
          assert.deepEqual(request.secretRefs, ['secret-ref-1']);
          assert.equal(request.candidate.projectId, 'default');
          return ['top-secret'];
        },
      },
    ),
    execution,
    {
      pageSize: 4,
      maxPages: 1,
      onCompletion: (attemptId) => completionNotifications.push(attemptId),
    },
  );

  const result = await dispatcher.dispatchOnce();
  assert.equal(result.status, 'activated');
  assert.equal(result.runId, RUN_ID);
  assert.equal(result.attemptId, ATTEMPT_ID);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completionNotifications, [ATTEMPT_ID]);
  assert.equal(result.stats.candidatesScanned, 1);
  assert.equal(
    (await value.runtime.runRepository.findRunById(RUN_ID)).status,
    'running',
  );
  const attempt = await value.runtime.runRepository.findAttemptById(ATTEMPT_ID);
  assert.equal(attempt.status, 'running');
  assert.equal(attempt.logArtifactId, launchRequest.output.logArtifactId);
  assert.equal(fs.statSync(launchRequest.output.filePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(launchRequest.output.filePath).size, 0);
  assert.equal(
    fs.readFileSync(value.databasePath).includes(Buffer.from('top-secret')),
    false,
  );
});

test('missing Secret capability returns unavailable before Artifact allocation', async (t) => {
  const value = await fixture(t);
  const dispatcher = new LocalRunDispatcher(
    value.runtime.localDispatch,
    new LocalDispatchPlanMaterializer(
      value.runtime.localDispatch,
      new LocalFileArtifactAllocator(
        value.artifactRoot,
        localArtifactCapacityPolicyForProfile('edge'),
      ),
    ),
    { start: async () => assert.fail('unavailable plan must not activate') },
  );
  const result = await dispatcher.dispatchOnce();
  assert.equal(result.status, 'idle');
  assert.equal(result.reason, 'plans_unavailable');
  assert.equal(result.stats.plansUnavailable, 1);
  assert.equal(fs.existsSync(value.artifactRoot), false);
  assert.equal(
    (await value.runtime.runRepository.findRunById(RUN_ID)).status,
    'queued',
  );
});

test('capacity admission fails before creating an Artifact file', async (t) => {
  const value = await fixture(t);
  const [candidate] = (
    await value.runtime.localDispatch.listLocalDispatchCandidates({ limit: 1 })
  ).candidates;
  const allocator = new LocalFileArtifactAllocator(
    value.artifactRoot,
    localArtifactCapacityPolicyForProfile('edge'),
    { inspect: async () => 0n },
  );
  await assert.rejects(
    allocator.prepare(candidate),
    LocalArtifactCapacityUnavailableError,
  );
  assert.deepEqual(fs.readdirSync(value.artifactRoot), []);
});
