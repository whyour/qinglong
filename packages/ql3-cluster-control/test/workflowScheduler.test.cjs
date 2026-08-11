'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterWorkflowSchedulerCoordinator,
} = require('@qinglong/cluster-control/workflow-scheduler');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function schedulerSummary() {
  return Object.freeze({
    firstClaimAcquiredAtMs: null,
    lastClaimAcquiredAtMs: null,
    claimed: 0,
    initialized: 0,
    skipped: 0,
    admitted: 0,
    raced: 0,
    saturated: false,
  });
}

test('advances Workflow frontier and admits Tasks inside one existing scheduler cadence', async () => {
  const calls = [];
  const scheduler = {
    async scheduleOnce() {
      calls.push('schedule');
      return schedulerSummary();
    },
  };
  const frontier = {
    async listCandidates(query) {
      calls.push(`frontier:list:${query.after?.planDigest ?? 'start'}`);
      if (!query.after) {
        return {
          candidates: [
            { runId: 'run-a' },
            { runId: 'run-b' },
          ],
          truncated: true,
          next: { admittedAtMs: 2, planDigest: DIGEST_A },
        };
      }
      return {
        candidates: [{ runId: 'run-c' }],
        truncated: false,
      };
    },
    async advance(runId) {
      calls.push(`frontier:advance:${runId}`);
      return { status: 'advanced' };
    },
  };
  const taskAttempts = {
    async listCandidates(query) {
      calls.push(`attempt:list:${query.after?.stepRunId ?? 'start'}`);
      if (!query.after) {
        return {
          candidates: [
            { runId: 'run-a', stepRunId: 'step-a' },
            { runId: 'run-b', stepRunId: 'step-b' },
          ],
          truncated: true,
          next: { readyAtMs: 3, stepRunId: 'step-b' },
        };
      }
      return {
        candidates: [{ runId: 'run-c', stepRunId: 'step-c' }],
        truncated: false,
      };
    },
    async admit(runId, stepRunId) {
      calls.push(`attempt:admit:${runId}:${stepRunId}`);
      return {
        status: stepRunId === 'step-b' ? 'existing' : 'created',
        receipt: {},
      };
    },
  };
  const coordinator = new ClusterWorkflowSchedulerCoordinator(
    scheduler,
    frontier,
    taskAttempts,
    {
      frontierPageSize: 2,
      frontierMaxPages: 2,
      taskAttemptPageSize: 2,
      taskAttemptMaxPages: 2,
    },
  );

  assert.deepEqual(await coordinator.scheduleOnce(), schedulerSummary());
  assert.deepEqual(coordinator.latestWorkflowSummary(), {
    frontierPages: 2,
    frontierScanned: 3,
    frontierAdvanced: 3,
    frontierTruncated: false,
    taskAttemptPages: 2,
    taskAttemptsScanned: 3,
    taskAttemptsCreated: 2,
    taskAttemptsExisting: 1,
    taskAttemptsTruncated: false,
  });
  assert.deepEqual(calls, [
    'schedule',
    'frontier:list:start',
    'frontier:advance:run-a',
    'frontier:advance:run-b',
    `frontier:list:${DIGEST_A}`,
    'frontier:advance:run-c',
    'attempt:list:start',
    'attempt:admit:run-a:step-a',
    'attempt:admit:run-b:step-b',
    'attempt:list:step-b',
    'attempt:admit:run-c:step-c',
  ]);
});

test('coalesces overlapping cycles and fails closed on a stale continuation', async () => {
  let release;
  let schedulerCalls = 0;
  const scheduled = new Promise((resolve) => {
    release = resolve;
  });
  const coordinator = new ClusterWorkflowSchedulerCoordinator(
    {
      async scheduleOnce() {
        schedulerCalls += 1;
        await scheduled;
        return schedulerSummary();
      },
    },
    {
      async listCandidates() {
        return {
          candidates: [{ runId: 'run-a' }],
          truncated: true,
          next: { admittedAtMs: 1, planDigest: DIGEST_B },
        };
      },
      async advance() {
        return { status: 'advanced' };
      },
    },
    {
      async listCandidates() {
        return { candidates: [], truncated: false };
      },
      async admit() {
        throw new Error('unexpected admission');
      },
    },
    {
      frontierPageSize: 1,
      frontierMaxPages: 2,
      taskAttemptPageSize: 1,
      taskAttemptMaxPages: 1,
    },
  );

  const first = coordinator.scheduleOnce();
  const second = coordinator.scheduleOnce();
  assert.equal(first, second);
  release();
  await assert.rejects(
    first,
    /frontier continuation did not advance/,
  );
  assert.equal(schedulerCalls, 1);
  assert.equal(coordinator.latestWorkflowSummary(), undefined);
});

test('rejects invalid bounds before touching the production scheduler', () => {
  assert.throws(
    () =>
      new ClusterWorkflowSchedulerCoordinator(
        { scheduleOnce() {} },
        { listCandidates() {}, advance() {} },
        { listCandidates() {}, admit() {} },
        {
          frontierPageSize: 65,
          frontierMaxPages: 1,
          taskAttemptPageSize: 1,
          taskAttemptMaxPages: 1,
        },
      ),
    /frontier page size must be between 1 and 64/,
  );
});
