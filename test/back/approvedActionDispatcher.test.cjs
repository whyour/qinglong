require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ApprovedActionDispatcher,
} = require('../../back/runtime/application/approvedActionDispatcher');

function pendingSnapshot(name = 'one') {
  return {
    dispatch: {
      id: `dispatch-${name}`,
      approvalRequestId: `approval-${name}`,
      approvalRequestVersion: 3,
      projectId: 'default',
      state: 'pending',
      action: {
        permission: 'tool.call:filesystem.write',
        actionType: 'tool_call',
        actionRef: `planned-${name}`,
        actionDigest: 'a'.repeat(64),
        previewDigest: 'f'.repeat(64),
      },
      requestedBy: { type: 'agent', id: 'agent-1' },
      consumedBy: { type: 'system', id: 'approval-dispatcher' },
      createdAtMs: 100,
    },
    execution: {
      dispatchId: `dispatch-${name}`,
      projectId: 'default',
      status: 'pending',
      version: 0,
      attemptCount: 0,
      maxAttempts: 5,
      eligibleAtMs: 100,
      nextAttemptAtMs: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAtMs: null,
      startedAtMs: null,
      resultMutationId: null,
      lastResultCode: null,
      completedAtMs: null,
      createdAtMs: 100,
      updatedAtMs: 100,
    },
  };
}

function fakeRepository(options = {}) {
  const calls = [];
  const initial = pendingSnapshot();
  return {
    calls,
    async listDue(query) {
      calls.push(['list', query]);
      return {
        dispatches: [initial],
        truncated: false,
      };
    },
    async claim(command) {
      calls.push(['claim', command]);
      return {
        status: 'claimed',
        snapshot: {
          dispatch: initial.dispatch,
          execution: {
            ...initial.execution,
            status: 'leased',
            version: 1,
            attemptCount: 1,
            eligibleAtMs: command.nowMs + command.leaseDurationMs,
            leaseOwner: command.owner,
            leaseToken: command.leaseToken,
            leaseExpiresAtMs: command.nowMs + command.leaseDurationMs,
            updatedAtMs: command.nowMs,
          },
        },
      };
    },
    async start(command) {
      calls.push(['start', command]);
      if (options.startError) throw new Error('start unavailable');
      const claim = calls.find((entry) => entry[0] === 'claim')[1];
      return {
        dispatch: initial.dispatch,
        execution: {
          ...initial.execution,
          status: 'executing',
          version: 2,
          attemptCount: 1,
          eligibleAtMs: null,
          leaseOwner: claim.owner,
          leaseToken: claim.leaseToken,
          leaseExpiresAtMs: claim.nowMs + claim.leaseDurationMs,
          startedAtMs: command.startedAtMs,
          updatedAtMs: command.startedAtMs,
        },
      };
    },
    async releaseBeforeStart(command) {
      calls.push(['release', command]);
      return {
        dispatch: initial.dispatch,
        execution: {
          ...initial.execution,
          status: command.retryAtMs === undefined ? 'blocked' : 'retry_wait',
          version: 2,
          attemptCount: 1,
          eligibleAtMs: command.retryAtMs ?? null,
          nextAttemptAtMs: command.retryAtMs ?? null,
          resultMutationId: command.resultMutationId,
          lastResultCode: command.resultCode,
          completedAtMs: command.retryAtMs === undefined ? command.atMs : null,
          updatedAtMs: command.atMs,
        },
      };
    },
    async complete(command) {
      calls.push(['complete', command]);
      if (options.completeError) throw new Error('completion unavailable');
      return {
        dispatch: initial.dispatch,
        execution: {
          ...initial.execution,
          status:
            command.outcome === 'indeterminate' ? 'blocked' : command.outcome,
          version: 3,
          attemptCount: 1,
          eligibleAtMs: null,
          startedAtMs: 103,
          resultMutationId: command.resultMutationId,
          lastResultCode: command.resultCode,
          completedAtMs: command.completedAtMs,
          updatedAtMs: command.completedAtMs,
        },
      };
    },
  };
}

function deterministicOptions() {
  let now = 100;
  let id = 0;
  return {
    owner: 'dispatcher-1',
    leaseDurationMs: 1_000,
    retryBaseMs: 10,
    retryMaxMs: 100,
    clock: () => ++now,
    createId: () => `mutation-${++id}`,
  };
}

function handler(overrides = {}) {
  return {
    actionType: 'tool_call',
    async inspect(dispatch) {
      return { status: 'ready', actionDigest: dispatch.action.actionDigest };
    },
    async execute() {
      return { outcome: 'succeeded', resultCode: 'ok' };
    },
    ...overrides,
  };
}

test('persists the start barrier before invoking a successful handler', async () => {
  const repository = fakeRepository();
  const observed = [];
  const dispatcher = new ApprovedActionDispatcher(
    repository,
    [
      handler({
        async inspect(dispatch) {
          observed.push(['inspect', dispatch.id]);
          return {
            status: 'ready',
            actionDigest: dispatch.action.actionDigest,
          };
        },
        async execute(context) {
          observed.push(['execute', context.dispatch.id]);
          assert.equal(context.idempotencyKey, 'dispatch-one');
          assert.equal(context.execution.status, 'executing');
          assert.equal(context.fence.owner, 'dispatcher-1');
          assert.equal(context.fence.version, 2);
          return { outcome: 'succeeded', resultCode: 'ok' };
        },
      }),
    ],
    deterministicOptions(),
  );
  const summary = await dispatcher.dispatchBatch({ limit: 1 });
  assert.deepEqual(
    repository.calls.map((entry) => entry[0]),
    ['list', 'claim', 'start', 'complete'],
  );
  assert.deepEqual(observed, [
    ['inspect', 'dispatch-one'],
    ['execute', 'dispatch-one'],
  ]);
  assert.equal(summary.claimed, 1);
  assert.equal(summary.started, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.blocked, 0);
});

test('missing handlers and inspection failures retry only before start', async () => {
  for (const handlers of [
    [],
    [
      handler({
        async inspect() {
          throw new Error('temporary inspection failure');
        },
      }),
    ],
  ]) {
    const repository = fakeRepository();
    const dispatcher = new ApprovedActionDispatcher(
      repository,
      handlers,
      deterministicOptions(),
    );
    const summary = await dispatcher.dispatchBatch();
    assert.deepEqual(
      repository.calls.map((entry) => entry[0]),
      ['list', 'claim', 'release'],
    );
    assert.equal(summary.retrying, 1);
    assert.equal(summary.started, 0);
  }
});

test('digest drift and explicit inspection blocks never invoke execute', async () => {
  for (const inspection of [
    { status: 'ready', actionDigest: 'b'.repeat(64) },
    { status: 'blocked', resultCode: 'plan_revoked' },
  ]) {
    let executed = false;
    const repository = fakeRepository();
    const dispatcher = new ApprovedActionDispatcher(
      repository,
      [
        handler({
          async inspect() {
            return inspection;
          },
          async execute() {
            executed = true;
            return { outcome: 'succeeded', resultCode: 'ok' };
          },
        }),
      ],
      deterministicOptions(),
    );
    const summary = await dispatcher.dispatchBatch();
    assert.equal(executed, false);
    assert.equal(summary.blocked, 1);
    assert.deepEqual(
      repository.calls.map((entry) => entry[0]),
      ['list', 'claim', 'release'],
    );
  }
});

test('handler exceptions after start become indeterminate terminal evidence', async () => {
  const repository = fakeRepository();
  const dispatcher = new ApprovedActionDispatcher(
    repository,
    [
      handler({
        async execute() {
          throw new Error('transport disappeared after invocation');
        },
      }),
    ],
    deterministicOptions(),
  );
  const summary = await dispatcher.dispatchBatch();
  const completion = repository.calls.find(
    (entry) => entry[0] === 'complete',
  )[1];
  assert.equal(completion.outcome, 'indeterminate');
  assert.equal(completion.resultCode, 'handler_failed_after_start');
  assert.equal(summary.blocked, 1);
  assert.equal(summary.retrying, 0);
});

test('a completion persistence failure reports recovery instead of retrying execute', async () => {
  let executions = 0;
  const repository = fakeRepository({ completeError: true });
  const dispatcher = new ApprovedActionDispatcher(
    repository,
    [
      handler({
        async execute() {
          executions += 1;
          return { outcome: 'succeeded', resultCode: 'ok' };
        },
      }),
    ],
    deterministicOptions(),
  );
  const summary = await dispatcher.dispatchBatch();
  assert.equal(executions, 1);
  assert.equal(summary.unavailable, 1);
  assert.equal(summary.recoveryRequired, 1);
  assert.equal(
    repository.calls.some((entry) => entry[0] === 'release'),
    false,
  );
});

test('rejects duplicate handlers and extensible handler results', async () => {
  assert.throws(
    () =>
      new ApprovedActionDispatcher(
        fakeRepository(),
        [handler(), handler()],
        deterministicOptions(),
      ),
    /Duplicate approved action handler/,
  );
  const repository = fakeRepository();
  const dispatcher = new ApprovedActionDispatcher(
    repository,
    [
      handler({
        async inspect(dispatch) {
          return {
            status: 'ready',
            actionDigest: dispatch.action.actionDigest,
            injected: true,
          };
        },
      }),
    ],
    deterministicOptions(),
  );
  const summary = await dispatcher.dispatchBatch();
  assert.equal(summary.retrying, 1);
  assert.equal(
    repository.calls.some((entry) => entry[0] === 'start'),
    false,
  );
});
