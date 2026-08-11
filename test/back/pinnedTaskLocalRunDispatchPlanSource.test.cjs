require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PinnedTaskLocalRunDispatchPlanSource,
} = require('../../back/runtime/application/pinnedTaskLocalRunDispatchPlanSource');
const {
  MAX_EXECUTION_ENVIRONMENT_ENTRIES,
  normalizeExecutionContext,
} = require('../../back/runtime/domain/executionContext');

function candidate() {
  return {
    runId: 'run-pinned',
    attemptId: 'attempt-2',
    projectId: 'default',
    taskId: 'task-pinned',
    taskRevision: 'revision-7',
    executorType: 'local_process',
    priority: 0,
    queuedAtMs: 1_760_000_000_000,
    attemptCreatedAtMs: 1_760_000_000_000,
  };
}

function revision(overrides = {}) {
  return {
    projectId: 'default',
    taskId: 'task-pinned',
    taskRevision: 'revision-7',
    executorType: 'local_process',
    execution: {
      command: { kind: 'argv', file: '/bin/true', args: ['original'] },
      environmentPolicy: 'isolated',
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    },
    contextRef: 'context:task-pinned:revision-7',
    ...overrides,
  };
}

test('materializes one pinned revision with fresh bounded context capabilities', async () => {
  const sourceRevision = revision();
  sourceRevision.execution.runId = 'must-not-override-attempt-identity';
  const environment = { TOKEN: 'in-memory-secret' };
  const output = { async write() {} };
  const revisionRequests = [];
  const contextRequests = [];
  const dispose = () => undefined;
  const source = new PinnedTaskLocalRunDispatchPlanSource(
    {
      async resolve(request) {
        revisionRequests.push(request);
        assert.equal(Object.isFrozen(request), true);
        return sourceRevision;
      },
    },
    {
      async prepare(request) {
        contextRequests.push(request);
        assert.equal(Object.isFrozen(request), true);
        assert.equal(Object.isFrozen(request.candidate), true);
        return { context: { environment, output }, dispose };
      },
    },
  );

  const plan = await source.prepare(candidate());
  assert.deepEqual(revisionRequests, [
    {
      projectId: 'default',
      taskId: 'task-pinned',
      taskRevision: 'revision-7',
    },
  ]);
  assert.equal(contextRequests[0].contextRef, sourceRevision.contextRef);
  assert.equal(plan.executionSpec.runId, 'run-pinned');
  assert.equal(plan.executionSpec.attemptId, 'attempt-2');
  assert.equal(plan.executionSpec.timeoutMs, 5_000);
  assert.equal(plan.context.output, output);
  assert.equal(Object.isFrozen(plan.context.environment), true);
  assert.equal(plan.dispose, dispose);

  sourceRevision.execution.command.args[0] = 'mutated';
  environment.TOKEN = 'mutated-secret';
  assert.deepEqual(plan.executionSpec.command.args, ['original']);
  assert.equal(plan.context.environment.TOKEN, 'in-memory-secret');
});

test('never falls back when the exact revision or context is unavailable', async () => {
  let contextCalls = 0;
  const missingRevision = new PinnedTaskLocalRunDispatchPlanSource(
    {
      async resolve() {
        return null;
      },
    },
    {
      async prepare() {
        contextCalls += 1;
        return null;
      },
    },
  );
  assert.equal(await missingRevision.prepare(candidate()), null);
  assert.equal(contextCalls, 0);

  const missingContext = new PinnedTaskLocalRunDispatchPlanSource(
    {
      async resolve() {
        return revision();
      },
    },
    {
      async prepare() {
        return null;
      },
    },
  );
  assert.equal(await missingContext.prepare(candidate()), null);
});

test('rejects revision or executor drift before materializing any context', async () => {
  let contextCalls = 0;
  const create = (value) =>
    new PinnedTaskLocalRunDispatchPlanSource(
      {
        async resolve() {
          return value;
        },
      },
      {
        async prepare() {
          contextCalls += 1;
          return null;
        },
      },
    );

  await assert.rejects(
    create(revision({ taskRevision: 'revision-latest' })).prepare(candidate()),
    /does not match/,
  );
  await assert.rejects(
    create(revision({ executorType: 'remote_worker' })).prepare(candidate()),
    /does not match/,
  );
  assert.equal(contextCalls, 0);
});

test('bounds environment count, values, names and output capabilities', () => {
  const output = { async write() {} };
  assert.throws(
    () =>
      normalizeExecutionContext({
        environment: Object.fromEntries(
          Array.from(
            { length: MAX_EXECUTION_ENVIRONMENT_ENTRIES + 1 },
            (_, index) => [`KEY_${index}`, 'value'],
          ),
        ),
        output,
      }),
    /too many entries/,
  );
  assert.throws(
    () =>
      normalizeExecutionContext({
        environment: { 'INVALID=NAME': 'value' },
        output,
      }),
    /entry is invalid/,
  );
  assert.throws(
    () =>
      normalizeExecutionContext({
        environment: {},
        output: {},
      }),
    /output sink is invalid/,
  );
  const prototypeSafe = normalizeExecutionContext({
    environment: JSON.parse('{"__proto__":"literal"}'),
    output,
  });
  assert.equal(Object.getPrototypeOf(prototypeSafe.environment), null);
  assert.equal(prototypeSafe.environment.__proto__, 'literal');
});

test('disposes materialized capabilities when context validation fails', async () => {
  let disposeCalls = 0;
  const source = new PinnedTaskLocalRunDispatchPlanSource(
    {
      async resolve() {
        return revision();
      },
    },
    {
      async prepare() {
        return {
          context: { environment: {}, output: {} },
          dispose() {
            disposeCalls += 1;
          },
        };
      },
    },
  );

  await assert.rejects(source.prepare(candidate()), /output sink is invalid/);
  assert.equal(disposeCalls, 1);
});
