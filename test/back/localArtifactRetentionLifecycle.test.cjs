require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  LocalArtifactRetentionLifecycle,
} = require('../../back/runtime/application/localArtifactRetentionLifecycle');

const CURSOR = {
  finishedAtMs: 1_800_000_000_000,
  attemptId: '019f7500-0000-7000-8000-000000000001',
};

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeScheduler() {
  let id = 0;
  const pending = new Map();
  const cleared = [];
  return {
    pending,
    cleared,
    scheduler: {
      setTimeout(callback, delayMs) {
        const timer = {
          id: ++id,
          delayMs,
          unrefCalls: 0,
          unref() {
            this.unrefCalls += 1;
          },
        };
        pending.set(timer.id, { timer, callback });
        return timer;
      },
      clearTimeout(timer) {
        cleared.push(timer.id);
        pending.delete(timer.id);
      },
    },
    fireNext() {
      const next = pending.values().next().value;
      assert.ok(next, 'expected a scheduled timer');
      pending.delete(next.timer.id);
      next.callback();
      return next.timer;
    },
  };
}

function memoryCheckpoints({ fenced = false } = {}) {
  let checkpoint = { version: 0 };
  const writes = [];
  return {
    writes,
    store: {
      async load() {
        return checkpoint;
      },
      async compareAndSet(value) {
        writes.push(value);
        if (fenced || value.expectedVersion !== checkpoint.version)
          return false;
        checkpoint = {
          version: checkpoint.version + 1,
          ...(value.cursor ? { cursor: { ...value.cursor } } : {}),
        };
        return true;
      },
    },
  };
}

function sweepResult(overrides = {}) {
  return {
    status: 'complete',
    pressure: false,
    observedAtMs: 1_800_000_001_000,
    retentionMs: 7 * 24 * 60 * 60_000,
    availableBytes: BigInt(1024),
    totalBytes: BigInt(2048),
    candidatesScanned: 0,
    deletionsAttempted: 0,
    recordsWritten: 0,
    failedCandidates: 0,
    bytesReclaimed: 0,
    entries: [],
    ...overrides,
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('persists only changed cursors and emits bounded aggregate metrics', async () => {
  const timers = fakeScheduler();
  const checkpoints = memoryCheckpoints();
  const cursors = [];
  const summaries = [];
  let calls = 0;
  const lifecycle = new LocalArtifactRetentionLifecycle(
    {
      async sweep(cursor) {
        cursors.push(cursor);
        calls += 1;
        if (calls === 1) {
          return sweepResult({
            status: 'page_complete',
            candidatesScanned: 8,
            deletionsAttempted: 8,
            recordsWritten: 8,
            bytesReclaimed: 4096,
            nextCursor: CURSOR,
            entries: [
              {
                attemptId: CURSOR.attemptId,
                logArtifactId: `local-${'a'.repeat(30)}`,
                outcome: 'deleted',
                bytesReclaimed: 4096,
              },
            ],
          });
        }
        return sweepResult();
      },
    },
    checkpoints.store,
    {
      intervalMs: 5_000,
      initialDelayMs: 100,
      scheduler: timers.scheduler,
      onCycle(summary) {
        summaries.push(summary);
      },
    },
  );

  assert.equal(lifecycle.start(), true);
  const initial = timers.fireNext();
  assert.equal(initial.delayMs, 100);
  assert.equal(initial.unrefCalls, 1);
  await flush();
  assert.equal(summaries[0].cursorAction, 'advanced');
  assert.equal(summaries[0].recordsWritten, 8);
  assert.equal('entries' in summaries[0], false);
  assert.equal(JSON.stringify(summaries[0]).includes(CURSOR.attemptId), false);
  assert.equal(summaries[0].availableBytes, '1024');

  timers.fireNext();
  await flush();
  assert.equal(summaries[1].cursorAction, 'cleared');
  timers.fireNext();
  await flush();
  assert.equal(summaries[2].cursorAction, 'unchanged');
  assert.deepEqual(cursors, [undefined, CURSOR, undefined]);
  assert.equal(checkpoints.writes.length, 2);
  assert.equal(await lifecycle.stop(), 'drained');
});

test('reports cursor fencing and observer failures without stopping cadence', async () => {
  const timers = fakeScheduler();
  const checkpoints = memoryCheckpoints({ fenced: true });
  const errors = [];
  const lifecycle = new LocalArtifactRetentionLifecycle(
    {
      async sweep() {
        return sweepResult({ status: 'page_complete', nextCursor: CURSOR });
      },
    },
    checkpoints.store,
    {
      intervalMs: 5_000,
      scheduler: timers.scheduler,
      onCycle(summary) {
        assert.equal(summary.cursorAction, 'fenced');
        throw new Error('metrics sink failed');
      },
      onError(error) {
        errors.push(error.message);
      },
    },
  );
  lifecycle.start();
  timers.fireNext();
  await flush();
  assert.deepEqual(errors, ['metrics sink failed']);
  assert.equal(timers.pending.size, 1);
  assert.equal(await lifecycle.stop(), 'drained');
});

test('never overlaps a slow sweep and bounds shutdown', async () => {
  const timers = fakeScheduler();
  const running = deferred();
  const checkpoints = memoryCheckpoints();
  let calls = 0;
  const lifecycle = new LocalArtifactRetentionLifecycle(
    {
      async sweep() {
        calls += 1;
        return running.promise;
      },
    },
    checkpoints.store,
    {
      intervalMs: 5_000,
      stopTimeoutMs: 5,
      scheduler: timers.scheduler,
    },
  );
  lifecycle.start();
  timers.fireNext();
  await flush();
  assert.equal(calls, 1);
  assert.equal(timers.pending.size, 0);
  assert.equal(await lifecycle.stop(), 'timed_out');
  assert.equal(lifecycle.start(), false);
  running.resolve(sweepResult());
  await flush();
  assert.equal(lifecycle.start(), true);
  assert.equal(await lifecycle.stop(), 'drained');
});

test('rejects hot loops, invalid incomplete results, and unbounded stops', async () => {
  const timers = fakeScheduler();
  const checkpoints = memoryCheckpoints();
  const service = {
    async sweep() {
      return sweepResult();
    },
  };
  assert.throws(
    () =>
      new LocalArtifactRetentionLifecycle(service, checkpoints.store, {
        intervalMs: 999,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      new LocalArtifactRetentionLifecycle(service, checkpoints.store, {
        intervalMs: 1_000,
        stopTimeoutMs: 60_001,
      }),
    RangeError,
  );

  const errors = [];
  const invalid = new LocalArtifactRetentionLifecycle(
    {
      async sweep() {
        return sweepResult({ status: 'page_complete' });
      },
    },
    checkpoints.store,
    {
      intervalMs: 1_000,
      scheduler: timers.scheduler,
      onError(error) {
        errors.push(error.message);
      },
    },
  );
  invalid.start();
  timers.fireNext();
  await flush();
  assert.match(errors[0], /requires a resume cursor/);
  await invalid.stop();
});
