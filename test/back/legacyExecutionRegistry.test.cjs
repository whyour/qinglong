require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  LegacyExecutionRegistry,
} = require('../../back/runtime/compatibility/legacyExecutionRegistry');

function acceptedFact(legacyCronId) {
  return {
    origin: 'manual',
    projectId: 'default',
    taskId: `legacy-cron:${legacyCronId}`,
    taskRevision: 'sha256:revision',
    legacyCronId,
    triggerType: 'manual',
    acceptedAtMs: 100,
  };
}

function recorder(label, calls) {
  return {
    spawned: (fact) => calls.push([label, 'spawned', fact]),
    running: (fact) => calls.push([label, 'running', fact]),
    startFailed: (fact) => calls.push([label, 'start_failed', fact]),
    exited: (fact) => calls.push([label, 'exited', fact]),
    cancelled: (fact) => calls.push([label, 'cancelled', fact]),
  };
}

test('correlates local callbacks by log, then pid, and removes terminal entries', () => {
  const calls = [];
  const registry = new LegacyExecutionRegistry();
  const first = registry.register(acceptedFact(7), recorder('first', calls));
  const second = registry.register(acceptedFact(7), recorder('second', calls));
  first.spawned({ atMs: 101, pid: 11, logArtifactId: 'log-first' });
  second.spawned({ atMs: 101, pid: 22, logArtifactId: 'log-second' });

  assert.equal(
    registry.callback({
      legacyCronId: 7,
      pid: 999,
      logArtifactId: 'log-second',
      atMs: 102,
      phase: 'running',
    }),
    1,
  );
  assert.equal(
    registry.callback({
      legacyCronId: 7,
      pid: 11,
      atMs: 103,
      phase: 'finished',
      exitCode: 0,
    }),
    1,
  );
  assert.equal(registry.size(), 1);
  assert.equal(
    registry.cancel({
      legacyCronId: 7,
      atMs: 104,
      scope: 'all',
      reason: 'user',
    }),
    1,
  );
  assert.equal(registry.size(), 0);
  assert.deepEqual(
    calls.map(([label, operation]) => [label, operation]),
    [
      ['first', 'spawned'],
      ['second', 'spawned'],
      ['second', 'spawned'],
      ['second', 'running'],
      ['first', 'exited'],
      ['second', 'cancelled'],
    ],
  );
});

test('refuses ambiguous one-instance correlation and bounds local memory', () => {
  const calls = [];
  let overflows = 0;
  const registry = new LegacyExecutionRegistry({
    maxEntries: 1,
    onOverflow: () => {
      overflows += 1;
    },
  });
  registry.register(acceptedFact(8), recorder('tracked', calls));
  const untracked = registry.register(
    acceptedFact(8),
    recorder('untracked', calls),
  );

  assert.equal(overflows, 1);
  assert.equal(registry.size(), 1);
  untracked.running({ atMs: 200 });
  assert.equal(
    registry.callback({
      legacyCronId: 8,
      atMs: 201,
      phase: 'finished',
    }),
    1,
  );
  assert.equal(registry.size(), 0);
  assert.deepEqual(
    calls.map(([label, operation]) => [label, operation]),
    [
      ['untracked', 'running'],
      ['tracked', 'exited'],
    ],
  );

  const ambiguous = new LegacyExecutionRegistry();
  ambiguous.register(acceptedFact(9), recorder('a', calls));
  ambiguous.register(acceptedFact(9), recorder('b', calls));
  assert.equal(
    ambiguous.callback({
      legacyCronId: 9,
      atMs: 300,
      phase: 'running',
    }),
    0,
  );

  const conflicting = new LegacyExecutionRegistry();
  const left = conflicting.register(acceptedFact(12), recorder('left', calls));
  const right = conflicting.register(
    acceptedFact(12),
    recorder('right', calls),
  );
  left.spawned({ atMs: 1, pid: 1, logArtifactId: 'left-log' });
  right.spawned({ atMs: 1, pid: 2, logArtifactId: 'right-log' });
  assert.equal(
    conflicting.callback({
      legacyCronId: 12,
      pid: 1,
      logArtifactId: 'right-log',
      atMs: 2,
      phase: 'finished',
    }),
    0,
  );
});

test('cleans up entries after start failures and direct terminal observations', () => {
  const calls = [];
  const registry = new LegacyExecutionRegistry();
  const failed = registry.register(acceptedFact(10), recorder('failed', calls));
  failed.startFailed({ atMs: 2, errorCode: 'SPAWN_FAILED' });
  const exited = registry.register(acceptedFact(11), recorder('exited', calls));
  exited.exited({ atMs: 3, exitCode: 1 });

  assert.equal(registry.size(), 0);
});

test('swallows local observer failures and reports them out of band', () => {
  let failures = 0;
  const registry = new LegacyExecutionRegistry({
    onDispatchFailure: () => {
      failures += 1;
    },
  });
  const throwing = {
    spawned() {
      throw new Error('spawned failed');
    },
    running() {
      throw new Error('running failed');
    },
    startFailed() {
      throw new Error('start failed');
    },
    exited() {
      throw new Error('exit failed');
    },
    cancelled() {
      throw new Error('cancel failed');
    },
  };
  const observation = registry.register(acceptedFact(13), throwing);

  assert.doesNotThrow(() => {
    observation.spawned({ atMs: 1, pid: 13 });
    observation.running({ atMs: 2 });
    registry.cancel({
      legacyCronId: 13,
      pid: 13,
      atMs: 3,
      scope: 'one',
      reason: 'user',
    });
  });
  assert.equal(failures, 3);
  assert.equal(registry.size(), 0);
});
