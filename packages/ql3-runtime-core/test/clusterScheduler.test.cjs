const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidClusterScheduleError,
  normalizeClaimClusterScheduleCommand,
  normalizeClusterScheduleClaim,
  normalizeCommitClusterScheduleDecisionCommand,
  resolveClusterScheduleDecision,
} = require('../dist/scheduler/clusterScheduler');

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
    stateVersion: 2,
    nextFireAtMs: 60_000,
    claimOwner: 'scheduler-a',
    claimToken: '019f7700-0000-7000-8000-000000000001',
    claimVersion: 1,
    claimAcquiredAtMs: 60_000,
    claimExpiresAtMs: 120_000,
    ...overrides,
  };
}

test('normalizes a database-timed schedule claim and resolves one occurrence', () => {
  assert.deepEqual(normalizeClusterScheduleClaim(claim()), claim());
  assert.equal(
    resolveClusterScheduleDecision(claim(), 5_000, nextMinute).disposition,
    'admit',
  );
  assert.deepEqual(
    normalizeClaimClusterScheduleCommand({
      ownerId: 'scheduler-a',
      claimToken: '019f7700-0000-7000-8000-000000000002',
      leaseMs: 30_000,
    }),
    {
      ownerId: 'scheduler-a',
      claimToken: '019f7700-0000-7000-8000-000000000002',
      leaseMs: 30_000,
    },
  );
});

test('rejects widened, caller-timed and weak schedule claims', () => {
  assert.throws(
    () => normalizeClusterScheduleClaim(claim({ claimAcquiredAtMs: 120_000 })),
    InvalidClusterScheduleError,
  );
  assert.throws(
    () => normalizeClusterScheduleClaim({ ...claim(), extra: true }),
    InvalidClusterScheduleError,
  );
  assert.throws(
    () =>
      normalizeClaimClusterScheduleCommand({
        ownerId: 'scheduler-a',
        claimToken: 'not-a-uuid',
        leaseMs: 1,
      }),
    InvalidClusterScheduleError,
  );
  assert.throws(
    () =>
      normalizeClaimClusterScheduleCommand({
        ownerId: 'scheduler-a',
        claimToken: '019f7700-0000-7000-8000-000000000002',
        observedAtMs: 60_000,
        leaseMs: 30_000,
      }),
    InvalidClusterScheduleError,
  );
});

test('normalizes an exact admission command and binds every decision fact', () => {
  const claimed = claim();
  const decision = resolveClusterScheduleDecision(claimed, 5_000, nextMinute);
  const command = {
    claim: claimed,
    decision,
    runId: '019f7700-0000-7000-8000-000000000003',
    attemptId: '019f7700-0000-7000-8000-000000000004',
    createdEventId: '019f7700-0000-7000-8000-000000000005',
    queuedEventId: '019f7700-0000-7000-8000-000000000006',
  };
  assert.deepEqual(
    normalizeCommitClusterScheduleDecisionCommand(command),
    command,
  );
  assert.throws(
    () =>
      normalizeCommitClusterScheduleDecisionCommand({
        ...command,
        decision: {
          ...decision,
          candidate: { ...decision.candidate, stateVersion: 3 },
        },
      }),
    InvalidClusterScheduleError,
  );
  assert.throws(
    () =>
      normalizeCommitClusterScheduleDecisionCommand({
        claim: claimed,
        decision: {
          candidate: decision.candidate,
          observedAtMs: 60_001,
          nextFireAtMs: decision.nextFireAtMs,
          disposition: 'skip',
        },
        runId: command.runId,
      }),
    InvalidClusterScheduleError,
  );
});
