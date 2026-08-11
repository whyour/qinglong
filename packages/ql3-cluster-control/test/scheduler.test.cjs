const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterSchedulerCoordinator,
  ClusterSchedulerLifecycle,
} = require('../dist/scheduling/scheduler');

function nextMinute(schedule, afterMs) {
  if (schedule.expression !== '* * * * *' || schedule.timezone !== 'UTC') {
    throw new Error('unsupported test schedule');
  }
  return Math.floor(afterMs / 60_000 + 1) * 60_000;
}

function claim(overrides = {}) {
  return {
    projectId: 'default',
    triggerId: 'trigger-1',
    triggerRevision: 1,
    triggerContentDigest: 'a'.repeat(64),
    triggerUpdatedAtMs: 1,
    taskId: 'task-1',
    taskRevision: 1,
    taskContentDigest: 'b'.repeat(64),
    expression: '* * * * *',
    timezone: 'UTC',
    misfirePolicy: 'skip',
    stateVersion: 1,
    nextFireAtMs: 60_000,
    claimOwner: 'scheduler-a',
    claimToken: '019f7800-0000-7000-8000-000000000001',
    claimVersion: 1,
    claimAcquiredAtMs: 61_000,
    claimExpiresAtMs: 91_000,
    ...overrides,
  };
}

function idFactory() {
  let value = 0;
  return () => `019f7800-0000-7000-8000-${String(++value).padStart(12, '0')}`;
}

test('claims a bounded cycle and notifies only fenced admissions', async () => {
  const claims = [
    claim(),
    claim({
      triggerId: 'trigger-2',
      claimToken: '019f7800-0000-7000-8000-000000000002',
      claimAcquiredAtMs: 62_000,
      claimExpiresAtMs: 92_000,
    }),
  ];
  const claimCommands = [];
  const commits = [];
  const notified = [];
  const coordinator = new ClusterSchedulerCoordinator(
    {
      async claimNextClusterSchedule(command) {
        claimCommands.push(command);
        const next = claims.shift();
        return next
          ? {
              ...next,
              claimOwner: command.ownerId,
              claimToken: command.claimToken,
            }
          : null;
      },
      async commitClusterScheduleDecision(command) {
        commits.push(command);
        if (commits.length === 2) return { status: 'raced' };
        return {
          status: 'admitted',
          disposition: 'admit',
          runId: command.runId,
          attemptId: command.attemptId,
        };
      },
    },
    {
      ownerId: 'scheduler-a',
      claimLeaseMs: 30_000,
      maxClaimsPerCycle: 4,
      misfireGraceMs: 5_000,
      nextOccurrence: nextMinute,
      createId: idFactory(),
      onAdmitted: (runId, attemptId) => notified.push([runId, attemptId]),
    },
  );

  assert.deepEqual(await coordinator.scheduleOnce(), {
    firstClaimAcquiredAtMs: 61_000,
    lastClaimAcquiredAtMs: 62_000,
    claimed: 2,
    initialized: 0,
    skipped: 0,
    admitted: 1,
    raced: 1,
    saturated: false,
  });
  assert.equal(claimCommands.length, 3);
  assert.equal(
    claimCommands.every(({ ownerId }) => ownerId === 'scheduler-a'),
    true,
  );
  assert.equal(commits.length, 2);
  assert.deepEqual(notified, [[commits[0].runId, commits[0].attemptId]]);
});

test('does not allocate Run identities for a skipped occurrence', async () => {
  let claimed = false;
  const commands = [];
  let allocations = 0;
  const skipped = claim({
    nextFireAtMs: 60_000,
    claimAcquiredAtMs: 900_000,
    claimExpiresAtMs: 930_000,
  });
  const coordinator = new ClusterSchedulerCoordinator(
    {
      async claimNextClusterSchedule(command) {
        if (claimed) return null;
        claimed = true;
        return {
          ...skipped,
          claimOwner: command.ownerId,
          claimToken: command.claimToken,
        };
      },
      async commitClusterScheduleDecision(command) {
        commands.push(command);
        return { status: 'advanced', disposition: 'skip' };
      },
    },
    {
      ownerId: 'scheduler-a',
      misfireGraceMs: 0,
      nextOccurrence: nextMinute,
      createId() {
        allocations += 1;
        return `019f7800-0000-7000-8000-${String(allocations).padStart(
          12,
          '0',
        )}`;
      },
    },
  );
  const summary = await coordinator.scheduleOnce();
  assert.equal(summary.skipped, 1);
  assert.equal(allocations, 2);
  assert.equal(commands[0].runId, undefined);
  assert.equal(commands[0].attemptId, undefined);
});

test('marks a cycle saturated at its hard claim budget', async () => {
  let version = 0;
  const coordinator = new ClusterSchedulerCoordinator(
    {
      async claimNextClusterSchedule(command) {
        version += 1;
        return claim({
          stateVersion: version,
          claimVersion: version,
          claimOwner: command.ownerId,
          claimToken: command.claimToken,
        });
      },
      async commitClusterScheduleDecision(command) {
        return {
          status: 'admitted',
          disposition: 'admit',
          runId: command.runId,
          attemptId: command.attemptId,
        };
      },
    },
    {
      ownerId: 'scheduler-a',
      maxClaimsPerCycle: 2,
      nextOccurrence: nextMinute,
      createId: idFactory(),
    },
  );
  const summary = await coordinator.scheduleOnce();
  assert.equal(summary.claimed, 2);
  assert.equal(summary.saturated, true);
});

test('rejects a node-local clock as scheduler authority', () => {
  assert.throws(
    () =>
      new ClusterSchedulerCoordinator(
        {
          async claimNextClusterSchedule() {
            return null;
          },
          async commitClusterScheduleDecision() {
            return { status: 'raced' };
          },
        },
        {
          ownerId: 'scheduler-a',
          clock: () => 1,
        },
      ),
    /options are invalid/,
  );
});

test('lifecycle coalesces work and drains without overlapping cycles', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const summary = {
    firstClaimAcquiredAtMs: null,
    lastClaimAcquiredAtMs: null,
    claimed: 0,
    initialized: 0,
    skipped: 0,
    admitted: 0,
    raced: 0,
    saturated: false,
  };
  const lifecycle = new ClusterSchedulerLifecycle(
    {
      async scheduleOnce() {
        calls += 1;
        await pending;
        return summary;
      },
    },
    { intervalMs: 250, stopTimeoutMs: 1_000 },
  );
  assert.equal(lifecycle.start(), 'started');
  const first = lifecycle.runOnce();
  assert.equal(lifecycle.runOnce(), first);
  const stopping = lifecycle.stopAndDrain();
  release();
  assert.deepEqual(await first, summary);
  assert.deepEqual(await stopping, { status: 'stopped' });
  assert.equal(calls, 1);
  await assert.rejects(lifecycle.runOnce(), /stopping/);
});
