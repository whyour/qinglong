require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PrimaryCancellationDispatcher,
} = require('../../back/runtime/application/primaryCancellationDispatcher');

const NOW_MS = 1_750_000_000_100;

function candidate(runId, overrides = {}) {
  return {
    runId,
    requestedAtMs: NOW_MS - 10,
    reason: 'user',
    attempts: [
      {
        attemptId: `${runId}-attempt`,
        executorType: 'local_process',
        executorHandle: `handle:${runId}`,
        pid: 4001,
      },
    ],
    ...overrides,
  };
}

function fakeDispatchRepository(overrides = {}) {
  const claims = [];
  const results = [];
  return {
    claims,
    results,
    async findByRunId() {
      return null;
    },
    async claim(command) {
      claims.push(command);
      if (overrides.claim) return overrides.claim(command);
      return {
        status: 'claimed',
        leaseToken: command.leaseToken,
        dispatch: {
          runId: command.runId,
          attemptId: command.attemptId,
          status: 'leased',
          version: 1,
          dispatchCount: 1,
          leaseOwner: command.owner,
          leaseTokenDigest: 'a'.repeat(64),
          leaseExpiresAtMs: NOW_MS + command.leaseDurationMs,
          createdAtMs: NOW_MS,
          updatedAtMs: NOW_MS,
        },
      };
    },
    async recordResult(command) {
      results.push(command);
      if (overrides.recordResult) return overrides.recordResult(command);
      return {
        dispatch: {
          runId: command.runId,
          attemptId: command.attemptId,
          status: command.retryDelayMs ? 'retry_wait' : 'dispatched',
          version: command.expectedVersion + 1,
          dispatchCount: 1,
          lastResult: command.result,
          createdAtMs: NOW_MS,
          updatedAtMs: NOW_MS,
        },
        event: {
          id: command.eventId,
          runId: command.runId,
          sequence: 1,
          type: 'fixture',
          actorType: 'worker',
          payload: {},
          createdAtMs: NOW_MS,
        },
      };
    },
  };
}

function dispatcherOptions(overrides = {}) {
  let id = 0;
  return {
    owner: 'worker-a',
    leaseDurationMs: 100,
    retryBaseMs: 1_000,
    retryMaxMs: 8_000,
    createId: () => `019f71d0-0000-7000-8000-${String(++id).padStart(12, '0')}`,
    ...overrides,
  };
}

test('leases before signalling and durably classifies every controller result', async () => {
  const stopped = [];
  const source = {
    async listCandidates(options) {
      assert.deepEqual(options, { limit: 8 });
      return {
        candidates: [
          candidate('run-1'),
          candidate('run-2'),
          candidate('run-3', { attempts: [] }),
          candidate('run-4', {
            attempts: [
              {
                attemptId: 'attempt-4a',
                executorType: 'local_process',
                executorHandle: 'handle:4a',
              },
              {
                attemptId: 'attempt-4b',
                executorType: 'local_process',
                executorHandle: 'handle:4b',
              },
            ],
          }),
          candidate('run-5', {
            attempts: [
              {
                attemptId: 'attempt-5',
                executorType: 'remote_worker',
                executorHandle: 'remote:5',
              },
            ],
          }),
          candidate('run-6'),
          candidate('run-7'),
          candidate('run-8'),
        ],
        truncated: true,
        unsafeAttemptOverflow: false,
        nextCursor: { requestedAtMs: NOW_MS - 10, runId: 'run-8' },
      };
    },
  };
  const dispatches = fakeDispatchRepository({
    claim(command) {
      if (command.runId === 'run-8') {
        return {
          status: 'leased',
          dispatch: {
            runId: command.runId,
            attemptId: command.attemptId,
            status: 'leased',
            version: 3,
            dispatchCount: 2,
            leaseOwner: 'worker-b',
            leaseTokenDigest: 'b'.repeat(64),
            leaseExpiresAtMs: NOW_MS + 1_000,
            createdAtMs: NOW_MS - 5_000,
            updatedAtMs: NOW_MS - 100,
          },
        };
      }
      return {
        status: 'claimed',
        leaseToken: command.leaseToken,
        dispatch: {
          runId: command.runId,
          attemptId: command.attemptId,
          status: 'leased',
          version: 1,
          dispatchCount: 1,
          leaseOwner: command.owner,
          leaseTokenDigest: 'a'.repeat(64),
          leaseExpiresAtMs: NOW_MS + command.leaseDurationMs,
          createdAtMs: NOW_MS,
          updatedAtMs: NOW_MS,
        },
      };
    },
  });
  let calls = 0;
  const controller = {
    executorType: 'local_process',
    async stop(input) {
      calls += 1;
      stopped.push(input);
      if (calls === 1) {
        return {
          status: 'termination_requested',
          termSignalSent: true,
          killSignalSent: false,
        };
      }
      if (calls === 2) {
        return {
          status: 'already_exited',
          termSignalSent: false,
          killSignalSent: false,
        };
      }
      if (calls === 3) throw new Error('transient stop failure');
      return {
        status: 'identity_mismatch',
        termSignalSent: false,
        killSignalSent: false,
      };
    },
  };
  const dispatcher = new PrimaryCancellationDispatcher(
    source,
    dispatches,
    [controller],
    dispatcherOptions(),
  );

  const summary = await dispatcher.dispatchBatch({ limit: 8 });
  assert.deepEqual(summary, {
    scanned: 8,
    claimed: 5,
    terminationRequested: 1,
    alreadyExited: 1,
    pending: 5,
    ambiguous: 1,
    blocked: 1,
    deferred: 1,
    alreadyResolved: 0,
    notEligible: 0,
    failed: 1,
    truncated: true,
    unsafeAttemptOverflow: false,
    nextCursor: { requestedAtMs: NOW_MS - 10, runId: 'run-8' },
  });
  assert.equal(stopped.length, 4);
  assert.deepEqual(stopped[0], {
    durableHandle: 'handle:run-1',
    expectedPid: 4001,
    reason: { kind: 'user', requestedAtMs: NOW_MS - 10 },
  });
  assert.deepEqual(
    dispatches.results.map((result) => result.result),
    [
      'termination_requested',
      'already_exited',
      'controller_missing',
      'dispatch_error',
      'identity_mismatch',
    ],
  );
  assert.equal(
    dispatches.results.find((result) => result.result === 'dispatch_error')
      .retryDelayMs,
    1_000,
  );
});

test('fails closed on unsafe overflow, duplicate controllers, and corrupt reasons', async () => {
  let stopCalls = 0;
  const controller = {
    executorType: 'local_process',
    async stop() {
      stopCalls += 1;
      throw new Error('must not run');
    },
  };
  const dispatches = fakeDispatchRepository();
  assert.throws(
    () =>
      new PrimaryCancellationDispatcher(
        { async listCandidates() {} },
        dispatches,
        [controller, controller],
        dispatcherOptions(),
      ),
    /Duplicate persisted Executor controller/,
  );

  const overflow = new PrimaryCancellationDispatcher(
    {
      async listCandidates() {
        return {
          candidates: [],
          truncated: true,
          unsafeAttemptOverflow: true,
        };
      },
    },
    dispatches,
    [controller],
    dispatcherOptions(),
  );
  const overflowSummary = await overflow.dispatchBatch();
  assert.equal(overflowSummary.unsafeAttemptOverflow, true);

  const corrupt = new PrimaryCancellationDispatcher(
    {
      async listCandidates() {
        return {
          candidates: [candidate('run-corrupt', { reason: 'raw-corruption' })],
          truncated: false,
          unsafeAttemptOverflow: false,
        };
      },
    },
    dispatches,
    [controller],
    dispatcherOptions(),
  );
  const corruptSummary = await corrupt.dispatchBatch();
  assert.equal(corruptSummary.pending, 1);
  assert.equal(stopCalls, 0);
  assert.equal(dispatches.claims.length, 0);
});

test('reports persisted terminal, deferred, stale, and failed claims without signalling', async () => {
  const statuses = new Map([
    ['run-not-due', 'not_due'],
    ['run-dispatched', 'dispatched'],
    ['run-blocked', 'blocked'],
    ['run-stale', 'not_eligible'],
  ]);
  const dispatches = fakeDispatchRepository({
    claim(command) {
      if (command.runId === 'run-failed') throw new Error('database busy');
      const status = statuses.get(command.runId);
      if (status === 'not_eligible') return { status };
      return {
        status,
        dispatch: {
          runId: command.runId,
          attemptId: command.attemptId,
          status: status === 'not_due' ? 'retry_wait' : status,
          version: 2,
          dispatchCount: 1,
          createdAtMs: NOW_MS - 1_000,
          updatedAtMs: NOW_MS - 500,
        },
      };
    },
  });
  let stopCalls = 0;
  const dispatcher = new PrimaryCancellationDispatcher(
    {
      async listCandidates() {
        return {
          candidates: [
            candidate('run-not-due'),
            candidate('run-dispatched'),
            candidate('run-blocked'),
            candidate('run-stale'),
            candidate('run-failed'),
          ],
          truncated: false,
          unsafeAttemptOverflow: false,
        };
      },
    },
    dispatches,
    [
      {
        executorType: 'local_process',
        async stop() {
          stopCalls += 1;
          throw new Error('must not run');
        },
      },
    ],
    dispatcherOptions(),
  );
  const summary = await dispatcher.dispatchBatch();
  assert.equal(summary.deferred, 1);
  assert.equal(summary.alreadyResolved, 2);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.notEligible, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.pending, 2);
  assert.equal(stopCalls, 0);
});

test('counts result persistence failure while retaining the signal outcome', async () => {
  const dispatches = fakeDispatchRepository({
    recordResult() {
      throw new Error('commit failed');
    },
  });
  const dispatcher = new PrimaryCancellationDispatcher(
    {
      async listCandidates() {
        return {
          candidates: [candidate('run-signal-before-commit')],
          truncated: false,
          unsafeAttemptOverflow: false,
        };
      },
    },
    dispatches,
    [
      {
        executorType: 'local_process',
        async stop() {
          return {
            status: 'termination_requested',
            termSignalSent: true,
            killSignalSent: false,
          };
        },
      },
    ],
    dispatcherOptions(),
  );
  const summary = await dispatcher.dispatchBatch();
  assert.equal(summary.terminationRequested, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.pending, 1);
});
