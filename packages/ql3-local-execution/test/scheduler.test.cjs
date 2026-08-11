const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  LocalSchedulerCoordinator,
  LocalSchedulerLifecycle,
  LocalWorkflowSchedulerCoordinator,
} = require('../dist/scheduler');

function nextMinute(schedule, afterMs) {
  if (schedule.expression !== '* * * * *' || schedule.timezone !== 'UTC') {
    throw new Error('unsupported test schedule');
  }
  return Math.floor(afterMs / 60_000 + 1) * 60_000;
}

function candidate(overrides = {}) {
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
    stateVersion: 0,
    nextFireAtMs: 60_000,
    ...overrides,
  };
}

test('coordinates one bounded page and notifies only committed admissions', async () => {
  const committed = [];
  const notified = [];
  let sequence = 0;
  const coordinator = new LocalSchedulerCoordinator(
    {
      async listLocalScheduleCandidates(options) {
        assert.deepEqual(options, { observedAtMs: 61_000, limit: 4 });
        return {
          candidates: [candidate(), candidate({ triggerId: 'trigger-2' })],
          truncated: true,
        };
      },
      async commitLocalScheduleDecision(command) {
        committed.push(command);
        if (committed.length === 2) return { status: 'raced' };
        return {
          status: 'admitted',
          disposition: 'admit',
          runId: command.runId,
          attemptId: command.attemptId,
        };
      },
    },
    {
      pageSize: 4,
      misfireGraceMs: 5_000,
      clock: () => 61_000,
      nextOccurrence: nextMinute,
      createId: () =>
        `019f7500-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
      onAdmitted: (runId, attemptId) => notified.push([runId, attemptId]),
    },
  );

  assert.deepEqual(await coordinator.scheduleOnce(), {
    observedAtMs: 61_000,
    scanned: 2,
    initialized: 0,
    skipped: 0,
    admitted: 1,
    raced: 1,
    truncated: true,
  });
  assert.equal(committed.length, 2);
  assert.deepEqual(notified, [[committed[0].runId, committed[0].attemptId]]);
});

test('does not allocate Run identities for initialization or skip decisions', async () => {
  let allocations = 0;
  const commands = [];
  const coordinator = new LocalSchedulerCoordinator(
    {
      async listLocalScheduleCandidates() {
        return {
          candidates: [
            candidate({ nextFireAtMs: null, triggerUpdatedAtMs: 90_000 }),
            candidate({ triggerId: 'trigger-2', nextFireAtMs: 60_000 }),
          ],
          truncated: false,
        };
      },
      async commitLocalScheduleDecision(command) {
        commands.push(command);
        return {
          status: 'advanced',
          disposition: command.decision.disposition,
        };
      },
    },
    {
      clock: () => 100_000,
      misfireGraceMs: 5_000,
      nextOccurrence: nextMinute,
      createId() {
        allocations += 1;
        return 'unused';
      },
    },
  );
  const summary = await coordinator.scheduleOnce();
  assert.equal(summary.initialized, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(allocations, 0);
  assert.equal(
    commands.every((command) => command.runId === undefined),
    true,
  );
});

test('reuses one scheduler cycle for cancellation, frontier, Task admission and dispatch', async () => {
  const calls = [];
  let dispatches = 0;
  const schedulerSummary = {
    observedAtMs: 10,
    scanned: 0,
    initialized: 0,
    skipped: 0,
    admitted: 0,
    raced: 0,
    truncated: false,
  };
  const coordinator = new LocalWorkflowSchedulerCoordinator(
    {
      async scheduleOnce() {
        calls.push('schedule');
        return schedulerSummary;
      },
    },
    {
      async convergePage(command) {
        calls.push(`cancel:${command.limit}`);
        return {
          scanned: 0,
          settledRuns: 0,
          settledAttempts: 0,
          blocked: 0,
          hasMore: false,
        };
      },
    },
    {
      async listCandidates(command) {
        calls.push(`frontier-list:${command.limit}`);
        return {
          candidates: [
            {
              runId: 'workflow-run',
              planDigest: 'a'.repeat(64),
              admittedAtMs: 1,
            },
          ],
          truncated: false,
        };
      },
      async advance(runId) {
        calls.push(`frontier-advance:${runId}`);
        return {};
      },
    },
    {
      async listCandidates(command) {
        calls.push(`task-list:${command.limit}`);
        return {
          candidates: [
            {
              runId: 'workflow-run',
              stepRunId: 'workflow-step',
              readyAtMs: 2,
              planDigest: 'a'.repeat(64),
            },
          ],
          truncated: false,
        };
      },
      async admit(runId, stepRunId) {
        calls.push(`task-admit:${runId}:${stepRunId}`);
        return { status: 'created', receipt: {} };
      },
    },
    {
      async dispatchOnce() {
        dispatches += 1;
        calls.push(`dispatch:${dispatches}`);
        const stats = {
          pages: 1,
          candidatesScanned: dispatches === 1 ? 1 : 0,
          plansUnavailable: 0,
          activationRaces: 0,
        };
        return dispatches === 1
          ? {
              status: 'activated',
              runId: 'workflow-run',
              attemptId: 'workflow-attempt',
              stats,
              truncated: false,
            }
          : {
              status: 'idle',
              reason: 'no_candidates',
              stats,
              truncated: false,
            };
      },
    },
    {
      cancellationPageSize: 1,
      cancellationMaxPages: 1,
      frontierPageSize: 1,
      frontierMaxPages: 1,
      taskAttemptPageSize: 1,
      taskAttemptMaxPages: 1,
      maxDispatches: 2,
    },
  );

  assert.deepEqual(await coordinator.scheduleOnce(), schedulerSummary);
  assert.deepEqual(calls, [
    'cancel:1',
    'schedule',
    'frontier-list:1',
    'frontier-advance:workflow-run',
    'task-list:1',
    'task-admit:workflow-run:workflow-step',
    'dispatch:1',
    'dispatch:2',
  ]);
  assert.deepEqual(coordinator.latestWorkflowSummary(), {
    cancellation: {
      pages: 1,
      scanned: 0,
      settledRuns: 0,
      settledAttempts: 0,
      blocked: 0,
      hasMore: false,
      remaining: false,
      stopReason: 'complete',
    },
    frontierPages: 1,
    frontierScanned: 1,
    frontierAdvanced: 1,
    frontierTruncated: false,
    taskAttemptPages: 1,
    taskAttemptsScanned: 1,
    taskAttemptsCreated: 1,
    taskAttemptsExisting: 0,
    taskAttemptsTruncated: false,
    dispatches: 2,
    activated: 1,
    activationFailed: 0,
    dispatchIdle: true,
  });
});

test('lifecycle coalesces cycles and stops without leaving a scheduler timer', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const summary = {
    observedAtMs: 1,
    scanned: 0,
    initialized: 0,
    skipped: 0,
    admitted: 0,
    raced: 0,
    truncated: false,
  };
  const lifecycle = new LocalSchedulerLifecycle(
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
  const second = lifecycle.runOnce();
  assert.equal(first, second);
  const stopping = lifecycle.stopAndDrain();
  release();
  assert.deepEqual(await first, summary);
  assert.deepEqual(await stopping, { status: 'stopped' });
  assert.equal(calls, 1);
  await assert.rejects(lifecycle.runOnce(), /stopping/);
});

test('lifecycle bounds shutdown when a schedule transaction does not settle', async () => {
  const lifecycle = new LocalSchedulerLifecycle(
    { scheduleOnce: () => new Promise(() => {}) },
    { intervalMs: 250, stopTimeoutMs: 100 },
  );
  void lifecycle.runOnce();
  assert.deepEqual(await lifecycle.stopAndDrain(), { status: 'timed_out' });
});

test('lifecycle shutdown absorbs an already isolated cycle failure', async () => {
  let rejectCycle;
  const lifecycle = new LocalSchedulerLifecycle(
    {
      scheduleOnce: () =>
        new Promise((resolve, reject) => {
          rejectCycle = reject;
        }),
    },
    { intervalMs: 250, stopTimeoutMs: 1_000 },
  );
  const cycle = lifecycle.runOnce();
  const stopping = lifecycle.stopAndDrain();
  rejectCycle(new Error('schedule storage unavailable'));
  await assert.rejects(cycle, /schedule storage unavailable/);
  assert.deepEqual(await stopping, { status: 'stopped' });
});

test('lifecycle runs an unrefed non-overlapping cadence and isolates diagnostics', async () => {
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const diagnostics = [];
  const lifecycle = new LocalSchedulerLifecycle(
    {
      async scheduleOnce() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        calls += 1;
        if (calls === 1) throw new Error('temporary schedule failure');
        return {
          observedAtMs: calls,
          scanned: 0,
          initialized: 0,
          skipped: 0,
          admitted: 0,
          raced: 0,
          truncated: false,
        };
      },
    },
    {
      intervalMs: 250,
      stopTimeoutMs: 1_000,
      onDiagnostic(error, summary) {
        diagnostics.push({ error, summary });
        if (error === undefined) throw new Error('diagnostic sink unavailable');
      },
    },
  );

  lifecycle.start();
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(await lifecycle.stopAndDrain(), { status: 'stopped' });
  assert.ok(calls >= 2);
  assert.equal(maximumActive, 1);
  assert.ok(diagnostics.some(({ error }) => error instanceof Error));
  assert.ok(diagnostics.some(({ summary }) => summary?.observedAtMs >= 2));
});
