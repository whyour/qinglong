require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  LocalRunDispatcher,
} = require('../../back/runtime/application/localRunDispatcher');
const {
  PrimaryClaimedRunRejectedError,
} = require('../../back/runtime/application/primaryRunOrchestrator');

const NOW = 1_760_000_000_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function candidate(id, overrides = {}) {
  return {
    runId: `run-${id}`,
    attemptId: `attempt-${id}`,
    projectId: 'default',
    taskId: `task-${id}`,
    taskRevision: 'revision-1',
    executorType: 'local_process',
    priority: 0,
    queuedAtMs: NOW,
    attemptCreatedAtMs: NOW,
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
    command: { kind: 'argv', file: '/bin/true', args: ['original'] },
    environmentPolicy: 'isolated',
    terminationGraceMs: 100,
    ...overrides,
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

function activeFor(command, completion = Promise.resolve({})) {
  return {
    run: { id: command.runId },
    attempt: { id: command.attemptId },
    handle: {},
    completion,
    async cancel() {},
  };
}

test('does no plan or activation work when no local candidate exists', async () => {
  let planCalls = 0;
  let activationCalls = 0;
  const dispatcher = new LocalRunDispatcher(
    candidateSource([[]]),
    {
      async prepare() {
        planCalls += 1;
        return null;
      },
    },
    {
      async activateClaimed() {
        activationCalls += 1;
      },
    },
    { executorType: 'local_process', clock: { now: () => NOW } },
  );

  const result = await dispatcher.dispatchOnce();
  assert.deepEqual([result.status, result.reason], ['idle', 'no_candidates']);
  assert.deepEqual([planCalls, activationCalls], [0, 0]);
});

test('bounded-pages to a matching executor and activates one cloned pinned plan', async () => {
  const remote = candidate('remote', { executorType: 'remote_worker' });
  const local = candidate('local', {
    queuedAtMs: NOW + 1,
    attemptCreatedAtMs: NOW + 1,
  });
  const pages = [];
  const sourceSpec = specFor(local, { timeoutMs: 5_000 });
  const context = { environment: {}, output: { async write() {} } };
  const completion = deferred();
  const activations = [];
  let disposed = 0;
  const dispatcher = new LocalRunDispatcher(
    candidateSource([[remote], [local]], pages),
    {
      async prepare(reference) {
        assert.equal(Object.isFrozen(reference), true);
        assert.equal(reference.attemptId, local.attemptId);
        return {
          executionSpec: sourceSpec,
          context,
          dispose() {
            disposed += 1;
          },
        };
      },
    },
    {
      async activateClaimed(command) {
        activations.push({ command, spec: command.createSpec() });
        return activeFor(command, completion.promise);
      },
    },
    {
      executorType: 'local_process',
      pageSize: 1,
      maxPages: 2,
      clock: { now: () => NOW },
    },
  );

  const result = await dispatcher.dispatchOnce();
  assert.equal(result.status, 'activated');
  assert.deepEqual(result.stats, {
    pages: 2,
    candidatesScanned: 2,
    executorMismatches: 1,
    plansUnavailable: 0,
    activationRaces: 0,
  });
  assert.equal(result.truncated, true);
  assert.equal(pages[1].after.attemptId, remote.attemptId);
  assert.equal(activations[0].command.timeoutMs, 5_000);
  assert.equal(activations[0].command.context, context);
  sourceSpec.command.args[0] = 'mutated';
  assert.deepEqual(activations[0].spec.command.args, ['original']);
  assert.equal(disposed, 0);
  completion.resolve({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, 1);
});

test('continues after a stale candidate and activates the next Attempt', async () => {
  const first = candidate('first');
  const second = candidate('second', {
    queuedAtMs: NOW + 1,
    attemptCreatedAtMs: NOW + 1,
  });
  const attempted = [];
  const dispatcher = new LocalRunDispatcher(
    candidateSource([[first, second]]),
    {
      async prepare(reference) {
        return {
          executionSpec: specFor(reference),
          context: { environment: {}, output: { async write() {} } },
        };
      },
    },
    {
      async activateClaimed(command) {
        attempted.push(command.attemptId);
        if (command.attemptId === first.attemptId) {
          throw new PrimaryClaimedRunRejectedError('not_queued');
        }
        return activeFor(command);
      },
    },
    {
      executorType: 'local_process',
      pageSize: 2,
      clock: { now: () => NOW },
    },
  );

  const result = await dispatcher.dispatchOnce();
  assert.equal(result.status, 'activated');
  assert.deepEqual(attempted, [first.attemptId, second.attemptId]);
  assert.equal(result.stats.activationRaces, 1);
});

test('fails closed on plan drift before activation and disposes its context', async () => {
  const reference = candidate('drift');
  let activationCalls = 0;
  let disposeCalls = 0;
  const dispatcher = new LocalRunDispatcher(
    candidateSource([[reference]]),
    {
      async prepare() {
        return {
          executionSpec: specFor(reference, { taskRevision: 'drifted' }),
          context: { environment: {}, output: { async write() {} } },
          dispose() {
            disposeCalls += 1;
          },
        };
      },
    },
    {
      async activateClaimed() {
        activationCalls += 1;
      },
    },
    { executorType: 'local_process', clock: { now: () => NOW } },
  );

  await assert.rejects(dispatcher.dispatchOnce(), /identity does not match/);
  assert.deepEqual([activationCalls, disposeCalls], [0, 1]);
});

test('reports missing plans and rejects unordered or unbounded pages', async () => {
  const reference = candidate('missing');
  const missing = new LocalRunDispatcher(
    candidateSource([[reference]]),
    {
      async prepare() {
        return null;
      },
    },
    { async activateClaimed() {} },
    { executorType: 'local_process', clock: { now: () => NOW } },
  );
  const result = await missing.dispatchOnce();
  assert.deepEqual(
    [result.status, result.reason],
    ['idle', 'plans_unavailable'],
  );

  const duplicate = new LocalRunDispatcher(
    candidateSource([[reference, reference]]),
    {
      async prepare() {
        return null;
      },
    },
    { async activateClaimed() {} },
    {
      executorType: 'local_process',
      pageSize: 2,
      clock: { now: () => NOW },
    },
  );
  await assert.rejects(duplicate.dispatchOnce(), /not strictly ordered/);
  assert.throws(
    () =>
      new LocalRunDispatcher(
        candidateSource([[]]),
        {
          async prepare() {
            return null;
          },
        },
        { async activateClaimed() {} },
        {
          executorType: 'local_process',
          maxPages: 17,
          clock: { now: () => NOW },
        },
      ),
    RangeError,
  );
});

test('passes the Artifact identity to activation and awaits failed-plan cleanup', async () => {
  const reference = candidate('artifact');
  const order = [];
  const dispatcher = new LocalRunDispatcher(
    candidateSource([[reference]]),
    {
      async prepare() {
        return {
          executionSpec: specFor(reference),
          context: { environment: {}, output: { async write() {} } },
          logArtifactId: `local-${'a'.repeat(30)}`,
          async dispose() {
            await new Promise((resolve) => setImmediate(resolve));
            order.push('disposed');
          },
        };
      },
    },
    {
      async activateClaimed(command) {
        order.push(command.logArtifactId);
        throw new PrimaryClaimedRunRejectedError('not_queued');
      },
    },
    { executorType: 'local_process', clock: { now: () => NOW } },
  );

  const result = await dispatcher.dispatchOnce();
  assert.equal(result.status, 'idle');
  assert.deepEqual(order, [`local-${'a'.repeat(30)}`, 'disposed']);
});
